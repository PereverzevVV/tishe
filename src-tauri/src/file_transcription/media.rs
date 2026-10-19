//! ffmpeg-backed media handling: pulls the audio track out of any audio/video
//! container (mp3, m4a, mp4, mkv, webm, …) into a raw 16 kHz mono s16le PCM
//! file, then serves sample ranges from it. The raw file makes the rest of the
//! pipeline container-agnostic — browser-recorded webm often has no duration
//! and no seek index, so seeking in the original is not reliable.

use anyhow::{anyhow, bail, Context, Result};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

pub const SAMPLE_RATE: usize = 16_000;

#[cfg(windows)]
const FFMPEG_EXE: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_EXE: &str = "ffmpeg";

/// Locate ffmpeg: the LGPL build the installer puts in `ffmpeg\` next to
/// the Tishe executable (`scripts/fetch-ffmpeg.ps1`) wins, then a copy right
/// next to the executable, otherwise whatever is on PATH or from winget.
pub fn find_ffmpeg() -> Result<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for bundled in [dir.join("ffmpeg").join(FFMPEG_EXE), dir.join(FFMPEG_EXE)] {
                if bundled.is_file() {
                    return Ok(bundled);
                }
            }
        }
    }

    let probe = command(Path::new(FFMPEG_EXE))
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if matches!(probe, Ok(status) if status.success()) {
        return Ok(PathBuf::from(FFMPEG_EXE));
    }

    #[cfg(windows)]
    if let Some(path) = find_winget_ffmpeg() {
        return Ok(path);
    }

    bail!("ffmpeg not found: it is neither bundled with Tishe nor available on PATH")
}

/// `winget install Gyan.FFmpeg` only updates PATH for processes started after
/// the install, so look in its package folder directly as well.
#[cfg(windows)]
fn find_winget_ffmpeg() -> Option<PathBuf> {
    let packages = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Microsoft")
        .join("WinGet")
        .join("Packages");
    std::fs::read_dir(packages)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("Gyan.FFmpeg"))
        .flat_map(|pkg| {
            std::fs::read_dir(pkg.path())
                .into_iter()
                .flatten()
                .flatten()
        })
        .map(|build| build.path().join("bin").join(FFMPEG_EXE))
        .find(|p| p.is_file())
}

/// A `Command` that never flashes a console window on Windows.
fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Result of a quick `ffmpeg -i` probe.
pub struct ProbeInfo {
    /// Container duration, when the header carries one (webm from browsers
    /// usually does not).
    pub duration_secs: Option<f64>,
}

pub fn probe(ffmpeg: &Path, input: &Path) -> Result<ProbeInfo> {
    // `ffmpeg -i x` with no output exits non-zero by design; the stream
    // listing we need is on stderr either way.
    let output = command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(input)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("failed to run ffmpeg")?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    if stderr.contains("No such file or directory") {
        bail!("input file not found: {}", input.display());
    }
    if !stderr
        .lines()
        .any(|l| l.contains("Stream #") && l.contains("Audio:"))
    {
        bail!("the file has no audio track (or ffmpeg cannot read it)");
    }

    let duration_secs = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration: "))
        .and_then(|rest| rest.split(',').next())
        .and_then(parse_timestamp);

    Ok(ProbeInfo { duration_secs })
}

/// Parse `HH:MM:SS.ss`; returns `None` for `N/A`.
fn parse_timestamp(s: &str) -> Option<f64> {
    let mut parts = s.trim().split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Kills the child on drop so a cancelled or failed job never leaves ffmpeg
/// running in the background.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Decode the first audio track of `input` into `out_pcm` as 16 kHz mono s16le.
/// `on_progress` receives the decoded position in seconds.
pub fn extract_pcm(
    ffmpeg: &Path,
    input: &Path,
    out_pcm: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<()> {
    let child = command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .args([
            "-vn",
            "-sn",
            "-dn",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .arg(out_pcm)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start ffmpeg")?;
    let mut guard = ChildGuard(child);

    // Drain stderr on its own thread so a chatty decoder can't fill the pipe
    // and deadlock us while we read progress from stdout.
    let mut stderr = guard.0.stderr.take().expect("stderr piped");
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });

    let stdout = guard.0.stdout.take().expect("stdout piped");
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            bail!(super::CANCELLED);
        }
        let Ok(line) = line else { break };
        if let Some(us) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = us.trim().parse::<i64>() {
                on_progress(us.max(0) as f64 / 1_000_000.0);
            }
        }
    }

    let status = guard.0.wait().context("ffmpeg did not exit cleanly")?;
    let stderr_text = stderr_reader.join().unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        bail!(super::CANCELLED);
    }
    if !status.success() {
        let tail: Vec<&str> = stderr_text.lines().rev().take(5).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        bail!("ffmpeg failed to extract audio: {}", tail.join(" | "));
    }
    Ok(())
}

/// Encode a sample range of the raw PCM file as a compact mono MP3 for upload
/// to a cloud transcription API (48 kbps keeps 29 min around 10 MB, under the
/// common 25 MB request limit).
pub fn encode_mp3_range(
    ffmpeg: &Path,
    pcm: &Path,
    start_sample: usize,
    end_sample: usize,
    out_mp3: &Path,
) -> Result<()> {
    let start = start_sample as f64 / SAMPLE_RATE as f64;
    let dur = (end_sample - start_sample) as f64 / SAMPLE_RATE as f64;
    let output = command(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
        .args(["-f", "s16le", "-ar", "16000", "-ac", "1"])
        .args(["-ss", &format!("{start:.3}"), "-t", &format!("{dur:.3}")])
        .arg("-i")
        .arg(pcm)
        .args(["-c:a", "libmp3lame", "-b:a", "48k"])
        .arg(out_mp3)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("failed to run ffmpeg")?;
    if !output.status.success() {
        bail!(
            "ffmpeg failed to encode the part: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Random access to the raw 16 kHz mono s16le file produced by [`extract_pcm`].
pub struct PcmFile {
    file: File,
    len: usize,
}

impl PcmFile {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).context("failed to open extracted audio")?;
        let bytes = file.metadata()?.len() as usize;
        Ok(Self {
            file,
            len: bytes / 2,
        })
    }

    /// Total number of samples.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Read samples `[start, end)` as f32 in `[-1, 1]`.
    pub fn read(&mut self, start: usize, end: usize) -> Result<Vec<f32>> {
        let end = end.min(self.len);
        if start >= end {
            return Ok(Vec::new());
        }
        self.file
            .seek(SeekFrom::Start(start as u64 * 2))
            .map_err(|e| anyhow!("seek failed: {e}"))?;
        let mut bytes = vec![0u8; (end - start) * 2];
        self.file
            .read_exact(&mut bytes)
            .context("failed to read extracted audio")?;
        Ok(bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b) as f32 / i16::MAX as f32)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_timestamps() {
        assert_eq!(parse_timestamp("01:02:03.50"), Some(3723.5));
        assert_eq!(parse_timestamp("N/A"), None);
    }

    /// Release checklist «Г»: every file in a folder goes through the same
    /// steps a queue job starts with — probe, extraction to PCM, one MP3 part.
    /// Files named `bad-*` (video without sound, broken file) must fail with
    /// an error; every other file must decode to its container duration.
    /// Run with `TISHE_MEDIA_DIR=<folder> cargo test --lib media_formats --
    /// --ignored --nocapture` (DOCUMENTATION §8).
    #[test]
    #[ignore]
    fn media_formats() {
        let dir = PathBuf::from(std::env::var("TISHE_MEDIA_DIR").expect("TISHE_MEDIA_DIR"));
        let ffmpeg = find_ffmpeg().expect("ffmpeg");
        let out = std::env::temp_dir().join(format!("tishe-media-formats-{}", std::process::id()));
        std::fs::create_dir_all(&out).unwrap();
        let no_cancel = AtomicBool::new(false);
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no files in {}", dir.display());
        let mut failures = Vec::new();
        for (i, input) in files.iter().enumerate() {
            let name = input.file_name().unwrap().to_string_lossy().to_string();
            let expect_error = name.starts_with("bad-");
            let started = std::time::Instant::now();
            let pcm_path = out.join(format!("{i}.pcm"));
            let result = probe(&ffmpeg, input).and_then(|info| {
                extract_pcm(&ffmpeg, input, &pcm_path, &no_cancel, |_| {})?;
                let pcm = PcmFile::open(&pcm_path)?;
                let secs = pcm.len() as f64 / SAMPLE_RATE as f64;
                anyhow::ensure!(secs > 0.0, "decoded no audio");
                if let Some(d) = info.duration_secs {
                    // A video stream may run a little past the audio.
                    anyhow::ensure!(
                        (secs - d).abs() < 2.0_f64.max(d * 0.005),
                        "decoded {secs:.1} s, container says {d:.1} s"
                    );
                }
                let mp3 = out.join(format!("{i}.mp3"));
                encode_mp3_range(&ffmpeg, &pcm_path, 0, pcm.len().min(60 * SAMPLE_RATE), &mp3)?;
                anyhow::ensure!(std::fs::metadata(&mp3)?.len() > 0, "empty MP3 part");
                Ok((info.duration_secs, secs))
            });
            let took = started.elapsed().as_secs_f64();
            match (&result, expect_error) {
                (Ok((d, secs)), false) => {
                    println!("ok    {name}: container {d:?} s, decoded {secs:.1} s, {took:.1} s")
                }
                (Err(e), true) => println!("ok    {name}: error as expected: {e:#}"),
                (Ok(_), true) => failures.push(format!("{name}: expected an error, got audio")),
                (Err(e), false) => failures.push(format!("{name}: {e:#}")),
            }
        }
        let _ = std::fs::remove_dir_all(&out);
        assert!(failures.is_empty(), "failed:\n{}", failures.join("\n"));
    }
}
