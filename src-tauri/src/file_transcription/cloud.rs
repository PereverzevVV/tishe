//! Cloud speech-to-text through the OpenAI-compatible
//! `POST {base_url}/audio/transcriptions` endpoint (OpenAI, Groq, and most
//! self-hosted whisper servers speak it).

use super::{CloudSttConfig, Segment};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

#[derive(Deserialize)]
struct VerboseSegment {
    start: f64,
    #[serde(default)]
    end: Option<f64>,
    text: String,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
    #[serde(default)]
    segments: Option<Vec<VerboseSegment>>,
}

/// Whisper-style models return per-segment timestamps with `verbose_json`;
/// the gpt-4o transcribe family only accepts `json`/`text`.
pub fn supports_verbose_json(model: &str) -> bool {
    model.to_lowercase().contains("whisper")
}

/// Longest part a model accepts, in seconds, when the provider enforces a
/// duration cap stricter than the upload size limit.
pub fn model_max_part_secs(model: &str) -> Option<usize> {
    // gpt-4o-transcribe / gpt-4o-mini-transcribe reject audio over ~1400 s.
    if model.to_lowercase().starts_with("gpt-4o") {
        Some(23 * 60)
    } else {
        None
    }
}

/// Transcribe one encoded part. Segment start times are relative to the part.
pub async fn transcribe_part(config: &CloudSttConfig, mp3: &Path) -> Result<Vec<Segment>> {
    let bytes = tokio::fs::read(mp3)
        .await
        .context("failed to read encoded part")?;
    let url = format!(
        "{}/audio/transcriptions",
        config.base_url.trim().trim_end_matches('/')
    );
    let verbose = supports_verbose_json(&config.model);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20 * 60))
        .build()?;

    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut form = reqwest::multipart::Form::new()
            .part(
                "file",
                reqwest::multipart::Part::bytes(bytes.clone())
                    .file_name("part.mp3")
                    .mime_str("audio/mpeg")?,
            )
            .text("model", config.model.trim().to_string())
            .text(
                "response_format",
                if verbose { "verbose_json" } else { "json" },
            );
        if let Some(lang) = config.language.as_deref().map(str::trim) {
            if !lang.is_empty() && lang != "auto" {
                form = form.text("language", lang.to_string());
            }
        }
        if let Some(prompt) = config.prompt.as_deref().map(str::trim) {
            if !prompt.is_empty() {
                form = form.text("prompt", prompt.to_string());
            }
        }

        let result = client
            .post(&url)
            .bearer_auth(config.api_key.trim())
            .multipart(form)
            .send()
            .await;

        let retryable = match result {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let body: TranscriptionResponse = response
                        .json()
                        .await
                        .context("unexpected response from the transcription API")?;
                    return Ok(into_segments(body));
                }
                let text = response.text().await.unwrap_or_default();
                let message = format!("transcription API returned {status}: {}", text.trim());
                if status.as_u16() == 429 || status.is_server_error() {
                    message
                } else {
                    bail!(message);
                }
            }
            Err(e) => format!("request to the transcription API failed: {e}"),
        };

        if attempt >= 3 {
            bail!(retryable);
        }
        log::warn!("{retryable}; retrying (attempt {attempt})");
        tokio::time::sleep(Duration::from_secs(5 * attempt)).await;
    }
}

fn into_segments(body: TranscriptionResponse) -> Vec<Segment> {
    match body.segments {
        Some(segments) if !segments.is_empty() => segments
            .into_iter()
            .map(|s| Segment {
                start_secs: s.start,
                end_secs: s.end,
                text: s.text.trim().to_string(),
                timed: true,
                speaker: None,
            })
            .filter(|s| !s.text.is_empty())
            .collect(),
        _ => vec![Segment {
            start_secs: 0.0,
            end_secs: None,
            text: body.text.trim().to_string(),
            timed: false,
            speaker: None,
        }],
    }
}
