//! Optional intermediate files of a job, next to the document in
//! "<name>.debug\": the text after each step (recognition, cleanup, every LLM
//! request and answer, final), so errors can be traced to the step that made
//! or missed them, and the cleaned text can be replayed in the LLM bench.

use super::document::{format_hms, Paragraph};
use log::warn;
use std::path::{Path, PathBuf};

pub struct DebugDump {
    dir: Option<PathBuf>,
}

impl DebugDump {
    /// A dump into "<document stem>.debug" beside `output`, or a no-op.
    pub fn new(output: &Path, enabled: bool) -> Self {
        let dir = enabled.then(|| {
            let stem = output
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "transcript".into());
            output.with_file_name(format!("{stem}.debug"))
        });
        let dir = dir.filter(|d| match std::fs::create_dir_all(d) {
            Ok(()) => true,
            Err(e) => {
                warn!("Cannot create the debug folder {}: {e}", d.display());
                false
            }
        });
        Self { dir }
    }

    pub fn enabled(&self) -> bool {
        self.dir.is_some()
    }

    /// Write one file; failures are logged, never fatal.
    pub fn write(&self, name: &str, content: &str) {
        if let Some(dir) = &self.dir {
            if let Err(e) = std::fs::write(dir.join(name), content) {
                warn!("Cannot write debug file {name}: {e}");
            }
        }
    }
}

/// Paragraphs as tab-separated lines: number (1-based, the LLM's line
/// number), start time, speaker (1-based), text.
pub fn paragraphs_tsv(paragraphs: &[Paragraph]) -> String {
    let mut out = String::from("n\tstart\tspeaker\ttext\n");
    for (i, p) in paragraphs.iter().enumerate() {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\n",
            i + 1,
            p.start_secs.map(format_hms).unwrap_or_default(),
            p.speaker.map(|s| (s + 1).to_string()).unwrap_or_default(),
            p.text.replace(['\t', '\n', '\r'], " ")
        ));
    }
    out
}
