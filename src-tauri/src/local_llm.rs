//! Built-in local LLM for post-processing ("Local (built-in)" provider).
//!
//! The bundled llama.cpp `llama-server` runs as a hidden child process on a
//! random 127.0.0.1 port and is spoken to through the same OpenAI-compatible
//! client as every other provider (`llm_client`). It is started on first use
//! and stopped after the idle timeout in `local_llm_unload_timeout`, which
//! frees all of its memory.
//!
//! It runs out of process because transcribe-cpp ships its own ggml DLLs under
//! the same names as llama.cpp's; a separate process also keeps an LLM crash
//! from taking Tishe down. On Windows the child is put in a kill-on-close job
//! object, so it dies with Tishe even if Tishe itself crashes.
//!
//! Models are optional GGUF downloads into `<app data>/llm-models/`.

use crate::hf_download::{self, Downloads, HfFile};
use crate::model_settings;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout, PostProcessProvider};
use anyhow::{anyhow, bail, Result};
use log::{info, warn};
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub const LOCAL_PROVIDER_ID: &str = "local";
pub const STATE_EVENT: &str = "local-llm-state";
pub const DOWNLOAD_EVENT: &str = "local-llm-download-progress";

// Context (8192 tokens), answer cap (3072) and temperature (0.2) are per
// model now, with the measured defaults in `model_settings` (the ⚙ window).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const WATCH_INTERVAL: Duration = Duration::from_secs(5);
const DOWNLOAD_ATTEMPTS: u32 = 6;

/// Speculative decoding ("ускоритель"): a small fast guesser proposes several
/// tokens ahead and the model checks them all in one pass. The model verifies
/// every token, so the text is exactly what it would write alone, only
/// sooner. Editing a transcript repeats most of the input word for word, which
/// is where guessing pays off most.
struct Speedup {
    /// llama-server `--spec-type`: `draft-mtp` (multi-token prediction head)
    /// or `draft-dspark` (Liquid/OpenBMB block drafter).
    kind: &'static str,
    /// Tokens guessed per step (`--spec-draft-n-max`). Starting values from
    /// the model cards, which were measured on GPUs; a CPU pays more for each
    /// rejected guess, so these still need tuning on the reference file.
    n_max: u32,
    /// Separate drafter file (`--model-draft`). `None` when the guesser is
    /// built into the model file itself (Qwen3.5 MTP builds).
    drafter: Option<HfFile>,
}

struct CatalogEntry {
    id: &'static str,
    /// Keep the files in `llm-models/<id>/` instead of `llm-models/`. The
    /// original five stay at the top level so existing downloads remain
    /// valid; newer entries need their own folder because some share file
    /// names with older ones (unsloth names its Qwen MTP and plain builds
    /// identically).
    own_folder: bool,
    model: HfFile,
    speedup: Option<Speedup>,
}

impl CatalogEntry {
    /// Every file the entry needs: the model, then its drafter, if any.
    fn files(&self) -> impl Iterator<Item = &HfFile> {
        std::iter::once(&self.model).chain(self.speedup.as_ref().and_then(|s| s.drafter.as_ref()))
    }

    fn total_size(&self) -> u64 {
        self.files().map(|f| f.size).sum()
    }
}

/// Offered models, lightest to heaviest within each group; all run on a CPU
/// with 16 GB of RAM. Names and descriptions live in the UI translations.
const CATALOG: &[CatalogEntry] = &[
    // Removed after the 2026-10-06 bench (DOCUMENTATION §9.3): Qwen3.5 2B and
    // its MTP build, and MiniCPM5 2B, returned the text unchanged; LFM2.5 2.6B
    // and 8B-A1B think despite reasoning off and drop sentences. Their files
    // stay on disk until the user deletes the folders.
    // --- Without a speedup. ---
    CatalogEntry {
        id: "qwen3.5-4b",
        own_folder: false,
        model: HfFile {
            repo: "unsloth/Qwen3.5-4B-GGUF",
            file: "Qwen3.5-4B-Q4_K_M.gguf",
            size: 2_740_937_888,
            sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        },
        speedup: None,
    },
    CatalogEntry {
        id: "gemma-4-e4b",
        own_folder: false,
        model: HfFile {
            repo: "ggml-org/gemma-4-E4B-it-GGUF",
            file: "gemma-4-E4B-it-Q4_0.gguf",
            size: 4_590_807_392,
            sha256: "a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2",
        },
        speedup: None,
    },
    CatalogEntry {
        id: "gigachat-3.1-10b-a1.8b",
        own_folder: false,
        model: HfFile {
            repo: "ai-sage/GigaChat3.1-10B-A1.8B-GGUF",
            file: "GigaChat3.1-10B-A1.8B-q4_K_M.gguf",
            size: 6_474_702_976,
            sha256: "68a8732fb5cee04f83ebffd7924e15c534d4442c5a43d2ba9e2041fe310b8deb",
        },
        speedup: None,
    },
    CatalogEntry {
        id: "qwen3.5-9b",
        own_folder: false,
        model: HfFile {
            repo: "unsloth/Qwen3.5-9B-GGUF",
            file: "Qwen3.5-9B-Q4_K_M.gguf",
            size: 5_680_522_464,
            sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        },
        speedup: None,
    },
    // Added 2026-10-13 at the owner's request (DOCUMENTATION §9.13).
    // Ruadapt: Qwen3-4B-Instruct-2507 with a Russian tokenizer and further
    // training on Russian text (RefalMachine, Apache-2.0); Russian takes about
    // half the tokens, so it writes Russian faster than plain Qwen.
    CatalogEntry {
        id: "ruadapt-qwen3-4b",
        own_folder: true,
        model: HfFile {
            repo: "RefalMachine/RuadaptQwen3-4B-Instruct-GGUF",
            file: "Q4_K_M.gguf",
            size: 2_486_507_648,
            sha256: "1abbf99e0e6d7a7cdb04888807b39da6b5993f02a6bd363aa551ed95e7e088bb",
        },
        speedup: None,
    },
    // NVIDIA Nemotron 3 Nano 4B: Mamba-2 hybrid, officially English only
    // (Russian is only in its post-training data). NVIDIA Open Model License.
    CatalogEntry {
        id: "nemotron-3-nano-4b",
        own_folder: true,
        model: HfFile {
            repo: "nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF",
            file: "NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf",
            size: 2_837_072_864,
            sha256: "be5d9a656a51922f24f1f09a759cebb694e1f5d9728bf0ef9f8c972c5a0b5ef2",
        },
        speedup: None,
    },
    // --- With a speedup (added 2026-10-06, measured on the bench). ---
    // unsloth's "-MTP" builds keep the model's own multi-token-prediction
    // head inside the file, so no drafter download is needed. They are a newer
    // quantization than the plain files above (other chat template, some
    // tensors at other precision), so their text differs too: on the bench the
    // 4B MTP fixed 7 of 21 marked errors, the plain 4B 1-3 (DOCUMENTATION §9.3).
    // The model card's GPU example uses 6 guesses.
    CatalogEntry {
        id: "qwen3.5-4b-mtp",
        own_folder: true,
        model: HfFile {
            repo: "unsloth/Qwen3.5-4B-MTP-GGUF",
            file: "Qwen3.5-4B-Q4_K_M.gguf",
            size: 2_834_975_040,
            sha256: "3874209241c9a397e2f62cd3f70f80fd2dfbf0dfccb6838416bdb48a714e8630",
        },
        speedup: Some(Speedup {
            kind: "draft-mtp",
            n_max: 3,
            drafter: None,
        }),
    },
    // Google's own QAT builds: trained to survive 4-bit quantization, so they
    // lose less quality than ordinary Q4_0 files. The drafter is Google's
    // "assistant" MTP model made for the QAT weights (Q8_0 GGUF by amaranus);
    // AtomicChat's drafter is for the non-QAT weights and would guess worse.
    // Its model card runs it with 2 guesses.
    CatalogEntry {
        id: "gemma-4-e2b-qat",
        own_folder: true,
        model: HfFile {
            repo: "google/gemma-4-E2B-it-qat-q4_0-gguf",
            file: "gemma-4-E2B_q4_0-it.gguf",
            size: 3_349_516_256,
            sha256: "fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634",
        },
        speedup: Some(Speedup {
            kind: "draft-mtp",
            n_max: 2,
            drafter: Some(HfFile {
                repo: "amaranus/Gemma-4-E2B-it-qat-assistant-MTP-Q8_0-GGUF",
                file: "gemma-4-E2B-it-qat-assistant-MTP-Q8_0.gguf",
                size: 97_835_456,
                sha256: "010aaee0a6ec999d12c8df98c2d0df0fd372fc08a6866d172aecd08135fd7836",
            }),
        }),
    },
    CatalogEntry {
        id: "gemma-4-e4b-qat",
        own_folder: true,
        model: HfFile {
            repo: "google/gemma-4-E4B-it-qat-q4_0-gguf",
            file: "gemma-4-E4B_q4_0-it.gguf",
            size: 5_154_941_280,
            sha256: "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
        },
        speedup: Some(Speedup {
            kind: "draft-mtp",
            n_max: 2,
            drafter: Some(HfFile {
                repo: "amaranus/Gemma-4-E4B-it-qat-assistant-MTP-Q8_0-GGUF",
                file: "gemma-4-E4B-it-qat-assistant-MTP-Q8_0.gguf",
                size: 98_671_040,
                sha256: "49d8367f8e1a507ef6196a7eeed790b2797bc649568f431c10bce03f574f6ffc",
            }),
        }),
    },
];

fn catalog_entry(id: &str) -> Result<&'static CatalogEntry> {
    CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| anyhow!("unknown local LLM model '{id}'"))
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct LocalLlmModelInfo {
    pub id: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Type, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LocalLlmState {
    Stopped,
    Loading,
    Ready,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct LocalLlmStatus {
    pub state: LocalLlmState,
    pub model_id: Option<String>,
    /// Whether the bundled llama-server was found.
    pub runtime_available: bool,
}

struct Server {
    child: Child,
    port: u16,
    model_id: String,
    /// What it was started with; other parameters mean a restart.
    launch: model_settings::LlmLaunch,
    #[cfg(windows)]
    _job: job::KillOnCloseJob,
}

pub struct LocalLlmManager {
    app: AppHandle,
    server: Mutex<Option<Server>>,
    /// Serialises starts so concurrent requests don't spawn two servers.
    start_lock: tokio::sync::Mutex<()>,
    loading: AtomicBool,
    /// Requests currently using the server.
    active: AtomicUsize,
    /// Set while a file queue runs, so the server survives between files.
    hold: AtomicBool,
    last_activity_ms: AtomicU64,
    downloads: Downloads,
}

/// Marks the local server as in use; dropping it records activity and, with
/// the "immediately" timeout, stops the server once nothing else needs it.
pub struct LocalLlmUse(Arc<LocalLlmManager>);

impl Drop for LocalLlmUse {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
        self.0.touch();
        self.0.maybe_stop_immediately();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl LocalLlmManager {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        let manager = Arc::new(Self {
            app: app.clone(),
            server: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            loading: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            hold: AtomicBool::new(false),
            last_activity_ms: AtomicU64::new(now_ms()),
            downloads: Downloads::default(),
        });
        let weak = Arc::downgrade(&manager);
        std::thread::spawn(move || loop {
            std::thread::sleep(WATCH_INTERVAL);
            match weak.upgrade() {
                Some(m) => m.check_idle(),
                None => break,
            }
        });
        manager
    }

    fn touch(&self) {
        self.last_activity_ms.store(now_ms(), Ordering::SeqCst);
    }

    fn timeout(&self) -> ModelUnloadTimeout {
        get_settings(&self.app).local_llm_unload_timeout
    }

    fn in_use(&self) -> bool {
        self.active.load(Ordering::SeqCst) > 0 || self.hold.load(Ordering::SeqCst)
    }

    fn check_idle(&self) {
        // Notice a server that died on its own.
        let died = {
            let mut server = self.server.lock().unwrap();
            let status = match server.as_mut() {
                None => return,
                Some(s) => s.child.try_wait(),
            };
            if let Ok(Some(status)) = status {
                warn!("Local LLM server exited unexpectedly: {status}");
                *server = None;
                true
            } else {
                false
            }
        };
        if died {
            self.emit_state();
            return;
        }
        if self.in_use() || self.loading.load(Ordering::SeqCst) {
            self.touch();
            return;
        }
        let Some(limit) = self.timeout().to_seconds() else {
            return;
        };
        let idle_ms = now_ms().saturating_sub(self.last_activity_ms.load(Ordering::SeqCst));
        if idle_ms >= limit * 1000 {
            info!("Local LLM idle for {}s; stopping it", idle_ms / 1000);
            self.stop();
        }
    }

    pub fn maybe_stop_immediately(&self) {
        if !self.in_use() && self.timeout() == ModelUnloadTimeout::Immediately {
            self.stop();
        }
    }

    /// Keep the server running across a queue of files (or release that).
    pub fn set_hold(&self, hold: bool) {
        self.hold.store(hold, Ordering::SeqCst);
        self.touch();
        if !hold {
            self.maybe_stop_immediately();
        }
    }

    /// Stop the server process, if any, releasing its memory.
    pub fn stop(&self) {
        let taken = self.server.lock().unwrap().take();
        if let Some(mut s) = taken {
            let _ = s.child.kill();
            let _ = s.child.wait();
            info!("Local LLM server stopped");
            self.emit_state();
        }
    }

    pub fn status(&self) -> LocalLlmStatus {
        let model_id = self
            .server
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.model_id.clone());
        let state = if self.loading.load(Ordering::SeqCst) {
            LocalLlmState::Loading
        } else if model_id.is_some() {
            LocalLlmState::Ready
        } else {
            LocalLlmState::Stopped
        };
        LocalLlmStatus {
            state,
            model_id,
            runtime_available: self.server_exe().is_ok(),
        }
    }

    fn emit_state(&self) {
        let _ = self.app.emit(STATE_EVENT, self.status());
    }

    fn models_dir(&self) -> Result<PathBuf> {
        Ok(crate::portable::app_data_dir(&self.app)?.join("llm-models"))
    }

    /// Folder holding an entry's files (see `CatalogEntry::own_folder`).
    fn entry_dir(&self, entry: &CatalogEntry) -> Result<PathBuf> {
        let dir = self.models_dir()?;
        Ok(if entry.own_folder {
            dir.join(entry.id)
        } else {
            dir
        })
    }

    fn model_path(&self, id: &str) -> Result<PathBuf> {
        let entry = catalog_entry(id)?;
        Ok(self.entry_dir(entry)?.join(entry.model.file))
    }

    /// Downloaded means the model and its drafter (if any) are both on disk.
    fn is_downloaded(&self, entry: &CatalogEntry) -> bool {
        self.entry_dir(entry)
            .map(|dir| entry.files().all(|f| dir.join(f.file).exists()))
            .unwrap_or(false)
    }

    fn server_exe(&self) -> Result<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(dir) = self.app.path().resource_dir() {
            candidates.push(dir.join("llama").join("llama-server.exe"));
        }
        if cfg!(debug_assertions) {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("llama-runtime")
                    .join("llama-server.exe"),
            );
        }
        candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or_else(|| anyhow!("the built-in LLM runtime (llama-server) is missing"))
    }

    /// Mark the server as in use and make sure it runs the selected model.
    /// Returns its OpenAI-compatible base URL.
    pub async fn acquire(self: &Arc<Self>) -> Result<(String, LocalLlmUse)> {
        self.active.fetch_add(1, Ordering::SeqCst);
        let guard = LocalLlmUse(self.clone());
        let url = self.ensure_running().await?;
        Ok((url, guard))
    }

    async fn ensure_running(&self) -> Result<String> {
        let _start = self.start_lock.lock().await;
        let settings = get_settings(&self.app);
        let model_id = settings
            .post_process_models
            .get(LOCAL_PROVIDER_ID)
            .cloned()
            .unwrap_or_default();
        let model_id = if catalog_entry(&model_id).is_ok() {
            model_id
        } else {
            // Nothing chosen, or a model since removed from the catalog: take
            // a downloaded one and remember it. From the end, because the
            // best-measured models (Gemma 4 E4B QAT first) are listed last.
            let Some(fallback) = CATALOG.iter().rev().find(|e| self.is_downloaded(e)) else {
                bail!(
                    "no local LLM model is selected; download one in the post-processing settings"
                );
            };
            if !model_id.is_empty() {
                warn!(
                    "Local LLM model '{model_id}' is no longer offered; using '{}'",
                    fallback.id
                );
            }
            let mut settings = settings;
            settings
                .post_process_models
                .insert(LOCAL_PROVIDER_ID.to_string(), fallback.id.to_string());
            write_settings(&self.app, settings);
            fallback.id.to_string()
        };
        let model_path = self.model_path(&model_id)?;
        if !self.is_downloaded(catalog_entry(&model_id)?) {
            bail!("the local LLM model '{model_id}' is not downloaded");
        }

        let launch = model_settings::llm_launch(&self.app, &model_id);
        {
            let mut server = self.server.lock().unwrap();
            if let Some(s) = server.as_mut() {
                // Parameters changed in the ⚙ window wait until no other
                // request shares the server, so a running job isn't cut off.
                let same_launch = s.launch == launch || self.active.load(Ordering::SeqCst) > 1;
                if s.model_id == model_id && same_launch && matches!(s.child.try_wait(), Ok(None)) {
                    self.touch();
                    return Ok(base_url(s.port));
                }
            }
        }
        self.stop();

        self.loading.store(true, Ordering::SeqCst);
        self.emit_state();
        let result = self.start_server(&model_id, &model_path, launch).await;
        self.loading.store(false, Ordering::SeqCst);
        self.touch();
        self.emit_state();
        result
    }

    async fn start_server(
        &self,
        model_id: &str,
        model_path: &PathBuf,
        launch: model_settings::LlmLaunch,
    ) -> Result<String> {
        let exe = self.server_exe()?;
        let port = std::net::TcpListener::bind("127.0.0.1:0")?
            .local_addr()?
            .port();
        let log_path = self
            .app
            .path()
            .app_log_dir()
            .map(|d| d.join("llama-server.log"))
            .unwrap_or_else(|_| std::env::temp_dir().join("tishe-llama-server.log"));
        if let Some(dir) = log_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let log = open_server_log(&log_path, model_id)?;

        let mut cmd = Command::new(&exe);
        cmd.arg("--model")
            .arg(model_path)
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["--ctx-size", &launch.context_tokens.to_string()])
            .args(["--n-predict", &launch.max_answer_tokens.to_string()])
            // Qwen3.5 and Gemma 4 think before answering by default; for
            // editing text that only costs time.
            .args(["--reasoning", "off"])
            // Editing, not writing: at the server default of 0.8 Gemma
            // invented words (a brand turned into a similar made-up word). 0.2 is the usual choice for
            // editing; repeats vary too much to prove a gain (DOCUMENTATION §5.15).
            .args(["--temp", &launch.temperature.to_string()])
            .args(["--parallel", "1", "--no-webui"])
            // The server keeps copies of past prompts in RAM (up to 8 GB by
            // default) to answer repeats faster. Every part of a file is a new
            // prompt, so the copies only take memory; the shared instruction
            // at the start is still reused from the slot (DOCUMENTATION §5.10).
            .args(["--cache-ram", "0"])
            // Reading the prompt is pure arithmetic and gains from the second
            // thread of each core; writing the answer stays on the default
            // (one thread per core). Measured on a Ryzen 5 7530U: 5–8% faster
            // per part, same edits (DOCUMENTATION §5.10).
            .args([
                "--threads-batch",
                &model_settings::logical_cpus().to_string(),
            ])
            .current_dir(exe.parent().unwrap_or(&exe))
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        let entry = catalog_entry(model_id)?;
        if let Some(speedup) = &entry.speedup {
            cmd.args(["--spec-type", speedup.kind])
                .args(["--spec-draft-n-max", &speedup.n_max.to_string()]);
            if let Some(drafter) = &speedup.drafter {
                cmd.arg("--model-draft")
                    .arg(self.entry_dir(entry)?.join(drafter.file));
            }
            // Acceptance stats (draft_n / draft_n_accepted) show up in
            // llama-server.log and in each answer's `timings`.
            info!(
                "Local LLM speedup: {} with up to {} guesses",
                speedup.kind, speedup.n_max
            );
        }
        // Without a choice in the ⚙ window the server takes one thread per core.
        if let Some(threads) = launch.threads {
            cmd.args(["--threads", &threads.to_string()]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        info!("Starting local LLM server: model={model_id}, port={port}, {launch:?}");
        let started = Instant::now();
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("failed to start the local LLM: {e}"))?;
        #[cfg(windows)]
        let job = match job::KillOnCloseJob::assign(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };

        let url = base_url(port);
        let client = reqwest::Client::new();
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                bail!(
                    "the local LLM stopped while loading ({status}); see {}",
                    log_path.display()
                );
            }
            if started.elapsed() > STARTUP_TIMEOUT {
                let _ = child.kill();
                bail!(
                    "the local LLM did not start within {}s",
                    STARTUP_TIMEOUT.as_secs()
                );
            }
            let health = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .timeout(Duration::from_secs(2))
                .send()
                .await;
            if matches!(health, Ok(r) if r.status().is_success()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        info!("Local LLM ready in {:.1}s", started.elapsed().as_secs_f64());

        *self.server.lock().unwrap() = Some(Server {
            child,
            port,
            model_id: model_id.to_string(),
            launch,
            #[cfg(windows)]
            _job: job,
        });
        Ok(url)
    }

    pub fn list_models(&self) -> Vec<LocalLlmModelInfo> {
        CATALOG
            .iter()
            .map(|e| LocalLlmModelInfo {
                id: e.id.to_string(),
                size_bytes: e.total_size(),
                downloaded: self.is_downloaded(e),
                downloading: self.downloads.is_downloading(e.id),
            })
            .collect()
    }

    /// Download a catalog model together with its drafter, if it has one.
    /// Returns false when cancelled.
    pub async fn download(&self, id: &str) -> Result<bool> {
        let entry = catalog_entry(id)?;
        let dir = self.entry_dir(entry)?;
        std::fs::create_dir_all(&dir)?;
        if self.is_downloaded(entry) {
            return Ok(true);
        }
        // The model and its drafter as one progress bar. Multi-gigabyte
        // downloads do get cut off; each retry resumes from the partial file.
        let files: Vec<&HfFile> = entry.files().collect();
        let finished = {
            let ticket = self.downloads.begin(id)?;
            hf_download::download_all(
                &files,
                &dir,
                &ticket.token,
                DOWNLOAD_ATTEMPTS,
                &self.app,
                DOWNLOAD_EVENT,
                id,
            )
            .await?
        };
        if !finished {
            return Ok(false);
        }

        info!("Local LLM model {id} downloaded");
        // Select the new model unless a usable one is already chosen, so the
        // first download works right away.
        let mut settings = get_settings(&self.app);
        let selected = settings.post_process_models.get(LOCAL_PROVIDER_ID);
        let usable = selected.is_some_and(|s| {
            catalog_entry(s)
                .map(|e| self.is_downloaded(e))
                .unwrap_or(false)
        });
        if !usable {
            settings
                .post_process_models
                .insert(LOCAL_PROVIDER_ID.to_string(), id.to_string());
            write_settings(&self.app, settings);
        }
        Ok(true)
    }

    pub fn cancel_download(&self, id: &str) {
        self.downloads.cancel(id);
    }

    pub fn delete_model(&self, id: &str) -> Result<()> {
        let entry = catalog_entry(id)?;
        let running_this = self
            .server
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|s| s.model_id == id);
        if running_this {
            if self.in_use() {
                bail!("the model is in use right now");
            }
            self.stop();
        }
        let dir = self.entry_dir(entry)?;
        for file in entry.files() {
            file.remove_from(&dir)?;
        }
        if entry.own_folder {
            // Only succeeds once the folder is empty, which is the point.
            let _ = std::fs::remove_dir(&dir);
        }
        let mut settings = get_settings(&self.app);
        if settings
            .post_process_models
            .get(LOCAL_PROVIDER_ID)
            .map(String::as_str)
            == Some(id)
        {
            let fallback = CATALOG
                .iter()
                .find(|e| e.id != id && self.is_downloaded(e))
                .map(|e| e.id.to_string())
                .unwrap_or_default();
            settings
                .post_process_models
                .insert(LOCAL_PROVIDER_ID.to_string(), fallback);
            write_settings(&self.app, settings);
        }
        Ok(())
    }
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// The server log grows across runs instead of being overwritten, so the
/// timings of earlier jobs stay readable. Past this size it starts over and
/// the previous log is kept once as `.old.log`.
const SERVER_LOG_MAX_BYTES: u64 = 5_000_000;

/// Open the server log for appending, starting each run with a header line.
fn open_server_log(path: &std::path::Path, model_id: &str) -> Result<std::fs::File> {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() > SERVER_LOG_MAX_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("old.log"));
    }
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(
        log,
        "\n===== {} · model {model_id} =====",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    )?;
    Ok(log)
}

/// For the built-in provider, start the local server and return a copy of the
/// provider pointed at it, plus a guard that keeps it marked in use. Other
/// providers pass through unchanged.
pub async fn prepare_provider(
    app: &AppHandle,
    provider: PostProcessProvider,
) -> Result<(PostProcessProvider, Option<LocalLlmUse>)> {
    if provider.id != LOCAL_PROVIDER_ID {
        return Ok((provider, None));
    }
    let manager = app
        .try_state::<Arc<LocalLlmManager>>()
        .ok_or_else(|| anyhow!("the built-in LLM is not available in this mode"))?
        .inner()
        .clone();
    let (url, guard) = manager.acquire().await?;
    Ok((
        PostProcessProvider {
            base_url: url,
            ..provider
        },
        Some(guard),
    ))
}

#[cfg(windows)]
mod job {
    use anyhow::{anyhow, Result};
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object that kills its processes when its last handle closes —
    /// including when Tishe exits or crashes.
    pub struct KillOnCloseJob(HANDLE);

    // The handle is only used to keep the job alive and to close it.
    unsafe impl Send for KillOnCloseJob {}

    impl KillOnCloseJob {
        pub fn assign(child: &Child) -> Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, None)
                    .map_err(|e| anyhow!("CreateJobObject failed: {e}"))?;
                let job = Self(job);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| anyhow!("SetInformationJobObject failed: {e}"))?;
                AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle()))
                    .map_err(|e| anyhow!("AssignProcessToJobObject failed: {e}"))?;
                Ok(job)
            }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn local_llm_list_models(app: AppHandle) -> Vec<LocalLlmModelInfo> {
    app.state::<Arc<LocalLlmManager>>().list_models()
}

/// Download a model; resolves to false if the download was cancelled.
#[tauri::command]
#[specta::specta]
pub async fn local_llm_download_model(app: AppHandle, id: String) -> Result<bool, String> {
    let manager = app.state::<Arc<LocalLlmManager>>().inner().clone();
    manager.download(&id).await.map_err(|e| {
        warn!("Local LLM download of {id} failed: {e:#}");
        format!("{e:#}")
    })
}

#[tauri::command]
#[specta::specta]
pub fn local_llm_cancel_download(app: AppHandle, id: String) {
    app.state::<Arc<LocalLlmManager>>().cancel_download(&id);
}

#[tauri::command]
#[specta::specta]
pub fn local_llm_delete_model(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<Arc<LocalLlmManager>>()
        .delete_model(&id)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
#[specta::specta]
pub fn local_llm_status(app: AppHandle) -> LocalLlmStatus {
    app.state::<Arc<LocalLlmManager>>().status()
}

/// Stop the local LLM now, freeing its memory.
#[tauri::command]
#[specta::specta]
pub fn local_llm_stop(app: AppHandle) {
    app.state::<Arc<LocalLlmManager>>().stop();
}

#[tauri::command]
#[specta::specta]
pub fn set_local_llm_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.local_llm_unload_timeout = timeout;
    write_settings(&app, settings);
    app.state::<Arc<LocalLlmManager>>().maybe_stop_immediately();
}
