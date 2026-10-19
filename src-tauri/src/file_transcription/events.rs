//! Optional event script: a program the user picks on the File tab. It is run
//! once per job event with a single line of JSON on stdin, so any other app
//! (a status widget, a notification, a phone push) can follow a long job.
//!
//! The script can never slow a job down or break it: every run happens on a
//! worker thread, a run that takes too long is killed, and failures only reach
//! the log. Progress is throttled; start/finish/failure events always go out.

use super::{FileTranscriptionResult, FileTranscriptionStage};
use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Bumped only on breaking changes; new fields may appear in any version.
pub const PROTOCOL_VERSION: u32 = 1;
/// A configured progress interval is clamped to this range (seconds).
const PROGRESS_INTERVAL_RANGE: std::ops::RangeInclusive<u32> = 1..=600;
/// A script still running after this is killed.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
/// Remaining time is only estimated once the job is far enough along for the
/// rate to mean something.
const ETA_MIN_FRACTION: f64 = 0.15;
const ETA_MIN_ELAPSED: Duration = Duration::from_secs(30);

/// Texts for the `message` field, supplied by the UI so they follow the app
/// language. `{part}`, `{total}` and `{minutes}` are filled in here.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EventLabels {
    pub extracting: String,
    pub diarizing: String,
    pub splitting: String,
    pub transcribing: String,
    pub transcribing_part: String,
    pub post_processing: String,
    pub post_processing_part: String,
    pub writing: String,
    pub remaining: String,
    pub started: String,
    pub finished: String,
    pub cancelled: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EventScriptOptions {
    /// Path to the program, `.ps1`, `.bat` or `.cmd` file.
    pub script: String,
    /// Minimum seconds between progress events; clamped to 1..=600.
    pub progress_interval_secs: u32,
    pub labels: EventLabels,
}

/// One line of the protocol. See DOCUMENTATION.md §7.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Event {
    version: u32,
    app: &'static str,
    event: &'static str,
    job_id: String,
    file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<FileTranscriptionStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    part: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_parts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fraction: Option<f64>,
    elapsed_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_secs: Option<u64>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    characters: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Event {
    fn new(event: &'static str) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            app: "tishe",
            event,
            ..Default::default()
        }
    }

    fn is_progress(&self) -> bool {
        self.event == "progress"
    }
}

/// Sends a job's events to the event script. Cheap to clone; a sink without a
/// script does nothing.
#[derive(Clone)]
pub struct EventSink(Option<Arc<Inner>>);

struct Inner {
    tx: mpsc::Sender<Event>,
    labels: EventLabels,
    job_id: String,
    file: String,
    started: Instant,
    interval: Duration,
    /// Stage/part key and time of the last progress event sent.
    last: Mutex<Option<(String, Instant)>>,
}

impl EventSink {
    pub fn new(options: Option<&EventScriptOptions>, file: &str) -> Self {
        let Some(options) = options.filter(|o| !o.script.trim().is_empty()) else {
            return Self(None);
        };
        let (tx, rx) = mpsc::channel::<Event>();
        let script = options.script.trim().to_string();
        std::thread::spawn(move || deliver(&script, rx));
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        Self(Some(Arc::new(Inner {
            tx,
            labels: options.labels.clone(),
            job_id: format!("{stamp}-{}", std::process::id()),
            file: file.to_string(),
            started: Instant::now(),
            interval: Duration::from_secs(u64::from(options.progress_interval_secs.clamp(
                *PROGRESS_INTERVAL_RANGE.start(),
                *PROGRESS_INTERVAL_RANGE.end(),
            ))),
            last: Mutex::new(None),
        })))
    }

    pub fn started(&self) {
        self.send("started", |e, l| e.message = l.started.clone());
    }

    pub fn progress(&self, stage: FileTranscriptionStage, part: u32, total: u32, fraction: f64) {
        let Some(inner) = &self.0 else { return };
        let key = format!("{stage:?}/{part}");
        {
            let mut last = inner.last.lock().unwrap();
            let due = match &*last {
                Some((k, at)) => *k != key || at.elapsed() >= inner.interval,
                None => true,
            };
            if !due {
                return;
            }
            *last = Some((key, Instant::now()));
        }
        let elapsed = inner.started.elapsed();
        let eta = estimate_remaining(elapsed, fraction);
        let mut e = self.base("progress", inner);
        e.message = progress_message(&inner.labels, &stage, part, total, fraction, eta);
        e.stage = Some(stage);
        e.part = Some(part);
        e.total_parts = Some(total);
        e.fraction = Some(fraction);
        e.eta_secs = eta.map(|d| d.as_secs());
        let _ = inner.tx.send(e);
    }

    pub fn finished(&self, result: &FileTranscriptionResult) {
        self.send("finished", |e, l| {
            e.message = l.finished.clone();
            e.fraction = Some(1.0);
            e.output_path = Some(result.output_path.clone());
            e.characters = Some(result.characters);
            e.warnings = Some(result.warnings.clone());
        });
    }

    pub fn failed(&self, error: &str) {
        self.send("failed", |e, _| {
            e.message = error.to_string();
            e.error = Some(error.to_string());
        });
    }

    pub fn cancelled(&self) {
        self.send("cancelled", |e, l| e.message = l.cancelled.clone());
    }

    fn send(&self, event: &'static str, fill: impl FnOnce(&mut Event, &EventLabels)) {
        let Some(inner) = &self.0 else { return };
        let mut e = self.base(event, inner);
        fill(&mut e, &inner.labels);
        let _ = inner.tx.send(e);
    }

    fn base(&self, event: &'static str, inner: &Inner) -> Event {
        let mut e = Event::new(event);
        e.job_id = inner.job_id.clone();
        e.file = inner.file.clone();
        e.elapsed_secs = inner.started.elapsed().as_secs();
        e
    }
}

/// Worker: runs the script once per event, in order. Progress that piled up
/// behind a slow script collapses to the newest one; lifecycle events are
/// never dropped. Ends once the job's sink is gone and the queue is empty.
fn deliver(script: &str, rx: mpsc::Receiver<Event>) {
    while let Ok(mut event) = rx.recv() {
        while let Ok(next) = rx.try_recv() {
            if !event.is_progress() {
                run_logged(script, &event);
            }
            event = next;
        }
        run_logged(script, &event);
    }
}

fn run_logged(script: &str, event: &Event) {
    let Ok(line) = serde_json::to_string(event) else {
        return;
    };
    if let Err(e) = run_script(script, &line) {
        warn!("Event script ({} event): {e}", event.event);
    }
}

/// Run the script once with `payload` on stdin. Used by the worker and by the
/// "Test" button, which shows the error to the user.
pub fn run_script(script: &str, payload: &str) -> Result<(), String> {
    let path = Path::new(script.trim());
    if !path.is_file() {
        return Err(format!("script not found: {}", path.display()));
    }
    let mut child = command_for(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", path.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A script that ignores stdin may exit before reading it; that's fine.
        let _ = stdin.write_all(payload.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("exited with {status}")),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("killed after {}s", SCRIPT_TIMEOUT.as_secs()));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// `.ps1` goes through PowerShell; everything else (exe, bat, cmd, or an
/// executable script on Linux/macOS) is started directly. Never shows a
/// console window on Windows.
fn command_for(path: &Path) -> Command {
    let is_ps1 = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ps1"));
    #[allow(unused_mut)]
    let mut cmd = if is_ps1 {
        let shell = if cfg!(windows) { "powershell" } else { "pwsh" };
        let mut c = Command::new(shell);
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(path);
        c
    } else {
        Command::new(path)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn estimate_remaining(elapsed: Duration, fraction: f64) -> Option<Duration> {
    if fraction < ETA_MIN_FRACTION || fraction >= 1.0 || elapsed < ETA_MIN_ELAPSED {
        return None;
    }
    Some(elapsed.mul_f64((1.0 - fraction) / fraction))
}

fn progress_message(
    labels: &EventLabels,
    stage: &FileTranscriptionStage,
    part: u32,
    total: u32,
    fraction: f64,
    eta: Option<Duration>,
) -> String {
    use FileTranscriptionStage::*;
    let multi = total > 1 && part > 0;
    let template = match stage {
        Extracting => &labels.extracting,
        Diarizing => &labels.diarizing,
        Splitting => &labels.splitting,
        Transcribing if multi => &labels.transcribing_part,
        Transcribing => &labels.transcribing,
        PostProcessing if multi => &labels.post_processing_part,
        PostProcessing => &labels.post_processing,
        Writing => &labels.writing,
    };
    let stage_text = template
        .replace("{part}", &part.to_string())
        .replace("{total}", &total.to_string());
    // UI stage texts end with "…", which reads oddly before " · 47%".
    let mut out = format!(
        "{} · {}%",
        stage_text.trim_end_matches(['…', '.', ' ']),
        (fraction.clamp(0.0, 1.0) * 100.0).round()
    );
    if let Some(eta) = eta {
        let minutes = eta.as_secs().div_ceil(60).max(1);
        out.push_str(" · ");
        out.push_str(&labels.remaining.replace("{minutes}", &minutes.to_string()));
    }
    out
}

/// "Test" button on the File tab: sends one `test` event and reports whether
/// the script ran.
#[tauri::command]
#[specta::specta]
pub async fn send_test_file_event(script: String, message: String) -> Result<(), String> {
    let mut e = Event::new("test");
    e.job_id = "test".into();
    e.message = message;
    let line = serde_json::to_string(&e).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || run_script(&script, &line))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> EventLabels {
        EventLabels {
            extracting: "Извлечение звука…".into(),
            diarizing: "Говорящие…".into(),
            splitting: "Нарезка…".into(),
            transcribing: "Распознавание…".into(),
            transcribing_part: "Распознавание: часть {part} из {total}…".into(),
            post_processing: "LLM…".into(),
            post_processing_part: "LLM: часть {part} из {total}…".into(),
            writing: "Сохранение…".into(),
            remaining: "~{minutes} мин".into(),
            started: "Начало".into(),
            finished: "Готово".into(),
            cancelled: "Отменено".into(),
        }
    }

    #[test]
    fn message_has_stage_percent_and_eta() {
        let m = progress_message(
            &labels(),
            &FileTranscriptionStage::Transcribing,
            2,
            3,
            0.474,
            Some(Duration::from_secs(661)),
        );
        assert_eq!(m, "Распознавание: часть 2 из 3 · 47% · ~12 мин");
        let single = progress_message(
            &labels(),
            &FileTranscriptionStage::Transcribing,
            1,
            1,
            0.5,
            None,
        );
        assert_eq!(single, "Распознавание · 50%");
    }

    #[test]
    fn eta_waits_for_enough_progress() {
        assert!(estimate_remaining(Duration::from_secs(10), 0.5).is_none());
        assert!(estimate_remaining(Duration::from_secs(100), 0.1).is_none());
        assert_eq!(
            estimate_remaining(Duration::from_secs(300), 0.25),
            Some(Duration::from_secs(900))
        );
    }

    #[test]
    fn progress_is_throttled_but_stage_changes_pass() {
        let (tx, rx) = mpsc::channel();
        let sink = EventSink(Some(Arc::new(Inner {
            tx,
            labels: labels(),
            job_id: "j".into(),
            file: "f".into(),
            started: Instant::now(),
            interval: Duration::from_secs(10),
            last: Mutex::new(None),
        })));
        use FileTranscriptionStage::*;
        sink.progress(Transcribing, 1, 2, 0.20);
        sink.progress(Transcribing, 1, 2, 0.21); // same part, too soon
        sink.progress(Transcribing, 2, 2, 0.50); // new part
        sink.finished(&FileTranscriptionResult {
            output_path: "o".into(),
            duration_secs: 1.0,
            parts: 2,
            characters: 3,
            warnings: vec![],
        });
        let events: Vec<_> = rx.try_iter().map(|e| (e.event, e.part)).collect();
        assert_eq!(
            events,
            vec![
                ("progress", Some(1)),
                ("progress", Some(2)),
                ("finished", None)
            ]
        );
    }

    #[test]
    fn event_serializes_without_empty_fields() {
        let mut e = Event::new("started");
        e.job_id = "j".into();
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.starts_with(r#"{"version":1,"app":"tishe","event":"started""#));
        assert!(!json.contains("stage"));
    }
}
