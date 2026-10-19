//! Optional downloads for speaker diarization, kept in
//! `<app data>/diarization-models/`.
//!
//! Each offered model is a voice-fingerprint (speaker embedding) model; the
//! small pyannote segmentation model they all share is fetched along with the
//! first one.

use crate::hf_download::{self, Downloads, HfFile};
use anyhow::{anyhow, bail, Result};
use log::info;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub const DOWNLOAD_EVENT: &str = "diarization-download-progress";
const DOWNLOAD_ATTEMPTS: u32 = 4;

const SEGMENTATION: HfFile = HfFile {
    repo: "csukuangfj/sherpa-onnx-pyannote-segmentation-3-0",
    file: "model.onnx",
    size: 5_992_913,
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
};

struct CatalogEntry {
    id: &'static str,
    model: HfFile,
}

/// Offered fingerprint models. Names and descriptions live in the UI
/// translations.
const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "wespeaker-resnet34",
        model: HfFile {
            repo: "csukuangfj/speaker-embedding-models",
            file: "wespeaker_en_voxceleb_resnet34.onnx",
            size: 26_534_365,
            sha256: "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
        },
    },
    CatalogEntry {
        id: "3dspeaker-eres2net",
        model: HfFile {
            repo: "csukuangfj/speaker-embedding-models",
            file: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
            size: 39_593_761,
            sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
        },
    },
];

fn catalog_entry(id: &str) -> Result<&'static CatalogEntry> {
    CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| anyhow!("unknown speaker model '{id}'"))
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct DiarizationModelInfo {
    pub id: String,
    /// What is still left to download for this model (includes the shared
    /// segmentation model while it is missing).
    pub size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
}

/// Paths of a ready-to-run model pair.
pub struct ModelPaths {
    pub segmentation: PathBuf,
    pub embedding: PathBuf,
}

pub struct DiarizationModels {
    app: AppHandle,
    downloads: Downloads,
}

impl DiarizationModels {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            downloads: Downloads::default(),
        })
    }

    fn dir(&self) -> Result<PathBuf> {
        Ok(crate::portable::app_data_dir(&self.app)?.join("diarization-models"))
    }

    fn has(&self, file: &HfFile) -> bool {
        self.dir()
            .map(|d| d.join(file.file).exists())
            .unwrap_or(false)
    }

    pub fn list(&self) -> Vec<DiarizationModelInfo> {
        let seg_missing = if self.has(&SEGMENTATION) {
            0
        } else {
            SEGMENTATION.size
        };
        CATALOG
            .iter()
            .map(|e| {
                let downloaded = self.has(&e.model) && seg_missing == 0;
                DiarizationModelInfo {
                    id: e.id.to_string(),
                    size_bytes: if downloaded {
                        e.model.size + SEGMENTATION.size
                    } else {
                        e.model.size * u64::from(!self.has(&e.model)) + seg_missing
                    },
                    downloaded,
                    downloading: self.downloads.is_downloading(e.id),
                }
            })
            .collect()
    }

    /// Paths for `id`, or an error telling the user to download it.
    pub fn paths(&self, id: &str) -> Result<ModelPaths> {
        let entry = catalog_entry(id)?;
        let dir = self.dir()?;
        let paths = ModelPaths {
            segmentation: dir.join(SEGMENTATION.file),
            embedding: dir.join(entry.model.file),
        };
        if !paths.segmentation.exists() || !paths.embedding.exists() {
            bail!("the speaker model is not downloaded; download it in the speakers section");
        }
        Ok(paths)
    }

    /// Download `id` (and the shared segmentation model). Returns false when
    /// cancelled.
    pub async fn download(&self, id: &str) -> Result<bool> {
        let entry = catalog_entry(id)?;
        let ticket = self.downloads.begin(id)?;
        let dir = self.dir()?;
        std::fs::create_dir_all(&dir)?;
        // One progress bar over what is missing: the shared segmentation
        // model may already be here from another fingerprint model.
        let files: Vec<&HfFile> = [&SEGMENTATION, &entry.model]
            .into_iter()
            .filter(|f| !dir.join(f.file).exists())
            .collect();
        let finished = hf_download::download_all(
            &files,
            &dir,
            &ticket.token,
            DOWNLOAD_ATTEMPTS,
            &self.app,
            DOWNLOAD_EVENT,
            id,
        )
        .await?;
        if finished {
            info!("Speaker model {id} downloaded");
        }
        Ok(finished)
    }

    pub fn cancel_download(&self, id: &str) {
        self.downloads.cancel(id);
    }

    /// Delete a fingerprint model; the shared segmentation model goes with
    /// the last one.
    pub fn delete(&self, id: &str) -> Result<()> {
        let entry = catalog_entry(id)?;
        let dir = self.dir()?;
        let mut files = vec![&entry.model];
        if !CATALOG
            .iter()
            .any(|e| e.id != id && dir.join(e.model.file).exists())
        {
            files.push(&SEGMENTATION);
        }
        for file in files {
            file.remove_from(&dir)?;
        }
        Ok(())
    }
}

fn manager(app: &AppHandle) -> Arc<DiarizationModels> {
    app.state::<Arc<DiarizationModels>>().inner().clone()
}

#[tauri::command]
#[specta::specta]
pub fn diarization_list_models(app: AppHandle) -> Vec<DiarizationModelInfo> {
    manager(&app).list()
}

#[tauri::command]
#[specta::specta]
pub async fn diarization_download_model(app: AppHandle, id: String) -> Result<bool, String> {
    manager(&app)
        .download(&id)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
#[specta::specta]
pub fn diarization_cancel_download(app: AppHandle, id: String) {
    manager(&app).cancel_download(&id);
}

#[tauri::command]
#[specta::specta]
pub fn diarization_delete_model(app: AppHandle, id: String) -> Result<(), String> {
    manager(&app).delete(&id).map_err(|e| format!("{e:#}"))
}
