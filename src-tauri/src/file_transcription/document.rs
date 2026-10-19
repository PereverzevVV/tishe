//! Assembles the per-part transcripts into one Markdown or Word document.

use super::{DocumentLabels, OutputFormat, Segment};
use anyhow::{Context, Result};
use std::path::Path;

/// Paragraphs are cut once they span this much audio or text.
const PARAGRAPH_SECS: f64 = 60.0;
const PARAGRAPH_CHARS: usize = 700;

#[derive(Clone)]
pub struct Paragraph {
    /// Absolute start time, when the recognizer reported one.
    pub start_secs: Option<f64>,
    pub text: String,
    /// 0-based speaker, when diarization ran.
    pub speaker: Option<u32>,
}

pub struct PartTranscript {
    pub start_secs: f64,
    pub end_secs: f64,
    /// The recognizer's words as they came, for the raw section.
    pub raw: Vec<Paragraph>,
    /// `raw` with glued punctuation fixed and fillers removed, when that
    /// changed anything: the main text and the LLM's input.
    pub cleaned: Option<Vec<Paragraph>>,
    /// The LLM's edit of `main()`, paragraph for paragraph (same speakers
    /// and times), if post-processing ran for this part.
    pub processed: Option<Vec<Paragraph>>,
}

impl PartTranscript {
    /// Paragraphs for the main text when there is no LLM edit.
    pub fn main(&self) -> &[Paragraph] {
        self.cleaned.as_deref().unwrap_or(&self.raw)
    }
}

pub struct DocumentMeta {
    pub source_name: String,
    pub duration_secs: f64,
    pub engine: String,
    pub llm: Option<String>,
    pub created: String,
}

pub struct DocumentOptions<'a> {
    pub labels: &'a DocumentLabels,
    pub timestamps: bool,
    pub include_raw: bool,
    /// Closing "processing notes" section, when requested.
    pub notes: Option<&'a ProcessingNotes<'a>>,
}

/// How long one part took, in seconds.
pub struct PartTimes {
    pub transcribe_secs: f64,
    /// Set when the part went through the LLM (includes starting the
    /// built-in one for the first part).
    pub llm_secs: Option<f64>,
}

/// How long each stage of a job took, in seconds.
#[derive(Default)]
pub struct JobTimes {
    pub total_secs: f64,
    pub extract_secs: f64,
    pub diarize_secs: Option<f64>,
    pub parts: Vec<PartTimes>,
}

impl JobTimes {
    fn transcribe_secs(&self) -> f64 {
        self.parts.iter().map(|p| p.transcribe_secs).sum()
    }

    fn llm_secs(&self) -> Option<f64> {
        let times: Vec<f64> = self.parts.iter().filter_map(|p| p.llm_secs).collect();
        (!times.is_empty()).then(|| times.iter().sum())
    }

    /// One log line: totals per stage, then each part.
    pub fn summary(&self) -> String {
        let mut out = format!(
            "total {}, extract {}",
            format_hms(self.total_secs),
            format_hms(self.extract_secs)
        );
        if let Some(d) = self.diarize_secs {
            out.push_str(&format!(", speakers {}", format_hms(d)));
        }
        out.push_str(&format!(
            ", transcribe {}",
            format_hms(self.transcribe_secs())
        ));
        if let Some(l) = self.llm_secs() {
            out.push_str(&format!(", llm {}", format_hms(l)));
        }
        for (i, p) in self.parts.iter().enumerate() {
            out.push_str(&format!(
                "; part {}: transcribe {}",
                i + 1,
                format_hms(p.transcribe_secs)
            ));
            if let Some(l) = p.llm_secs {
                out.push_str(&format!(", llm {}", format_hms(l)));
            }
        }
        out
    }
}

pub struct ProcessingNotes<'a> {
    pub times: &'a JobTimes,
    pub warnings: &'a [String],
    /// Languages the text was found to be in ("ru", "en", "other").
    pub languages: &'a [&'a str],
}

pub fn format_hms(secs: f64) -> String {
    let total = secs.max(0.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

/// Group recognizer segments (start times relative to the part, which starts
/// at `part_start`) into readable paragraphs.
pub fn paragraphs_from_segments(segments: &[Segment], part_start: f64) -> Vec<Paragraph> {
    let mut out: Vec<Paragraph> = Vec::new();
    let mut current: Option<(Option<f64>, String)> = None;
    let mut speaker: Option<u32> = None;

    for seg in segments {
        // A new speaker always starts a new paragraph.
        if seg.speaker != speaker {
            if let Some((start_secs, text)) = current.take() {
                out.push(Paragraph {
                    start_secs,
                    text,
                    speaker,
                });
            }
            speaker = seg.speaker;
        }
        // Long segments (whisper runs of 1–2 min, untimed cloud text) are split
        // on sentence ends; only the first piece knows its start time.
        let pieces = split_sentences_into_chunks(&seg.text, PARAGRAPH_CHARS);
        let seg_start = seg.timed.then_some(part_start + seg.start_secs);

        for (idx, piece) in pieces.into_iter().enumerate() {
            if piece.trim().is_empty() {
                continue;
            }
            let piece_start = if idx == 0 { seg_start } else { None };
            let (para_start, text) = current.get_or_insert_with(|| (piece_start, String::new()));
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece.trim());

            let long_in_time = match (para_start, seg_start) {
                (Some(a), Some(b)) => b - *a >= PARAGRAPH_SECS,
                _ => false,
            };
            if long_in_time || text.chars().count() >= PARAGRAPH_CHARS || !seg.timed || idx > 0 {
                let (start_secs, text) = current.take().unwrap();
                out.push(Paragraph {
                    start_secs,
                    text,
                    speaker,
                });
            }
        }
    }
    if let Some((start_secs, text)) = current {
        if !text.trim().is_empty() {
            out.push(Paragraph {
                start_secs,
                text,
                speaker,
            });
        }
    }
    out
}

/// "Speaker 1" for the 0-based `speaker`.
pub fn speaker_name(label: &str, speaker: u32) -> String {
    format!("{label} {}", speaker + 1)
}

/// Segments are cut at pauses, and a model can leave a segment that ends
/// mid-stream without a full stop. When the next segment starts with a capital
/// letter the pause was a sentence end, so close it. Not used for whisper,
/// which capitalizes the start of every run regardless.
pub fn close_sentence_at_cut(text: &str, next: Option<&str>) -> String {
    let ends_open = text.chars().last().is_some_and(|c| c.is_alphanumeric());
    let next_is_sentence = next
        .and_then(|n| n.trim_start().chars().next())
        .is_some_and(|c| c.is_uppercase());
    if ends_open && next_is_sentence {
        format!("{text}.")
    } else {
        text.to_string()
    }
}

/// Split text on sentence ends into chunks of roughly `target` characters.
pub fn split_sentences_into_chunks(text: &str, target: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    let mut sentence = String::new();

    while let Some(c) = chars.next() {
        sentence.push(c);
        let at_end = matches!(c, '.' | '!' | '?' | '…' | '\n')
            && chars.peek().is_none_or(|n| n.is_whitespace());
        if at_end || chars.peek().is_none() {
            current.push_str(&sentence);
            sentence.clear();
            if current.chars().count() >= target {
                chunks.push(current.trim().to_string());
                current.clear();
            }
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

/// Neutral, format-independent document model.
enum Block {
    Title(String),
    Meta(String),
    Heading(String),
    Text {
        timestamp: Option<String>,
        /// "Speaker N", shown in bold before the text.
        speaker: Option<String>,
        text: String,
    },
}

fn build_blocks(
    parts: &[PartTranscript],
    meta: &DocumentMeta,
    opts: &DocumentOptions,
) -> Vec<Block> {
    let l = opts.labels;
    let mut blocks = vec![
        Block::Title(format!("{}: {}", l.title, meta.source_name)),
        Block::Meta(format!("{}: {}", l.source_file, meta.source_name)),
        Block::Meta(format!(
            "{}: {}",
            l.duration,
            format_hms(meta.duration_secs)
        )),
        Block::Meta(format!("{}: {}", l.parts, parts.len())),
        Block::Meta(format!("{}: {}", l.engine, meta.engine)),
    ];
    if let Some(llm) = &meta.llm {
        blocks.push(Block::Meta(format!("{}: {}", l.llm, llm)));
    }
    blocks.push(Block::Meta(format!("{}: {}", l.created, meta.created)));

    let multi = parts.len() > 1;
    let part_heading = |i: usize, p: &PartTranscript| {
        format!(
            "{} {} · {} – {}",
            l.part,
            i + 1,
            format_hms(p.start_secs),
            format_hms(p.end_secs)
        )
    };
    // The label goes on a speaker's first paragraph and carries over part
    // boundaries, so a speaker who keeps talking isn't announced again.
    let push_raw = |blocks: &mut Vec<Block>, paragraphs: &[Paragraph], last: &mut Option<u32>| {
        for para in paragraphs {
            let speaker = para
                .speaker
                .filter(|&sp| *last != Some(sp))
                .map(|sp| speaker_name(&l.speaker, sp));
            *last = para.speaker;
            blocks.push(Block::Text {
                timestamp: para.start_secs.filter(|_| opts.timestamps).map(format_hms),
                speaker,
                text: para.text.clone(),
            });
        }
    };

    let any_processed = parts.iter().any(|p| p.processed.is_some());
    let mut last_speaker = None;
    for (i, part) in parts.iter().enumerate() {
        if multi {
            blocks.push(Block::Heading(part_heading(i, part)));
        }
        let paragraphs = part.processed.as_deref().unwrap_or(part.main());
        push_raw(&mut blocks, paragraphs, &mut last_speaker);
    }

    if opts.include_raw && any_processed {
        blocks.push(Block::Heading(l.raw_transcript.clone()));
        let mut last_speaker = None;
        for (i, part) in parts.iter().enumerate() {
            if multi {
                blocks.push(Block::Heading(part_heading(i, part)));
            }
            push_raw(&mut blocks, &part.raw, &mut last_speaker);
        }
    }

    if let Some(notes) = opts.notes {
        push_notes(&mut blocks, notes, l, multi);
    }
    blocks
}

/// The closing section: time per stage (per part too when there are several)
/// and every warning, so a document shows how it was made.
fn push_notes(blocks: &mut Vec<Block>, notes: &ProcessingNotes, l: &DocumentLabels, multi: bool) {
    let t = notes.times;
    let line = |caption: &str, total: f64, per_part: Option<Vec<f64>>| {
        let mut s = format!("{caption}: {}", format_hms(total));
        if let Some(per_part) = per_part.filter(|_| multi) {
            let parts: Vec<String> = per_part.into_iter().map(format_hms).collect();
            s.push_str(&format!(" ({})", parts.join(" · ")));
        }
        Block::Meta(s)
    };
    blocks.push(Block::Heading(l.notes.clone()));
    blocks.push(line(&l.notes_total, t.total_secs, None));
    if !notes.languages.is_empty() {
        blocks.push(Block::Meta(format!(
            "{}: {}",
            l.notes_language,
            notes.languages.join(", ")
        )));
    }
    blocks.push(line(&l.notes_extracting, t.extract_secs, None));
    if let Some(d) = t.diarize_secs {
        blocks.push(line(&l.notes_diarizing, d, None));
    }
    blocks.push(line(
        &l.notes_transcribing,
        t.transcribe_secs(),
        Some(t.parts.iter().map(|p| p.transcribe_secs).collect()),
    ));
    if let Some(total) = t.llm_secs() {
        blocks.push(line(
            &l.notes_llm,
            total,
            Some(t.parts.iter().map(|p| p.llm_secs.unwrap_or(0.0)).collect()),
        ));
    }
    if notes.warnings.is_empty() {
        blocks.push(Block::Meta(format!(
            "{}: {}",
            l.notes_warnings, l.notes_none
        )));
    } else {
        blocks.push(Block::Meta(format!("{}:", l.notes_warnings)));
        for w in notes.warnings {
            blocks.push(Block::Meta(format!("— {w}")));
        }
    }
}

pub fn write_document(
    path: &Path,
    format: OutputFormat,
    parts: &[PartTranscript],
    meta: &DocumentMeta,
    opts: &DocumentOptions,
) -> Result<()> {
    let blocks = build_blocks(parts, meta, opts);
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).context("failed to create the output folder")?;
        }
    }
    match format {
        OutputFormat::Markdown => {
            std::fs::write(path, render_markdown(&blocks)).context("failed to write the file")
        }
        OutputFormat::Docx => write_docx(path, &blocks),
    }
}

fn render_markdown(blocks: &[Block]) -> String {
    let mut out = String::new();
    let mut in_meta = false;
    for block in blocks {
        match block {
            Block::Meta(_) => {}
            _ if in_meta => {
                out.push('\n');
                in_meta = false;
            }
            _ => {}
        }
        match block {
            Block::Title(t) => out.push_str(&format!("# {t}\n\n")),
            Block::Meta(m) => {
                out.push_str(&format!("- {m}\n"));
                in_meta = true;
            }
            Block::Heading(h) => out.push_str(&format!("## {h}\n\n")),
            Block::Text {
                timestamp,
                speaker,
                text,
            } => match (timestamp, speaker) {
                (Some(ts), Some(sp)) => out.push_str(&format!("**[{ts}] {sp}:** {text}\n\n")),
                (None, Some(sp)) => out.push_str(&format!("**{sp}:** {text}\n\n")),
                (Some(ts), None) => out.push_str(&format!("**[{ts}]** {text}\n\n")),
                (None, None) => out.push_str(&format!("{text}\n\n")),
            },
        }
    }
    out.trim_end().to_string() + "\n"
}

fn write_docx(path: &Path, blocks: &[Block]) -> Result<()> {
    use docx_rs::{Docx, Paragraph, Run, RunFonts, Style, StyleType};

    let mut docx = Docx::new()
        .default_fonts(
            RunFonts::new()
                .ascii("Calibri")
                .hi_ansi("Calibri")
                .cs("Calibri"),
        )
        .default_size(22)
        .add_style(
            Style::new("Title", StyleType::Paragraph)
                .name("Title")
                .size(36)
                .bold(),
        )
        .add_style(
            Style::new("Heading1", StyleType::Paragraph)
                .name("heading 1")
                .size(28)
                .bold(),
        );

    for block in blocks {
        let paragraph = match block {
            Block::Title(t) => Paragraph::new()
                .style("Title")
                .add_run(Run::new().add_text(t)),
            Block::Meta(m) => {
                Paragraph::new().add_run(Run::new().add_text(m).color("666666").size(20))
            }
            Block::Heading(h) => Paragraph::new()
                .style("Heading1")
                .add_run(Run::new().add_text(h)),
            Block::Text {
                timestamp,
                speaker,
                text,
            } => {
                let mut p = Paragraph::new();
                if let Some(ts) = timestamp {
                    p = p.add_run(
                        Run::new()
                            .add_text(format!("[{ts}] "))
                            .bold()
                            .color("666666"),
                    );
                }
                if let Some(sp) = speaker {
                    p = p.add_run(Run::new().add_text(format!("{sp}: ")).bold());
                }
                p.add_run(Run::new().add_text(text))
            }
        };
        docx = docx.add_paragraph(paragraph);
    }

    let file = std::fs::File::create(path).context("failed to create the file")?;
    docx.build()
        .pack(file)
        .map_err(|e| anyhow::anyhow!("failed to write the Word document: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hms_formatting() {
        assert_eq!(format_hms(3725.4), "01:02:05");
    }

    #[test]
    fn sentence_chunks_respect_target() {
        let text = "Раз. Два! Три? Четыре. Пять.";
        let chunks = split_sentences_into_chunks(text, 8);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.join(" "), text);
    }

    #[test]
    fn long_timed_segment_splits_into_paragraphs() {
        let sentence = "Это одно предложение средней длины для проверки. ";
        let segs = vec![Segment {
            start_secs: 10.0,
            text: sentence.repeat(40),
            timed: true,
            end_secs: None,
            speaker: None,
        }];
        let paras = paragraphs_from_segments(&segs, 100.0);
        assert!(paras.len() > 1);
        assert_eq!(paras[0].start_secs, Some(110.0));
        assert!(paras[1..].iter().all(|p| p.start_secs.is_none()));
        assert!(paras
            .iter()
            .all(|p| p.text.chars().count() < 2 * PARAGRAPH_CHARS));
    }

    #[test]
    fn closes_sentence_at_capitalized_cut() {
        assert_eq!(
            close_sentence_at_cut("офис в Казани", Some("Теперь о расходах")),
            "офис в Казани."
        );
        assert_eq!(
            close_sentence_at_cut("и затем", Some("продолжили")),
            "и затем"
        );
        assert_eq!(close_sentence_at_cut("Вопросы?", Some("Нет")), "Вопросы?");
        assert_eq!(close_sentence_at_cut("конец", None), "конец");
    }

    fn seg(start: f64, text: &str, speaker: Option<u32>) -> Segment {
        Segment {
            start_secs: start,
            text: text.into(),
            timed: true,
            end_secs: None,
            speaker,
        }
    }

    fn labels() -> DocumentLabels {
        DocumentLabels {
            title: "T".into(),
            source_file: "F".into(),
            duration: "D".into(),
            parts: "P".into(),
            engine: "E".into(),
            llm: "L".into(),
            created: "C".into(),
            part: "Часть".into(),
            raw_transcript: "R".into(),
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
            warnings: Default::default(),
        }
    }

    fn render(parts: &[PartTranscript], timestamps: bool) -> String {
        let meta = DocumentMeta {
            source_name: "x".into(),
            duration_secs: 1.0,
            engine: "e".into(),
            llm: None,
            created: "c".into(),
        };
        let l = labels();
        let opts = DocumentOptions {
            labels: &l,
            timestamps,
            include_raw: false,
            notes: None,
        };
        render_markdown(&build_blocks(parts, &meta, &opts))
    }

    #[test]
    fn edited_paragraphs_keep_speakers_and_times() {
        let raw = paragraphs_from_segments(
            &[
                seg(0.0, "привет как дела", Some(0)),
                seg(6.0, "хорошо", Some(1)),
            ],
            60.0,
        );
        let processed: Vec<Paragraph> = raw
            .iter()
            .zip(["Привет! Как дела?", "Хорошо."])
            .map(|(p, text)| Paragraph {
                text: text.into(),
                ..p.clone()
            })
            .collect();
        let part = PartTranscript {
            start_secs: 60.0,
            end_secs: 70.0,
            raw,
            cleaned: None,
            processed: Some(processed),
        };
        let md = render(&[part], true);
        assert!(md.contains("**[00:01:00] Спикер 1:** Привет! Как дела?"));
        assert!(md.contains("**[00:01:06] Спикер 2:** Хорошо."));
    }

    #[test]
    fn speakers_become_stenogram_lines() {
        let segs = vec![
            seg(0.0, "Привет.", Some(0)),
            seg(3.0, "Как дела?", Some(0)),
            seg(6.0, "Хорошо.", Some(1)),
            seg(9.0, "Отлично.", Some(0)),
        ];
        let raw = paragraphs_from_segments(&segs, 0.0);
        assert_eq!(raw.len(), 3);
        assert_eq!(raw[0].text, "Привет. Как дела?");
        let part = PartTranscript {
            start_secs: 0.0,
            end_secs: 12.0,
            raw,
            cleaned: None,
            processed: None,
        };
        let md = render(std::slice::from_ref(&part), true);
        assert!(md.contains("**[00:00:00] Спикер 1:** Привет. Как дела?"));
        assert!(md.contains("**[00:00:06] Спикер 2:** Хорошо."));
        let md = render(&[part], false);
        assert!(md.contains("**Спикер 1:** Привет. Как дела?"));
        assert!(md.contains("**Спикер 1:** Отлично."));
    }

    #[test]
    fn notes_list_stage_times_and_warnings() {
        let part = |secs: f64| PartTranscript {
            start_secs: 0.0,
            end_secs: secs,
            raw: paragraphs_from_segments(&[seg(0.0, "Текст.", None)], 0.0),
            cleaned: None,
            processed: None,
        };
        let times = JobTimes {
            total_secs: 125.0,
            extract_secs: 3.0,
            diarize_secs: Some(20.0),
            parts: vec![
                PartTimes {
                    transcribe_secs: 30.0,
                    llm_secs: Some(40.0),
                },
                PartTimes {
                    transcribe_secs: 12.0,
                    llm_secs: Some(18.0),
                },
            ],
        };
        let meta = DocumentMeta {
            source_name: "x".into(),
            duration_secs: 1.0,
            engine: "e".into(),
            llm: None,
            created: "c".into(),
        };
        let l = labels();
        let render_with = |warnings: &[String]| {
            let notes = ProcessingNotes {
                times: &times,
                warnings,
                languages: &["en"],
            };
            let opts = DocumentOptions {
                labels: &l,
                timestamps: false,
                include_raw: false,
                notes: Some(&notes),
            };
            render_markdown(&build_blocks(&[part(5.0), part(5.0)], &meta, &opts))
        };

        let md = render_with(&[]);
        assert!(md.contains("## Замечания обработки"));
        assert!(md.contains("- Время обработки: 00:02:05"));
        assert!(md.contains("- Язык текста: en"));
        assert!(md.contains("- Определение говорящих: 00:00:20"));
        assert!(md.contains("- Распознавание: 00:00:42 (00:00:30 · 00:00:12)"));
        assert!(md.contains("- Обработка LLM: 00:00:58 (00:00:40 · 00:00:18)"));
        assert!(md.contains("- Предупреждения: нет"));

        let md = render_with(&["part 1, fragment 2: LLM error".to_string()]);
        assert!(md.contains("- Предупреждения:\n- — part 1, fragment 2: LLM error"));
        assert!(times
            .summary()
            .starts_with("total 00:02:05, extract 00:00:03"));
    }

    #[test]
    fn timed_segments_group_by_minute() {
        let segs: Vec<Segment> = (0..10)
            .map(|i| Segment {
                start_secs: i as f64 * 20.0,
                text: format!("s{i}"),
                timed: true,
                end_secs: None,
                speaker: None,
            })
            .collect();
        let paras = paragraphs_from_segments(&segs, 100.0);
        assert!(paras.len() >= 3);
        assert_eq!(paras[0].start_secs, Some(100.0));
    }
}
