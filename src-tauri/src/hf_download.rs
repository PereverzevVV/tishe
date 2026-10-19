//! Tishe: optional model downloads from Hugging Face, shared by the built-in
//! LLM (`local_llm`) and speaker diarization (`file_transcription::diarize`).
//!
//! Each file is pinned by size and SHA-256 and goes through Handy's resumable
//! downloader into `<file>.partial`; a dropped connection is retried a few
//! times, each retry resuming from the partial file.

use crate::managers::model::{
    DownloadProgress, HttpDownloadEvent, HttpDownloadOutcome, ModelManager,
};
use anyhow::{bail, Result};
use hf_hub::api::tokio::CancellationToken;
use log::warn;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Pause before a retry.
const RETRY_DELAY: Duration = if cfg!(test) {
    Duration::from_millis(10)
} else {
    Duration::from_secs(3)
};

/// A file in a Hugging Face repository, pinned by size and SHA-256.
pub struct HfFile {
    pub repo: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

impl HfFile {
    fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/main/{}",
            self.repo, self.file
        )
    }

    fn partial_path(&self, dir: &Path) -> PathBuf {
        dir.join(format!("{}.partial", self.file))
    }

    /// Delete this file and its unfinished download from `dir`, if present.
    pub fn remove_from(&self, dir: &Path) -> Result<()> {
        for path in [dir.join(self.file), self.partial_path(dir)] {
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
}

fn emit_progress(app: &AppHandle, event: &str, model_id: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        event,
        DownloadProgress {
            model_id: model_id.to_string(),
            downloaded,
            total,
            percentage: downloaded as f64 * 100.0 / total.max(1) as f64,
        },
    );
}

/// Download the `files` of one model into `dir` (each up to `attempts`
/// tries), as one progress bar on `event`: files already on disk count as
/// done, and the bar ends with a 100 % event. Returns false when cancelled;
/// a cancel also removes the unfinished file, since it means "not now" and
/// should not leave gigabytes behind.
pub async fn download_all(
    files: &[&HfFile],
    dir: &Path,
    token: &CancellationToken,
    attempts: u32,
    app: &AppHandle,
    event: &str,
    model_id: &str,
) -> Result<bool> {
    let total: u64 = files.iter().map(|f| f.size).sum();
    let mut done = 0;
    for file in files {
        if !dir.join(file.file).exists() {
            let offset = done;
            let finished = download_from(&file.url(), file, dir, token, attempts, model_id, |n| {
                emit_progress(app, event, model_id, offset + n, total)
            })
            .await?;
            if !finished {
                return Ok(false);
            }
        }
        done += file.size;
    }
    emit_progress(app, event, model_id, total, total);
    Ok(true)
}

/// One file from an explicit URL; `on_progress` gets this file's bytes.
async fn download_from(
    url: &str,
    file: &HfFile,
    dir: &Path,
    token: &CancellationToken,
    attempts: u32,
    model_id: &str,
    on_progress: impl Fn(u64) + Send + Sync,
) -> Result<bool> {
    let partial = file.partial_path(dir);
    let emit = move |event: HttpDownloadEvent<'_>| {
        if let HttpDownloadEvent::Progress(p) = event {
            on_progress(p.downloaded);
        }
    };
    let mut attempt = 1;
    let outcome = loop {
        let result = ModelManager::download_http_resumable_with_events(
            model_id,
            url,
            &partial,
            Some(file.size),
            Some(file.sha256),
            token,
            &emit,
        )
        .await;
        match result {
            Err(e) if attempt < attempts && !token.is_cancelled() => {
                warn!(
                    "Download of {} for {model_id} failed (attempt {attempt}): {e:#}; retrying",
                    file.file
                );
                attempt += 1;
                tokio::time::sleep(RETRY_DELAY).await;
            }
            other => break other,
        }
    };
    match outcome? {
        HttpDownloadOutcome::Completed => {
            std::fs::rename(&partial, dir.join(file.file))?;
            Ok(true)
        }
        HttpDownloadOutcome::Cancelled => {
            let _ = std::fs::remove_file(&partial);
            Ok(false)
        }
    }
}

/// Downloads in progress, by model id, with their cancel tokens.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, CancellationToken>>);

impl Downloads {
    /// The map, also after a panic elsewhere left the lock poisoned: it only
    /// holds tokens, so its contents stay valid.
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a download of `id`; it stays registered until the returned
    /// ticket is dropped.
    pub fn begin(&self, id: &str) -> Result<DownloadTicket<'_>> {
        let token = CancellationToken::new();
        let mut map = self.map();
        if map.contains_key(id) {
            bail!("this model is already downloading");
        }
        map.insert(id.to_string(), token.clone());
        Ok(DownloadTicket {
            downloads: self,
            id: id.to_string(),
            token,
        })
    }

    pub fn is_downloading(&self, id: &str) -> bool {
        self.map().contains_key(id)
    }

    pub fn cancel(&self, id: &str) {
        if let Some(token) = self.map().get(id) {
            token.cancel();
        }
    }
}

/// A registered download; dropping it (also on an error or a panic) removes
/// the registration. The same idea as `DownloadCleanup` in Handy's
/// `managers/model.rs`, which also updates its own model list.
pub struct DownloadTicket<'a> {
    downloads: &'a Downloads,
    id: String,
    pub token: CancellationToken,
}

impl Drop for DownloadTicket<'_> {
    fn drop(&mut self) {
        self.downloads.map().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const BODY: &[u8] = b"model bytes for the shared downloader";

    fn test_file() -> HfFile {
        // The hash must outlive the test: leak one small string.
        let sha = format!("{:x}", Sha256::digest(BODY));
        HfFile {
            repo: "test/repo",
            file: "model.bin",
            size: BODY.len() as u64,
            sha256: Box::leak(sha.into_boxed_str()),
        }
    }

    /// Serve the given status codes, one connection each; 200 sends `BODY`.
    async fn serve(statuses: Vec<u16>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        tokio::spawn(async move {
            for status in statuses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let response = if status == 200 {
                    let mut r = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        BODY.len()
                    )
                    .into_bytes();
                    r.extend_from_slice(BODY);
                    r
                } else {
                    format!(
                        "HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .into_bytes()
                };
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
            }
        });
        url
    }

    #[tokio::test]
    async fn downloads_verifies_and_renames() {
        let dir = tempfile::tempdir().unwrap();
        let url = serve(vec![200]).await;
        let seen = Arc::new(AtomicU64::new(0));
        let s = seen.clone();
        let file = test_file();
        let done = download_from(
            &url,
            &file,
            dir.path(),
            &CancellationToken::new(),
            1,
            "m",
            move |n| s.store(n, Ordering::SeqCst),
        )
        .await
        .unwrap();
        assert!(done);
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), BODY);
        assert!(!dir.path().join("model.bin.partial").exists());
        assert_eq!(seen.load(Ordering::SeqCst), BODY.len() as u64);
    }

    #[tokio::test]
    async fn retries_after_a_server_error() {
        let dir = tempfile::tempdir().unwrap();
        let url = serve(vec![500, 200]).await;
        let file = test_file();
        let done = download_from(
            &url,
            &file,
            dir.path(),
            &CancellationToken::new(),
            2,
            "m",
            |_| {},
        )
        .await
        .unwrap();
        assert!(done);
        assert!(dir.path().join("model.bin").exists());
    }

    #[tokio::test]
    async fn gives_up_after_the_last_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let url = serve(vec![500, 500]).await;
        let file = test_file();
        let result = download_from(
            &url,
            &file,
            dir.path(),
            &CancellationToken::new(),
            2,
            "m",
            |_| {},
        )
        .await;
        assert!(result.is_err());
        assert!(!dir.path().join("model.bin").exists());
    }

    #[tokio::test]
    async fn cancel_removes_the_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("model.bin.partial"), b"model").unwrap();
        // A server that accepts and never answers; the cancel comes while
        // the download waits for headers.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let token = CancellationToken::new();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        });
        let file = test_file();
        let done = download_from(&url, &file, dir.path(), &token, 3, "m", |_| {})
            .await
            .unwrap();
        assert!(!done);
        assert!(!dir.path().join("model.bin.partial").exists());
        assert!(!dir.path().join("model.bin").exists());
    }

    #[test]
    fn ticket_registers_until_dropped() {
        let downloads = Downloads::default();
        let ticket = downloads.begin("a").unwrap();
        assert!(downloads.is_downloading("a"));
        assert!(downloads.begin("a").is_err());
        downloads.cancel("a");
        assert!(ticket.token.is_cancelled());
        drop(ticket);
        assert!(!downloads.is_downloading("a"));
        assert!(downloads.begin("a").is_ok());
    }
}
