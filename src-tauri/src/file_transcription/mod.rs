//! Transcribe an existing audio/video file into a Markdown or Word document.
//!
//! Pipeline: ffmpeg pulls the audio track into raw 16 kHz PCM → the audio is
//! split into equal parts no longer than the chosen maximum (29 min by
//! default) → each part goes through the local model or a cloud
//! speech-to-text API → optionally an LLM cleans each part up → everything is
//! written as one document. When speakers are requested, diarization runs
//! over the whole extracted file right after extraction, and its turns guide
//! where the local model's segments are cut.

mod cloud;
mod debug;
pub mod diarize;
mod document;
pub mod events;
pub(crate) mod language;
mod media;
mod numbered;
mod split;

use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;
use anyhow::{anyhow, bail, Result};
use document::{DocumentMeta, DocumentOptions, JobTimes, PartTranscript};
use events::{EventScriptOptions, EventSink};
use log::{info, warn};
use media::{PcmFile, SAMPLE_RATE};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

/// Error text used to recognise a user cancellation.
const CANCELLED: &str = "cancelled";
/// LLM input chunk size for external providers (Ollama, LM Studio, cloud):
/// small enough that models return the whole chunk instead of summarising it.
/// The built-in local LLM takes smaller chunks instead
/// (`model_settings::LLM_CHUNK_CHARS`, 3000 by default, per model in the ⚙
/// window): small models stay more faithful on short inputs, and progress
/// moves more often on a slow CPU.
const EXTERNAL_LLM_CHUNK_CHARS: usize = 6_000;
pub const PROGRESS_EVENT: &str = "file-transcription-progress";

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// Set by the UI while a queue of files is being processed, so the local
/// model stays loaded between files instead of being released after each one.
static QUEUE_HOLD: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Markdown,
    Docx,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SttEngine {
    Local,
    Cloud,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CloudSttConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// ISO-639-1 code, or empty/"auto" to let the API detect it.
    pub language: Option<String>,
    /// Optional vocabulary/style hint passed to the API.
    pub prompt: Option<String>,
}

/// Document captions, supplied by the UI so they follow the app language.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DocumentLabels {
    pub title: String,
    pub source_file: String,
    pub duration: String,
    pub parts: String,
    pub engine: String,
    pub llm: String,
    pub created: String,
    pub part: String,
    pub raw_transcript: String,
    /// "Speaker", numbered in the document as "Speaker 1", "Speaker 2"…
    pub speaker: String,
    /// Heading of the closing "processing notes" section.
    pub notes: String,
    /// Captions of the lines in the notes section.
    pub notes_total: String,
    pub notes_extracting: String,
    pub notes_diarizing: String,
    pub notes_transcribing: String,
    pub notes_llm: String,
    pub notes_warnings: String,
    /// Shown after `notes_warnings` when there were none.
    pub notes_none: String,
    /// "Text language", followed by the codes found ("ru", "en").
    pub notes_language: String,
    /// How the built-in LLM is named in the document ("Gemma 4 E4B, on this
    /// computer"); empty falls back to "provider / model id".
    #[serde(default)]
    pub llm_local: String,
    /// Warning texts for the document and the window.
    #[serde(default)]
    pub warnings: WarningLabels,
}

/// Warning templates in the app language. The backend fills in `{part}`,
/// `{fragment}`, `{count}`, `{kept}`, `{total}`, `{reasons}` and `{error}`.
/// The defaults are the English texts, for callers that send none.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct WarningLabels {
    /// Speakers were requested, but the cloud model returns no timestamps.
    pub no_timestamps_model: String,
    /// `{part}`: the cloud service returned no timestamps for this part.
    pub no_timestamps_part: String,
    /// `{part}`, `{fragment}`: the LLM answered with nothing.
    pub llm_empty: String,
    /// `{part}`, `{fragment}`, `{error}`: the LLM request failed.
    pub llm_error: String,
    /// `{part}`, `{fragment}`, `{count}`: lines whose dropped numbers were put back.
    pub numbers_back: String,
    /// `{part}`, `{fragment}`: the answer lost the numbered lines altogether.
    pub lines_lost: String,
    /// `{part}`, `{fragment}`, `{kept}`, `{total}`, `{reasons}`: some lines
    /// kept their raw text.
    pub lines_kept: String,
    /// Why a line kept its raw text, joined into `{reasons}`.
    pub kept_missing: String,
    pub kept_duplicate: String,
    pub kept_empty: String,
    pub kept_too_long: String,
    pub kept_translated: String,
    pub kept_too_short: String,
    pub kept_cut_off: String,
}

impl Default for WarningLabels {
    fn default() -> Self {
        Self {
            no_timestamps_model: "speakers were not marked: this speech model returns no timestamps; use a whisper model or local recognition".into(),
            no_timestamps_part: "part {part}: the speech service returned no timestamps, so speakers could not be marked".into(),
            llm_empty: "part {part}, fragment {fragment}: the LLM returned an empty answer, raw text kept".into(),
            llm_error: "part {part}, fragment {fragment}: LLM error, raw text kept ({error})".into(),
            numbers_back: "part {part}, fragment {fragment}: numbers put back in {count} lines (the LLM wrote them as words or dropped them)".into(),
            lines_lost: "part {part}, fragment {fragment}: the LLM answer did not keep the numbered lines, raw text kept".into(),
            lines_kept: "part {part}, fragment {fragment}: {kept} of {total} lines kept their raw text ({reasons})".into(),
            kept_missing: "missing".into(),
            kept_duplicate: "duplicate".into(),
            kept_empty: "empty".into(),
            kept_too_long: "too long".into(),
            kept_translated: "translated".into(),
            kept_too_short: "too short".into(),
            kept_cut_off: "cut off".into(),
        }
    }
}

impl WarningLabels {
    /// The reason's name in the app language.
    fn kept(&self, why: numbered::Kept) -> &str {
        use numbered::Kept;
        match why {
            Kept::Missing => &self.kept_missing,
            Kept::Duplicate => &self.kept_duplicate,
            Kept::Empty => &self.kept_empty,
            Kept::TooLong => &self.kept_too_long,
            Kept::Translated => &self.kept_translated,
            Kept::TooShort => &self.kept_too_short,
            Kept::CutOff => &self.kept_cut_off,
        }
    }
}

/// A warning template with its `{name}` placeholders filled in.
fn fill(template: &str, values: &[(&str, &dyn std::fmt::Display)]) -> String {
    values
        .iter()
        .fold(template.to_string(), |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), &value.to_string())
        })
}

/// Split the transcript by speaker with the built-in models.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DiarizationRequest {
    /// Speaker (fingerprint) model id from `diarization_list_models`.
    pub model_id: String,
    /// Exact number of people, when known; `None` lets it be estimated.
    pub num_speakers: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTranscriptionRequest {
    pub input_path: String,
    pub output_path: String,
    pub format: OutputFormat,
    pub max_part_minutes: u32,
    pub engine: SttEngine,
    pub cloud: Option<CloudSttConfig>,
    /// Run each part through the post-processing LLM configured in settings.
    pub llm_enabled: bool,
    /// The user's own LLM instruction; `None` uses the built-in one written
    /// in the language of each part's text.
    pub llm_prompt: Option<String>,
    /// Remove hesitation sounds ("э-э", "uh") from the main text (Russian and
    /// English); the raw section keeps them.
    pub remove_fillers: bool,
    pub include_raw: bool,
    pub timestamps: bool,
    /// Close the document with how long each stage took and the warnings.
    pub include_notes: bool,
    /// Save the text after every step in a "<document>.debug" folder.
    pub save_debug: bool,
    pub labels: DocumentLabels,
    /// Optional program told about the job's progress (see events).
    pub events: Option<EventScriptOptions>,
    /// Split the transcript by speaker.
    pub diarization: Option<DiarizationRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FileTranscriptionStage {
    Extracting,
    Diarizing,
    Splitting,
    Transcribing,
    PostProcessing,
    Writing,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTranscriptionProgress {
    pub stage: FileTranscriptionStage,
    /// 1-based part currently being worked on (0 before splitting).
    pub part: u32,
    pub total_parts: u32,
    /// Overall progress, 0..1.
    pub fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTranscriptionResult {
    pub output_path: String,
    pub duration_secs: f64,
    pub parts: u32,
    pub characters: u32,
    /// Non-fatal problems (e.g. an LLM chunk that fell back to the raw text).
    pub warnings: Vec<String>,
}

/// One recognized stretch of speech. Times are relative to its part.
pub struct Segment {
    pub start_secs: f64,
    /// End time, when the recognizer reports one.
    pub end_secs: Option<f64>,
    pub text: String,
    /// Whether `start_secs` is a real timestamp from the recognizer.
    pub timed: bool,
    /// 0-based speaker, when diarization ran.
    pub speaker: Option<u32>,
}

// How the progress bar is split between stages: rough seconds of work per
// minute of audio on a laptop CPU (Ryzen 5 7530U, 2026-10-09: four 24–28 min
// meetings and a 64 min interview, DOCUMENTATION §5.23). Every stage grows
// with the length of the audio, so only their ratio matters, and the bar then
// moves about evenly in time. Fixed shares (13 % for the LLM) left the bar at
// 87–96 % for the last 10 minutes of a job.
/// ffmpeg pulling out the audio track: 2–5 s per file.
const SECS_PER_MIN_EXTRACT: f64 = 0.15;
/// Speakers over the whole file: 3.9–4.8 s per minute.
const SECS_PER_MIN_DIARIZE: f64 = 4.5;
/// Fast local recognizers (catalog speed ≥ 0.8: GigaAM, Parakeet): 2.4–3.6.
const SECS_PER_MIN_ASR_FAST: f64 = 3.0;
const ASR_FAST_SPEED: f64 = 0.8;
/// Added per unit of catalog speed below 0.8: Qwen3-ASR 1.7B (0.38) took
/// 24–27 s per minute.
const SECS_PER_MIN_ASR_PER_SPEED: f64 = 52.0;
/// A local model without a speed score (estimate).
const SECS_PER_MIN_ASR_UNKNOWN: f64 = 10.0;
/// A cloud speech service, upload included (estimate).
const SECS_PER_MIN_ASR_CLOUD: f64 = 3.0;
/// An LLM on this computer: Gemma 4 E4B QAT took 22–27 s per minute.
const SECS_PER_MIN_LLM_LOCAL: f64 = 25.0;
/// A cloud LLM (estimate).
const SECS_PER_MIN_LLM_CLOUD: f64 = 3.0;

/// Share of the progress bar each stage takes; the shares add up to 1, and a
/// stage that doesn't run takes none.
#[derive(Debug, Clone, Copy, PartialEq)]
struct StageWeights {
    extract: f64,
    diarize: f64,
    transcribe: f64,
    llm: f64,
}

impl StageWeights {
    /// From the expected seconds of work per minute of audio of each stage.
    fn new(diarize: bool, asr_secs_per_min: f64, llm_secs_per_min: Option<f64>) -> Self {
        let diarize = if diarize { SECS_PER_MIN_DIARIZE } else { 0.0 };
        let llm = llm_secs_per_min.unwrap_or(0.0);
        let total = SECS_PER_MIN_EXTRACT + diarize + asr_secs_per_min + llm;
        Self {
            extract: SECS_PER_MIN_EXTRACT / total,
            diarize: diarize / total,
            transcribe: asr_secs_per_min / total,
            llm: llm / total,
        }
    }

    /// Where the per-part work starts: after extraction and speakers.
    fn parts_start(&self) -> f64 {
        self.extract + self.diarize
    }

    /// Overall progress inside part `part_idx` of `total_parts`: `within` of
    /// its recognition, or of its LLM edit when `llm_phase` is set.
    fn part_fraction(
        &self,
        total_parts: u32,
        part_idx: usize,
        within: f64,
        llm_phase: bool,
    ) -> f64 {
        let n = total_parts.max(1) as f64;
        let base = self.parts_start() + (self.transcribe + self.llm) / n * part_idx as f64;
        if llm_phase {
            base + self.transcribe / n + self.llm / n * within
        } else {
            base + self.transcribe / n * within
        }
    }
}

/// Expected recognition time of a local model from its catalog speed score
/// (0–1, higher is faster).
fn local_asr_secs_per_min(speed_score: Option<f32>) -> f64 {
    match speed_score {
        Some(speed) if speed > 0.0 => {
            SECS_PER_MIN_ASR_FAST
                + (ASR_FAST_SPEED - speed as f64).max(0.0) * SECS_PER_MIN_ASR_PER_SPEED
        }
        _ => SECS_PER_MIN_ASR_UNKNOWN,
    }
}

/// Expected LLM time: the built-in one, or any server on this computer, runs
/// on the CPU; a cloud service is far faster.
fn llm_secs_per_min(llm: &LlmTarget) -> f64 {
    let host = host_of(&llm.provider.base_url);
    let on_this_computer = llm.provider.id == crate::local_llm::LOCAL_PROVIDER_ID
        || matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    if on_this_computer {
        SECS_PER_MIN_LLM_LOCAL
    } else {
        SECS_PER_MIN_LLM_CLOUD
    }
}

struct Progress<'a> {
    app: &'a AppHandle,
    total_parts: u32,
    weights: StageWeights,
    events: EventSink,
}

impl Progress<'_> {
    fn emit(&self, stage: FileTranscriptionStage, part: u32, fraction: f64) {
        let fraction = fraction.clamp(0.0, 1.0);
        self.events
            .progress(stage.clone(), part, self.total_parts, fraction);
        let _ = self.app.emit(
            PROGRESS_EVENT,
            FileTranscriptionProgress {
                stage,
                part,
                total_parts: self.total_parts,
                fraction,
            },
        );
    }

    /// Progress within the per-part work (transcription + optional LLM).
    fn part_fraction(&self, part_idx: usize, within: f64, llm_phase: bool) -> f64 {
        self.weights
            .part_fraction(self.total_parts, part_idx, within, llm_phase)
    }
}

/// Temp directory removed on drop, whatever way the job ends.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("tishe-file-{}-{}", std::process::id(), stamp));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Keeps a local model loaded for the duration of the job even when the
/// "unload immediately" setting is on, so it isn't reloaded per segment.
struct HoldModel(Arc<TranscriptionManager>);

impl Drop for HoldModel {
    fn drop(&mut self) {
        if QUEUE_HOLD.load(Ordering::SeqCst) {
            return;
        }
        self.0.set_batch_hold(false);
        self.0.maybe_unload_immediately("file transcription");
    }
}

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn check_cancel() -> Result<()> {
    if CANCEL.load(Ordering::Relaxed) {
        bail!(CANCELLED);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_media_file(
    app: AppHandle,
    request: FileTranscriptionRequest,
) -> Result<FileTranscriptionResult, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A file transcription is already running".to_string());
    }
    let _running = RunningGuard;
    CANCEL.store(false, Ordering::SeqCst);

    info!(
        "File transcription started: engine={:?}, format={:?}, max_part={}min, llm={}",
        request.engine, request.format, request.max_part_minutes, request.llm_enabled
    );
    let events = EventSink::new(request.events.as_ref(), &request.input_path);
    events.started();
    match run(&app, &request, &events).await {
        Ok(result) => {
            info!(
                "File transcription finished: {} parts, {} chars",
                result.parts, result.characters
            );
            events.finished(&result);
            Ok(result)
        }
        Err(e) if e.to_string() == CANCELLED => {
            events.cancelled();
            Err(CANCELLED.to_string())
        }
        Err(e) => {
            warn!("File transcription failed: {e:#}");
            events.failed(&format!("{e:#}"));
            Err(format!("{e:#}"))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn cancel_media_file_transcription() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Keep the local model loaded across a queue of files. Releasing the hold
/// applies the "unload immediately" setting once the last job is done.
#[tauri::command]
#[specta::specta]
pub fn set_file_queue_hold(app: AppHandle, hold: bool) {
    QUEUE_HOLD.store(hold, Ordering::SeqCst);
    // Tishe: the tray shows the «working» icon and locks «Модель ▸».
    crate::tray::set_file_queue_running(&app, hold);
    if let Some(llm) = app.try_state::<Arc<crate::local_llm::LocalLlmManager>>() {
        llm.set_hold(hold);
    }
    if !hold && !RUNNING.load(Ordering::SeqCst) {
        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.set_batch_hold(false);
        tm.maybe_unload_immediately("file transcription queue");
    }
}

/// Return `path`, or `name (2).ext`, `name (3).ext`… if it already exists, so
/// queued transcripts never overwrite an earlier document.
#[tauri::command]
#[specta::specta]
pub fn unique_output_path(path: String) -> String {
    let candidate = PathBuf::from(&path);
    if !candidate.exists() {
        return path;
    }
    let dir = candidate
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let stem = candidate
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = candidate
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(path)
}

#[tauri::command]
#[specta::specta]
pub fn is_ffmpeg_available() -> bool {
    media::find_ffmpeg().is_ok()
}

/// A file transcription queue (or a single file) is running: quitting from
/// the tray asks first, closing the window says the work goes on (Tishe).
pub fn queue_running() -> bool {
    QUEUE_HOLD.load(Ordering::SeqCst) || RUNNING.load(Ordering::SeqCst)
}

/// The transcription line of the tray tooltip, composed by the window
/// («Расшифровка: файл 2 из 3 · 47 %»); `None` returns the tooltip to idle.
#[tauri::command]
#[specta::specta]
pub fn set_file_queue_tooltip(app: AppHandle, text: Option<String>) {
    crate::tray::set_file_tooltip(&app, text);
}

/// Which of the given paths exist: results kept between runs show «Файл не
/// найден» for a document that was moved or deleted (CF7).
#[tauri::command]
#[specta::specta]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).exists())
        .collect()
}

/// Open a finished transcript with the system's default app, or show it in
/// the file manager when `reveal` is set.
#[tauri::command]
#[specta::specta]
pub fn open_transcript_file(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let result = if reveal {
        app.opener().reveal_item_in_dir(&path)
    } else {
        app.opener().open_path(path, None::<String>)
    };
    result.map_err(|e| format!("Failed to open the file: {e}"))
}

async fn run(
    app: &AppHandle,
    req: &FileTranscriptionRequest,
    events: &EventSink,
) -> Result<FileTranscriptionResult> {
    let job_started = Instant::now();
    let mut times = JobTimes::default();
    let input = PathBuf::from(&req.input_path);
    let output = PathBuf::from(&req.output_path);
    if req.output_path.trim().is_empty() {
        bail!("no output file selected");
    }
    let debug = debug::DebugDump::new(&output, req.save_debug);
    let cloud_config = match req.engine {
        SttEngine::Cloud => {
            let c = req
                .cloud
                .clone()
                .ok_or_else(|| anyhow!("cloud transcription is selected but not configured"))?;
            if c.base_url.trim().is_empty() || c.model.trim().is_empty() {
                bail!("cloud transcription needs an API URL and a model");
            }
            if c.api_key.trim().is_empty() {
                bail!("cloud transcription needs an API key");
            }
            Some(c)
        }
        SttEngine::Local => None,
    };
    let settings = get_settings(app);
    let mut warnings = Vec::new();
    // Speakers are matched to text by time, so a cloud model without
    // timestamps can't carry them: skip the work and say so once.
    let untimed_cloud = cloud_config
        .as_ref()
        .is_some_and(|c| !cloud::supports_verbose_json(&c.model));
    let diar_models = match &req.diarization {
        Some(_) if untimed_cloud => {
            push_warning(
                &mut warnings,
                req.labels.warnings.no_timestamps_model.clone(),
            );
            None
        }
        Some(d) => Some(
            app.state::<Arc<diarize::models::DiarizationModels>>()
                .paths(&d.model_id)?,
        ),
        None => None,
    };
    let mut llm = if req.llm_enabled {
        let mut target = resolve_llm(&settings)?;
        if target.provider.id == crate::local_llm::LOCAL_PROVIDER_ID {
            target.chunk_chars = crate::model_settings::llm_chunk_chars(app, &target.model);
        }
        Some(target)
    } else {
        None
    };

    let ffmpeg = media::find_ffmpeg()?;
    let probe = {
        let (ffmpeg, input) = (ffmpeg.clone(), input.clone());
        tauri::async_runtime::spawn_blocking(move || media::probe(&ffmpeg, &input)).await??
    };

    // Kick off the local model load now so it overlaps with extraction.
    let tm = app.state::<Arc<TranscriptionManager>>().inner().clone();
    let _hold = if req.engine == SttEngine::Local {
        if settings.selected_model.is_empty() {
            bail!("no local model is selected; pick one in the Models section");
        }
        tm.set_batch_hold(true);
        tm.initiate_model_load();
        Some(HoldModel(tm.clone()))
    } else {
        None
    };

    let asr_secs_per_min = match &cloud_config {
        Some(_) => SECS_PER_MIN_ASR_CLOUD,
        None => local_asr_secs_per_min(
            app.state::<Arc<crate::managers::model::ModelManager>>()
                .get_model_info(&settings.selected_model)
                .map(|m| m.speed_score),
        ),
    };
    let weights = StageWeights::new(
        diar_models.is_some(),
        asr_secs_per_min,
        llm.as_ref().map(llm_secs_per_min),
    );
    let mut progress = Progress {
        app,
        total_parts: 0,
        weights,
        events: events.clone(),
    };

    // 1. Extract audio.
    let stage_started = Instant::now();
    let temp = TempDir::new()?;
    let pcm_path = temp.0.join("audio.pcm");
    progress.emit(FileTranscriptionStage::Extracting, 0, 0.0);
    {
        let (ffmpeg, input, pcm_path, app, events) = (
            ffmpeg.clone(),
            input.clone(),
            pcm_path.clone(),
            app.clone(),
            events.clone(),
        );
        let duration = probe.duration_secs;
        tauri::async_runtime::spawn_blocking(move || {
            let reporter = Progress {
                app: &app,
                total_parts: 0,
                weights,
                events,
            };
            media::extract_pcm(&ffmpeg, &input, &pcm_path, &CANCEL, |pos| {
                if let Some(d) = duration.filter(|d| *d > 0.0) {
                    reporter.emit(
                        FileTranscriptionStage::Extracting,
                        0,
                        weights.extract * pos / d,
                    );
                }
            })
        })
        .await??;
    }
    check_cancel()?;
    times.extract_secs = stage_started.elapsed().as_secs_f64();

    let mut pcm = PcmFile::open(&pcm_path)?;
    if pcm.len() < SAMPLE_RATE / 2 {
        bail!("the audio track is empty");
    }
    let duration_secs = pcm.len() as f64 / SAMPLE_RATE as f64;

    // 2. Who speaks when, over the whole file.
    let turns = match (&diar_models, &req.diarization) {
        (Some(paths), Some(d)) => {
            let stage_started = Instant::now();
            progress.emit(FileTranscriptionStage::Diarizing, 0, weights.extract);
            let turns = {
                let (seg, emb, pcm_path) = (
                    paths.segmentation.clone(),
                    paths.embedding.clone(),
                    pcm_path.clone(),
                );
                let opts = diarize::DiarizeOptions {
                    num_speakers: d.num_speakers.filter(|&n| n > 0),
                    threshold: diarize::DEFAULT_THRESHOLD,
                };
                let (app, events) = (app.clone(), events.clone());
                tauri::async_runtime::spawn_blocking(move || {
                    let reporter = Progress {
                        app: &app,
                        total_parts: 0,
                        weights,
                        events,
                    };
                    let mut pcm = PcmFile::open(&pcm_path)?;
                    diarize::diarize(&mut pcm, &seg, &emb, &opts, &CANCEL, |f| {
                        reporter.emit(
                            FileTranscriptionStage::Diarizing,
                            0,
                            weights.extract + weights.diarize * f,
                        )
                    })
                })
                .await??
            };
            times.diarize_secs = Some(stage_started.elapsed().as_secs_f64());
            let speakers = turns.iter().map(|t| t.speaker).max().map_or(0, |m| m + 1);
            info!("Diarization: {} turns, {speakers} speaker(s)", turns.len());
            Some(turns)
        }
        _ => None,
    };
    check_cancel()?;

    // 3. Plan parts.
    progress.emit(FileTranscriptionStage::Splitting, 0, weights.parts_start());
    let mut max_part_secs = (req.max_part_minutes.clamp(2, 180) as usize) * 60;
    if let Some(cap) = cloud_config
        .as_ref()
        .and_then(|c| cloud::model_max_part_secs(&c.model))
    {
        max_part_secs = max_part_secs.min(cap);
    }
    let parts = split::plan_parts(&mut pcm, max_part_secs * SAMPLE_RATE)?;
    progress.total_parts = parts.len() as u32;
    info!(
        "Audio is {:.0}s long; split into {} part(s)",
        duration_secs,
        parts.len()
    );

    // 4. Transcribe (and optionally post-process) each part.
    let mut transcripts = Vec::with_capacity(parts.len());
    // Segment length for local recognition: the model's ⚙ parameters.
    let segments = {
        let max = crate::model_settings::asr(app, &settings.selected_model)
            .segment_max_secs
            .unwrap_or(crate::model_settings::ASR_SEGMENT_MAX_SECS);
        split::segment_bounds(max)
    };
    // Used only when a part has too little text to tell its language.
    let language_hint = match &cloud_config {
        Some(c) => c.language.clone(),
        None => Some(settings.selected_language.clone()),
    };
    // Languages found, in order, for the notes section.
    let mut languages: Vec<&'static str> = Vec::new();
    // Keeps the built-in local LLM marked in use until the job ends.
    let mut local_llm_use = None;
    for (idx, &(start, end)) in parts.iter().enumerate() {
        check_cancel()?;
        let part_no = idx as u32 + 1;
        let part_start = start as f64 / SAMPLE_RATE as f64;
        progress.emit(
            FileTranscriptionStage::Transcribing,
            part_no,
            progress.part_fraction(idx, 0.0, false),
        );

        let part_end = end as f64 / SAMPLE_RATE as f64;
        let stage_started = Instant::now();
        let mut segments = match &cloud_config {
            None => {
                let samples = pcm.read(start, end)?;
                // Turns overlapping this part, as sample ranges within it.
                let part_turns = turns.as_ref().map(|turns| {
                    turns
                        .iter()
                        .filter(|t| t.end_secs > part_start && t.start_secs < part_end)
                        .map(|t| {
                            let rel = |secs: f64| {
                                ((secs - part_start).max(0.0) * SAMPLE_RATE as f64) as usize
                            };
                            (rel(t.start_secs), rel(t.end_secs), t.speaker)
                        })
                        .collect::<Vec<_>>()
                });
                transcribe_local(&tm, samples, part_turns.as_deref(), segments, |within| {
                    progress.emit(
                        FileTranscriptionStage::Transcribing,
                        part_no,
                        progress.part_fraction(idx, within, false),
                    )
                })
                .await?
            }
            Some(config) => {
                let mp3 = temp.0.join(format!("part-{part_no}.mp3"));
                {
                    let (ffmpeg, pcm_path, mp3) = (ffmpeg.clone(), pcm_path.clone(), mp3.clone());
                    tauri::async_runtime::spawn_blocking(move || {
                        media::encode_mp3_range(&ffmpeg, &pcm_path, start, end, &mp3)
                    })
                    .await??;
                }
                check_cancel()?;
                let segments = cancellable(cloud::transcribe_part(config, &mp3)).await?;
                let _ = std::fs::remove_file(&mp3);
                segments
            }
        };
        if let (Some(turns), Some(_)) = (&turns, &cloud_config) {
            if !assign_speakers(&mut segments, turns, part_start) {
                push_warning(
                    &mut warnings,
                    fill(
                        &req.labels.warnings.no_timestamps_part,
                        &[("part", &part_no)],
                    ),
                );
            }
        }
        let mut part_times = document::PartTimes {
            transcribe_secs: stage_started.elapsed().as_secs_f64(),
            llm_secs: None,
        };

        let raw = document::paragraphs_from_segments(&segments, part_start);
        // Rules follow the language of the text itself, not the speech
        // setting (an English-only model ignores "ru").
        let lang = {
            let text: String = raw
                .iter()
                .map(|p| p.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            language::detect(&text, language_hint.as_deref())
        };
        if !languages.contains(&lang.code()) {
            languages.push(lang.code());
        }
        // The document's main text: spaces put back after glued punctuation
        // and, when asked, hesitation sounds removed. The raw section keeps
        // the recognizer's words as they were.
        let cleaned: Vec<document::Paragraph> = raw
            .iter()
            .map(|p| {
                let mut text = language::fix_glued_punctuation(&p.text);
                if req.remove_fillers {
                    text = language::remove_fillers(&text, lang);
                }
                document::Paragraph { text, ..p.clone() }
            })
            .filter(|p| !p.text.trim().is_empty())
            .collect();
        let changed =
            cleaned.len() != raw.len() || cleaned.iter().zip(&raw).any(|(c, r)| c.text != r.text);
        let mut transcript = PartTranscript {
            start_secs: part_start,
            end_secs: end as f64 / SAMPLE_RATE as f64,
            raw,
            cleaned: changed.then_some(cleaned),
            processed: None,
        };

        let stage_started = Instant::now();
        if let Some(target) = llm.as_mut() {
            check_cancel()?;
            progress.emit(
                FileTranscriptionStage::PostProcessing,
                part_no,
                progress.part_fraction(idx, 0.0, true),
            );
            // Start the built-in LLM only now, so it doesn't hold memory
            // while the speech model is still transcribing.
            if target.provider.id == crate::local_llm::LOCAL_PROVIDER_ID && local_llm_use.is_none()
            {
                let (provider, guard) = cancellable(crate::local_llm::prepare_provider(
                    app,
                    target.provider.clone(),
                ))
                .await?;
                target.provider = provider;
                local_llm_use = guard;
            }
        }
        debug.write(
            &format!("part{part_no}_1_asr.tsv"),
            &debug::paragraphs_tsv(&transcript.raw),
        );
        debug.write(
            &format!("part{part_no}_2_cleaned.tsv"),
            &debug::paragraphs_tsv(transcript.main()),
        );
        if let Some(llm) = &llm {
            // A custom instruction applies to every language; the built-in
            // one is written in the language of the text, so the model
            // doesn't translate (it did: English → Russian with a Russian one).
            // Some local models also get a per-model rule (§9.4).
            // Built-in models: the instruction from their ⚙ window if the
            // user wrote one, else the built-in one.
            let local = llm.provider.id == crate::local_llm::LOCAL_PROVIDER_ID;
            let builtin = if local {
                crate::model_settings::llm_prompt(app, &llm.model, lang)
            } else {
                language::default_prompt_for(lang, "")
            };
            let prompt = req
                .llm_prompt
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .unwrap_or(&builtin);
            if !transcript.main().is_empty() {
                let edited = edit_paragraphs(
                    llm,
                    prompt,
                    transcript.main(),
                    part_no,
                    &mut warnings,
                    &req.labels.warnings,
                    &debug,
                    |f| {
                        progress.emit(
                            FileTranscriptionStage::PostProcessing,
                            part_no,
                            progress.part_fraction(idx, f, true),
                        )
                    },
                )
                .await?;
                transcript.processed = Some(edited);
            }
            // Includes starting the built-in LLM for the first part.
            part_times.llm_secs = Some(stage_started.elapsed().as_secs_f64());
        }
        if let Some(edited) = &transcript.processed {
            debug.write(
                &format!("part{part_no}_4_final.tsv"),
                &debug::paragraphs_tsv(edited),
            );
        }
        times.parts.push(part_times);
        transcripts.push(transcript);
    }

    // 5. Write the document.
    check_cancel()?;
    progress.emit(FileTranscriptionStage::Writing, progress.total_parts, 0.99);
    times.total_secs = job_started.elapsed().as_secs_f64();
    info!("File transcription times: {}", times.summary());
    let notes = document::ProcessingNotes {
        times: &times,
        warnings: &warnings,
        languages: &languages,
    };
    let engine_label = match &cloud_config {
        Some(c) => format!("{} ({})", c.model.trim(), host_of(&c.base_url)),
        None => local_model_label(app, &tm),
    };
    let meta = DocumentMeta {
        source_name: input
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| req.input_path.clone()),
        duration_secs,
        engine: engine_label,
        llm: llm.as_ref().map(|l| {
            let local = l.provider.id == crate::local_llm::LOCAL_PROVIDER_ID;
            if local && !req.labels.llm_local.trim().is_empty() {
                req.labels.llm_local.trim().to_string()
            } else {
                format!("{} / {}", l.provider.label, l.model)
            }
        }),
        created: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
    };
    let opts = DocumentOptions {
        labels: &req.labels,
        timestamps: req.timestamps,
        include_raw: req.include_raw,
        notes: req.include_notes.then_some(&notes),
    };
    document::write_document(&output, req.format, &transcripts, &meta, &opts)?;

    let characters = transcripts
        .iter()
        .flat_map(|t| t.processed.as_deref().unwrap_or(t.main()))
        .map(|p| p.text.chars().count())
        .sum::<usize>() as u32;
    if debug.enabled() {
        debug.write(
            "notes.txt",
            &format!(
                "times: {}\nlanguages: {}\nwarnings:\n{}\n",
                times.summary(),
                languages.join(", "),
                warnings.join("\n")
            ),
        );
    }

    Ok(FileTranscriptionResult {
        output_path: output.to_string_lossy().to_string(),
        duration_secs,
        parts: transcripts.len() as u32,
        characters,
        warnings,
    })
}

/// Record a non-fatal problem for the result and the notes section, and log
/// it, so it can still be found after the window is closed.
fn push_warning(warnings: &mut Vec<String>, warning: String) {
    warn!("File transcription warning: {warning}");
    warnings.push(warning);
}

/// Await a future, bailing out early if the user cancels.
async fn cancellable<T>(fut: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            out = &mut fut => return out,
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => check_cancel()?,
        }
    }
}

/// Give each timed cloud segment the speaker it overlaps most. Returns false
/// when the segments carry no timestamps to match on.
fn assign_speakers(segments: &mut [Segment], turns: &[diarize::Turn], part_start: f64) -> bool {
    if segments.iter().any(|s| !s.timed) {
        return false;
    }
    for i in 0..segments.len() {
        let start = part_start + segments[i].start_secs;
        let end = part_start
            + segments[i]
                .end_secs
                .or_else(|| segments.get(i + 1).map(|n| n.start_secs))
                .unwrap_or(segments[i].start_secs + 5.0);
        let mut overlap: std::collections::HashMap<u32, f64> = Default::default();
        for t in turns {
            let o = t.end_secs.min(end) - t.start_secs.max(start);
            if o > 0.0 {
                *overlap.entry(t.speaker).or_default() += o;
            }
        }
        segments[i].speaker = overlap
            .into_iter()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(sp, _)| sp)
            // Silence between turns: keep the previous speaker.
            .or_else(|| i.checked_sub(1).and_then(|p| segments[p].speaker));
    }
    true
}

/// Run a part through the local model in segments cut at pauses (12–25 s by
/// default, see `split::segment_bounds`).
/// With diarization `turns` (sample ranges within the part), segments are
/// also cut at every change of speaker and carry that speaker.
async fn transcribe_local(
    tm: &Arc<TranscriptionManager>,
    samples: Vec<f32>,
    turns: Option<&[(usize, usize, u32)]>,
    bounds: split::SegmentBounds,
    on_progress: impl Fn(f64),
) -> Result<Vec<Segment>> {
    // No-op when the model is loaded; recovers if it was dropped between parts
    // (e.g. after an engine panic).
    tm.initiate_model_load();
    // Whisper capitalizes the start of every run, so a capital after a cut
    // says nothing about a sentence end there.
    let is_whisper = {
        let tm = tm.clone();
        tauri::async_runtime::spawn_blocking(move || tm.loaded_model_is_whisper()).await?
    };
    let plan: Vec<(usize, usize, Option<u32>)> = match turns {
        Some(turns) => split::plan_segments_with_turns(&samples, bounds, turns),
        None => split::plan_segments(&samples, bounds)
            .into_iter()
            .map(|(s, e)| (s, e, None))
            .collect(),
    };
    let mut out: Vec<Segment> = Vec::with_capacity(plan.len());

    for (i, &(s, e, speaker)) in plan.iter().enumerate() {
        check_cancel()?;
        on_progress(i as f64 / plan.len() as f64);
        let chunk = &samples[s..e];
        if split::is_silent(chunk) {
            continue;
        }
        let chunk = chunk.to_vec();
        let tm = tm.clone();
        let text = tauri::async_runtime::spawn_blocking(move || tm.transcribe_verbatim(chunk))
            .await
            .map_err(|e| anyhow!("transcription task panicked: {e}"))??;
        let text = text.trim();
        if !text.is_empty() {
            out.push(Segment {
                start_secs: s as f64 / SAMPLE_RATE as f64,
                end_secs: Some(e as f64 / SAMPLE_RATE as f64),
                text: text.to_string(),
                timed: true,
                speaker,
            });
        }
    }
    if !is_whisper {
        for i in 0..out.len().saturating_sub(1) {
            let next = out[i + 1].text.clone();
            out[i].text = document::close_sentence_at_cut(&out[i].text, Some(&next));
        }
    }
    on_progress(1.0);
    Ok(out)
}

struct LlmTarget {
    provider: crate::settings::PostProcessProvider,
    model: String,
    api_key: String,
    /// Characters per request: smaller for built-in models (their ⚙ window).
    chunk_chars: usize,
}

fn resolve_llm(settings: &crate::settings::AppSettings) -> Result<LlmTarget> {
    let provider = settings
        .active_post_process_provider()
        .cloned()
        .ok_or_else(|| anyhow!("no LLM provider is selected for post-processing"))?;
    if provider.id == crate::settings::APPLE_INTELLIGENCE_PROVIDER_ID {
        bail!("Apple Intelligence is not supported for file post-processing");
    }
    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if model.trim().is_empty() {
        bail!("no LLM model is set for provider '{}'", provider.label);
    }
    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    Ok(LlmTarget {
        provider,
        model,
        api_key,
        chunk_chars: EXTERNAL_LLM_CHUNK_CHARS,
    })
}

/// Edit a part's paragraphs with the LLM as numbered lines, in chunks. Each
/// paragraph keeps its speaker and time; a line the model lost, merged,
/// looped on or translated keeps its own text (counted in one warning per
/// chunk), and a chunk that failed outright keeps all of its text.
async fn edit_paragraphs(
    llm: &LlmTarget,
    prompt: &str,
    paragraphs: &[document::Paragraph],
    part_no: u32,
    warnings: &mut Vec<String>,
    wording: &WarningLabels,
    debug: &debug::DebugDump,
    on_progress: impl Fn(f64),
) -> Result<Vec<document::Paragraph>> {
    let ranges = numbered::chunk_ranges(paragraphs, llm.chunk_chars);
    let system = format!(
        "{}\n\n{}",
        prompt.replace("${output}", "").trim(),
        numbered::LINE_RULE.trim()
    );
    if part_no == 1 {
        debug.write("system_prompt.txt", &system);
    }
    // Same rule as dictation post-processing (`actions::post_process_transcription`).
    let disable_reasoning = matches!(llm.provider.id.as_str(), "custom" | "openrouter");
    let mut out: Vec<document::Paragraph> = paragraphs.to_vec();
    let mut kept_report = String::from("n\treason\n");

    for (i, range) in ranges.iter().enumerate() {
        check_cancel()?;
        on_progress(i as f64 / ranges.len() as f64);
        let fragment = i + 1;
        let input = numbered::render(paragraphs, range.clone());
        debug.write(
            &format!("part{part_no}_3_llm_{fragment:02}_input.txt"),
            &input,
        );
        let request = crate::llm_client::send_chat_completion_answer(
            &llm.provider,
            llm.api_key.clone(),
            &llm.model,
            input,
            Some(system.clone()),
            None,
            disable_reasoning,
        );
        let (answer, cut_off) = match cancellable(async { Ok(request.await) }).await? {
            Ok(crate::llm_client::ChatAnswer {
                content: Some(content),
                cut_off,
            }) if !content.trim().is_empty() => (content, cut_off),
            Ok(_) => {
                push_warning(
                    warnings,
                    fill(
                        &wording.llm_empty,
                        &[("part", &part_no), ("fragment", &fragment)],
                    ),
                );
                continue;
            }
            Err(e) => {
                push_warning(
                    warnings,
                    fill(
                        &wording.llm_error,
                        &[("part", &part_no), ("fragment", &fragment), ("error", &e)],
                    ),
                );
                continue;
            }
        };
        debug.write(
            &format!("part{part_no}_3_llm_{fragment:02}_answer.txt"),
            &answer,
        );
        let parsed = numbered::parse(crate::actions::strip_think_block(&answer));
        let (texts, kept) = numbered::merge(paragraphs, range.clone(), &parsed, cut_off);
        let mut numbers_back = 0;
        for (idx, text) in range.clone().zip(texts) {
            out[idx].text = match numbered::keep_numbers(paragraphs[idx].text.trim(), &text) {
                Some(fixed) => {
                    numbers_back += 1;
                    kept_report.push_str(&format!("{}\tnumber put back\n", idx + 1));
                    fixed
                }
                None => text,
            };
        }
        if numbers_back > 0 {
            push_warning(
                warnings,
                fill(
                    &wording.numbers_back,
                    &[
                        ("part", &part_no),
                        ("fragment", &fragment),
                        ("count", &numbers_back),
                    ],
                ),
            );
        }
        if kept.len() == range.len() {
            push_warning(
                warnings,
                fill(
                    &wording.lines_lost,
                    &[("part", &part_no), ("fragment", &fragment)],
                ),
            );
        } else if !kept.is_empty() {
            let mut reasons: Vec<&str> = kept.iter().map(|(_, k)| wording.kept(*k)).collect();
            reasons.sort_unstable();
            reasons.dedup();
            push_warning(
                warnings,
                fill(
                    &wording.lines_kept,
                    &[
                        ("part", &part_no),
                        ("fragment", &fragment),
                        ("kept", &kept.len()),
                        ("total", &range.len()),
                        ("reasons", &reasons.join(", ")),
                    ],
                ),
            );
        }
        for (n, why) in &kept {
            kept_report.push_str(&format!("{n}\t{}\n", why.as_str()));
        }
    }
    debug.write(&format!("part{part_no}_3_llm_kept.tsv"), &kept_report);
    on_progress(1.0);
    Ok(out)
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.trim().to_string())
}

fn local_model_label(app: &AppHandle, tm: &TranscriptionManager) -> String {
    let id = tm
        .get_current_model()
        .unwrap_or_else(|| get_settings(app).selected_model);
    let mm = app.state::<Arc<crate::managers::model::ModelManager>>();
    mm.get_model_info(&id).map(|m| m.name).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_segments_get_the_overlapping_speaker() {
        let turn = |a: f64, b: f64, speaker: u32| diarize::Turn {
            start_secs: a,
            end_secs: b,
            speaker,
        };
        let seg = |start: f64, end: Option<f64>| Segment {
            start_secs: start,
            end_secs: end,
            text: "x".into(),
            timed: true,
            speaker: None,
        };
        // The part starts at 100 s; segment times are relative to it.
        let turns = [
            turn(100.0, 110.0, 0),
            turn(110.0, 130.0, 1),
            turn(131.0, 140.0, 0),
        ];
        let mut segs = vec![
            seg(0.0, Some(9.0)),
            seg(9.0, Some(25.0)),
            seg(30.5, Some(30.9)), // silence between turns: previous speaker
            seg(32.0, None),       // no end: runs to +5 s
        ];
        assert!(assign_speakers(&mut segs, &turns, 100.0));
        let got: Vec<Option<u32>> = segs.iter().map(|s| s.speaker).collect();
        assert_eq!(got, vec![Some(0), Some(1), Some(1), Some(0)]);

        let mut untimed = vec![Segment {
            timed: false,
            ..seg(0.0, None)
        }];
        assert!(!assign_speakers(&mut untimed, &turns, 100.0));
    }

    fn test_labels() -> DocumentLabels {
        DocumentLabels {
            title: "Транскрипт".into(),
            source_file: "Файл".into(),
            duration: "Длительность".into(),
            parts: "Частей".into(),
            engine: "Распознавание".into(),
            llm: "LLM".into(),
            created: "Создан".into(),
            part: "Часть".into(),
            raw_transcript: "Исходная расшифровка".into(),
            speaker: "Спикер".into(),
            notes: "Замечания обработки".into(),
            notes_total: "Время обработки".into(),
            notes_extracting: "Извлечение звука".into(),
            notes_diarizing: "Определение говорящих".into(),
            notes_transcribing: "Распознавание".into(),
            notes_llm: "Обработка LLM".into(),
            notes_warnings: "Предупреждения".into(),
            notes_none: "нет".into(),
            notes_language: "Язык текста".into(),
            llm_local: String::new(),
            warnings: WarningLabels::default(),
        }
    }

    #[test]
    fn stage_weights_follow_measured_times() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // GigaAM + speakers + built-in LLM: the LLM takes most of the bar, as
        // it took 83 % of the time on a 28-minute meeting (2026-10-09).
        let w = StageWeights::new(true, local_asr_secs_per_min(Some(0.98)), Some(25.0));
        assert!(close(w.extract + w.diarize + w.transcribe + w.llm, 1.0));
        assert!(w.llm > 0.7 && w.llm < 0.85, "llm share {}", w.llm);
        assert!(w.extract < 0.01);
        // Nothing but a slow recognizer: it takes almost the whole bar.
        let w = StageWeights::new(false, local_asr_secs_per_min(Some(0.38)), None);
        assert!(close(w.diarize, 0.0) && close(w.llm, 0.0));
        assert!(w.transcribe > 0.99);
        // Qwen3-ASR 1.7B took 24–27 s per minute.
        let qwen = local_asr_secs_per_min(Some(0.38));
        assert!((24.0..=27.0).contains(&qwen), "{qwen}");
        assert!(close(
            local_asr_secs_per_min(Some(0.98)),
            SECS_PER_MIN_ASR_FAST
        ));
        assert!(close(
            local_asr_secs_per_min(None),
            SECS_PER_MIN_ASR_UNKNOWN
        ));
        assert!(close(
            local_asr_secs_per_min(Some(0.0)),
            SECS_PER_MIN_ASR_UNKNOWN
        ));
    }

    #[test]
    fn part_fractions_run_from_the_parts_start_to_the_end() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        let w = StageWeights::new(true, 3.0, Some(25.0));
        let start = w.parts_start();
        assert!(close(w.part_fraction(2, 0, 0.0, false), start));
        // Part 1's LLM ends where part 2's recognition starts.
        assert!(close(
            w.part_fraction(2, 0, 1.0, true),
            w.part_fraction(2, 1, 0.0, false)
        ));
        assert!(close(w.part_fraction(2, 1, 1.0, true), 1.0));
        // Recognition ends where the LLM of the same part starts.
        assert!(close(
            w.part_fraction(1, 0, 1.0, false),
            w.part_fraction(1, 0, 0.0, true)
        ));
        // Without an LLM, recognition alone reaches the end.
        let w = StageWeights::new(false, 3.0, None);
        assert!(close(w.part_fraction(3, 2, 1.0, false), 1.0));
    }

    #[test]
    fn warning_templates_are_filled_in() {
        let texts = WarningLabels {
            numbers_back: "часть {part}, фрагмент {fragment}: числа возвращены (строк: {count})"
                .into(),
            ..WarningLabels::default()
        };
        assert_eq!(
            fill(
                &texts.numbers_back,
                &[("part", &1), ("fragment", &9), ("count", &2)]
            ),
            "часть 1, фрагмент 9: числа возвращены (строк: 2)"
        );
        // The English defaults keep the texts the log and old results had.
        assert_eq!(
            fill(
                &WarningLabels::default().lines_kept,
                &[
                    ("part", &1),
                    ("fragment", &3),
                    ("kept", &3),
                    ("total", &12),
                    ("reasons", &"too short"),
                ],
            ),
            "part 1, fragment 3: 3 of 12 lines kept their raw text (too short)"
        );
        assert_eq!(texts.kept(numbered::Kept::CutOff), "cut off");
        // A request without the warning texts still gets the English ones.
        let labels: WarningLabels = serde_json::from_str("{}").unwrap();
        assert_eq!(labels.llm_empty, WarningLabels::default().llm_empty);
    }

    /// End-to-end over real media with the real ffmpeg: extraction, part
    /// planning, cloud upload (against a mock server), document export.
    /// Run with `HANDY_FT_MEDIA_DIR=<dir> HANDY_FT_MOCK_URL=<url>
    /// cargo test --lib media_pipeline -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn media_pipeline() {
        let dir = PathBuf::from(std::env::var("HANDY_FT_MEDIA_DIR").expect("media dir"));
        let ffmpeg = media::find_ffmpeg().expect("ffmpeg");
        let no_cancel = AtomicBool::new(false);
        let temp = TempDir::new().unwrap();

        for (name, max_min, expected_parts) in [
            ("short.webm", 2, 4),
            ("short.mp4", 29, 1),
            ("short.mp3", 3, 3),
            ("long.mkv", 29, 3),
        ] {
            let input = dir.join(name);
            let info = media::probe(&ffmpeg, &input).unwrap();
            let pcm_path = temp.0.join(format!("{name}.pcm"));
            let mut last = 0.0;
            media::extract_pcm(&ffmpeg, &input, &pcm_path, &no_cancel, |p| last = p).unwrap();
            let mut pcm = PcmFile::open(&pcm_path).unwrap();
            let secs = pcm.len() as f64 / SAMPLE_RATE as f64;
            let parts = split::plan_parts(&mut pcm, max_min * 60 * SAMPLE_RATE).unwrap();
            let lens: Vec<String> = parts
                .iter()
                .map(|(s, e)| document::format_hms((e - s) as f64 / SAMPLE_RATE as f64))
                .collect();
            println!(
                "{name}: probe={:?}s decoded={secs:.1}s progress_last={last:.1}s parts={} {:?}",
                info.duration_secs,
                parts.len(),
                lens
            );
            // Container duration can include a slightly longer video stream.
            assert!((secs - info.duration_secs.unwrap()).abs() < 6.0);
            assert_eq!(parts.len(), expected_parts);
            assert_eq!(parts.first().unwrap().0, 0);
            assert_eq!(parts.last().unwrap().1, pcm.len());
            for (s, e) in &parts {
                assert!(e - s <= max_min * 60 * SAMPLE_RATE, "part too long");
            }
        }

        // Cloud path against the mock server, then both document formats.
        let pcm_path = temp.0.join("long.mkv.pcm");
        let mut pcm = PcmFile::open(&pcm_path).unwrap();
        let parts = split::plan_parts(&mut pcm, 29 * 60 * SAMPLE_RATE).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mock = std::env::var("HANDY_FT_MOCK_URL").expect("mock url");
        let mut transcripts = Vec::new();
        for (i, &(s, e)) in parts.iter().enumerate() {
            let mp3 = temp.0.join(format!("part-{i}.mp3"));
            media::encode_mp3_range(&ffmpeg, &pcm_path, s, e, &mp3).unwrap();
            let size = std::fs::metadata(&mp3).unwrap().len();
            println!("part {i}: mp3 {:.1} MB", size as f64 / 1e6);
            assert!(size < 25_000_000);
            let model = if i == 0 {
                "whisper-large-v3"
            } else {
                "gpt-4o-transcribe"
            };
            let config = CloudSttConfig {
                base_url: mock.clone(),
                api_key: "sk-test".into(),
                model: model.into(),
                language: Some("ru".into()),
                prompt: None,
            };
            let segments = rt.block_on(cloud::transcribe_part(&config, &mp3)).unwrap();
            let start = s as f64 / SAMPLE_RATE as f64;
            transcripts.push(PartTranscript {
                start_secs: start,
                end_secs: e as f64 / SAMPLE_RATE as f64,
                raw: document::paragraphs_from_segments(&segments, start),
                cleaned: None,
                processed: (i == 2).then(|| {
                    vec![document::Paragraph {
                        start_secs: Some(start),
                        text: "Абзац один.".to_string(),
                        speaker: None,
                    }]
                }),
            });
        }
        let meta = DocumentMeta {
            source_name: "long.mkv".into(),
            duration_secs: pcm.len() as f64 / SAMPLE_RATE as f64,
            engine: "mock".into(),
            llm: Some("mock / llm".into()),
            created: "2026-09-24 21:00".into(),
        };
        let labels = test_labels();
        let opts = DocumentOptions {
            labels: &labels,
            timestamps: true,
            include_raw: true,
            notes: None,
        };
        let md = dir.join("out.md");
        let docx = dir.join("out.docx");
        document::write_document(&md, OutputFormat::Markdown, &transcripts, &meta, &opts).unwrap();
        document::write_document(&docx, OutputFormat::Docx, &transcripts, &meta, &opts).unwrap();
        println!("{}", std::fs::read_to_string(&md).unwrap());
        assert!(std::fs::metadata(&docx).unwrap().len() > 1000);
    }
}
