//! Per-model parameters (the ⚙ «Параметры» window), kept in their own file
//! `model_settings.json` next to Handy's settings, so `settings.rs` stays as
//! upstream has it and its updates merge cleanly.
//!
//! Only values the user changed are stored. Everything else follows the
//! program's defaults, so the tuned defaults (temperature 0.2, 3000-character
//! chunks, the careful rule…) are never frozen into the file, and a later
//! change of a default reaches every model the user didn't touch.

use crate::file_transcription::language::{self, Lang};
use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;

const FILE_NAME: &str = "model_settings.json";

/// Defaults of the built-in LLM, measured on the bench (DOCUMENTATION §5.10,
/// §5.15, §9.3).
pub const LLM_TEMPERATURE: f32 = 0.2;
pub const LLM_CHUNK_CHARS: u32 = 3_000;
pub const LLM_CONTEXT_TOKENS: u32 = 8_192;
/// A model looping on a chunk stops here instead of filling the context.
pub const LLM_MAX_ANSWER_TOKENS: u32 = 3_072;
/// Longest speech segment for local recognition of files, seconds. 12–25 s
/// beat 60–120 s on punctuation (DOCUMENTATION §5.4).
pub const ASR_SEGMENT_MAX_SECS: u32 = 25;
pub const ASR_SEGMENT_MIN_SECS: u32 = 12;

/// What the user changed for one built-in LLM model; `None` is the default.
#[derive(Serialize, Deserialize, Type, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct LlmModelSettings {
    pub prompt_ru: Option<String>,
    pub prompt_en: Option<String>,
    pub temperature: Option<f32>,
    pub chunk_chars: Option<u32>,
    pub context_tokens: Option<u32>,
    pub max_answer_tokens: Option<u32>,
    /// Threads for writing the answer; `None` lets the server use one per core.
    pub threads: Option<u32>,
}

/// The values a model gets when the user changed nothing. The window shows
/// these instead of empty fields.
#[derive(Serialize, Type, Clone, Debug)]
pub struct LlmModelDefaults {
    pub prompt_ru: String,
    pub prompt_en: String,
    pub temperature: f32,
    pub chunk_chars: u32,
    pub context_tokens: u32,
    pub max_answer_tokens: u32,
    /// Hardware threads, the top of the thread choice.
    pub max_threads: u32,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct LlmModelSettingsView {
    pub settings: LlmModelSettings,
    pub defaults: LlmModelDefaults,
}

/// What the user changed for one speech recognition model.
#[derive(Serialize, Deserialize, Type, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct AsrModelSettings {
    /// Longest segment when recognizing files locally, seconds.
    pub segment_max_secs: Option<u32>,
    /// Run on the processor even when the general setting allows a GPU.
    pub cpu_only: Option<bool>,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct AsrModelDefaults {
    pub segment_max_secs: u32,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct AsrModelSettingsView {
    pub settings: AsrModelSettings,
    pub defaults: AsrModelDefaults,
    /// The engine can choose a device for this model (transcribe-cpp models;
    /// ONNX ones follow the general accelerator setting only).
    pub device_choice: bool,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct Store {
    llm: BTreeMap<String, LlmModelSettings>,
    asr: BTreeMap<String, AsrModelSettings>,
}

/// Serialises read-modify-write of the file.
static LOCK: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .ok()
        .map(|d| d.join(FILE_NAME))
}

fn load(app: &AppHandle) -> Store {
    let Some(path) = path(app) else {
        return Store::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            warn!("{} is unreadable, using defaults: {e}", path.display());
            Store::default()
        }),
        Err(_) => Store::default(),
    }
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = path(app).ok_or("no app data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // Write aside and rename, so a crash never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn logical_cpus() -> u32 {
    std::thread::available_parallelism().map_or(4, |n| n.get() as u32)
}

pub fn llm_defaults(model_id: &str) -> LlmModelDefaults {
    LlmModelDefaults {
        prompt_ru: language::default_prompt_for(Lang::Ru, model_id),
        prompt_en: language::default_prompt_for(Lang::En, model_id),
        temperature: LLM_TEMPERATURE,
        chunk_chars: LLM_CHUNK_CHARS,
        context_tokens: LLM_CONTEXT_TOKENS,
        max_answer_tokens: LLM_MAX_ANSWER_TOKENS,
        max_threads: logical_cpus(),
    }
}

pub fn llm(app: &AppHandle, model_id: &str) -> LlmModelSettings {
    load(app).llm.get(model_id).cloned().unwrap_or_default()
}

pub fn asr(app: &AppHandle, model_id: &str) -> AsrModelSettings {
    load(app).asr.get(model_id).cloned().unwrap_or_default()
}

/// Launch parameters of the built-in LLM server for a model. A server
/// running with other ones is restarted before its next job.
#[derive(Clone, Debug, PartialEq)]
pub struct LlmLaunch {
    pub temperature: f32,
    pub context_tokens: u32,
    pub max_answer_tokens: u32,
    pub threads: Option<u32>,
}

pub fn llm_launch(app: &AppHandle, model_id: &str) -> LlmLaunch {
    let s = llm(app, model_id);
    LlmLaunch {
        temperature: s.temperature.unwrap_or(LLM_TEMPERATURE),
        context_tokens: s.context_tokens.unwrap_or(LLM_CONTEXT_TOKENS),
        max_answer_tokens: s.max_answer_tokens.unwrap_or(LLM_MAX_ANSWER_TOKENS),
        threads: s.threads,
    }
}

pub fn llm_chunk_chars(app: &AppHandle, model_id: &str) -> usize {
    llm(app, model_id).chunk_chars.unwrap_or(LLM_CHUNK_CHARS) as usize
}

/// The instruction a built-in model gets for text in `lang`: the user's own
/// for Russian and English if they wrote one, otherwise the built-in.
pub fn llm_prompt(app: &AppHandle, model_id: &str, lang: Lang) -> String {
    let s = llm(app, model_id);
    let own = match lang {
        Lang::Ru => s.prompt_ru,
        Lang::En => s.prompt_en,
        Lang::Other(_) => None,
    };
    own.filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| language::default_prompt_for(lang, model_id))
}

/// `Some(v)` only when `v` differs from the default, so a value set back to
/// the default is stored as "default" again.
fn changed<T: PartialEq>(v: Option<T>, default: T) -> Option<T> {
    v.filter(|v| *v != default)
}

/// Check and tidy what the window sends: out-of-range numbers are refused
/// with a message, values equal to the default are dropped.
fn normalize_llm(model_id: &str, s: LlmModelSettings) -> Result<LlmModelSettings, String> {
    let d = llm_defaults(model_id);
    let in_range = |name: &str, v: Option<u32>, lo: u32, hi: u32| match v {
        Some(v) if !(lo..=hi).contains(&v) => Err(format!("{name}: {lo}–{hi}")),
        _ => Ok(()),
    };
    in_range("chunk_chars", s.chunk_chars, 1_000, 8_000)?;
    in_range("context_tokens", s.context_tokens, 4_096, 32_768)?;
    in_range("max_answer_tokens", s.max_answer_tokens, 512, 8_192)?;
    in_range("threads", s.threads, 1, d.max_threads)?;
    if let Some(t) = s.temperature {
        if !(0.0..=1.5).contains(&t) {
            return Err("temperature: 0–1.5".into());
        }
    }
    // The context holds the instruction, the chunk (~2 characters a token in
    // Russian) and the answer.
    let context = s.context_tokens.unwrap_or(d.context_tokens);
    let answer = s.max_answer_tokens.unwrap_or(d.max_answer_tokens);
    let chunk = s.chunk_chars.unwrap_or(d.chunk_chars);
    // The window translates this code (`context_too_small:<minimum>`).
    if context < answer + chunk / 2 + 1_024 {
        return Err(format!("context_too_small:{}", answer + chunk / 2 + 1_024));
    }
    let prompt = |p: Option<String>, default: &str| {
        p.map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty() && p != default.trim())
    };
    Ok(LlmModelSettings {
        prompt_ru: prompt(s.prompt_ru, &d.prompt_ru),
        prompt_en: prompt(s.prompt_en, &d.prompt_en),
        temperature: changed(
            s.temperature.map(|t| (t * 100.0).round() / 100.0),
            d.temperature,
        ),
        chunk_chars: changed(s.chunk_chars, d.chunk_chars),
        context_tokens: changed(s.context_tokens, d.context_tokens),
        max_answer_tokens: changed(s.max_answer_tokens, d.max_answer_tokens),
        threads: s.threads,
    })
}

fn normalize_asr(s: AsrModelSettings) -> Result<AsrModelSettings, String> {
    if let Some(v) = s.segment_max_secs {
        if !(ASR_SEGMENT_MIN_SECS..=30).contains(&v) {
            return Err(format!("segment_max_secs: {ASR_SEGMENT_MIN_SECS}–30"));
        }
    }
    Ok(AsrModelSettings {
        segment_max_secs: changed(s.segment_max_secs, ASR_SEGMENT_MAX_SECS),
        cpu_only: changed(s.cpu_only, false),
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_llm_model_settings(app: AppHandle, model_id: String) -> LlmModelSettingsView {
    LlmModelSettingsView {
        settings: llm(&app, &model_id),
        defaults: llm_defaults(&model_id),
    }
}

/// Save a model's parameters; `None` fields go back to the default. The
/// built-in LLM picks up launch parameters at its next start (a running one
/// is restarted before the next job that doesn't share it).
#[tauri::command]
#[specta::specta]
pub fn set_llm_model_settings(
    app: AppHandle,
    model_id: String,
    settings: LlmModelSettings,
) -> Result<LlmModelSettingsView, String> {
    let settings = normalize_llm(&model_id, settings)?;
    let _lock = LOCK.lock().unwrap();
    let mut store = load(&app);
    if settings == LlmModelSettings::default() {
        store.llm.remove(&model_id);
    } else {
        store.llm.insert(model_id.clone(), settings);
    }
    save(&app, &store)?;
    Ok(LlmModelSettingsView {
        settings: store.llm.get(&model_id).cloned().unwrap_or_default(),
        defaults: llm_defaults(&model_id),
    })
}

#[tauri::command]
#[specta::specta]
pub fn get_asr_model_settings(app: AppHandle, model_id: String) -> AsrModelSettingsView {
    asr_view(&app, &model_id, asr(&app, &model_id))
}

fn asr_view(app: &AppHandle, model_id: &str, settings: AsrModelSettings) -> AsrModelSettingsView {
    use tauri::Manager;
    let device_choice = app
        .try_state::<std::sync::Arc<crate::managers::model::ModelManager>>()
        .and_then(|mm| mm.get_model_info(model_id))
        .is_some_and(|m| {
            matches!(
                m.engine_type,
                crate::managers::model::EngineType::TranscribeCpp
            )
        });
    AsrModelSettingsView {
        settings,
        defaults: AsrModelDefaults {
            segment_max_secs: ASR_SEGMENT_MAX_SECS,
        },
        device_choice,
    }
}

/// Save a speech model's parameters. A device change reloads the model the
/// next time it is used.
#[tauri::command]
#[specta::specta]
pub fn set_asr_model_settings(
    app: AppHandle,
    model_id: String,
    settings: AsrModelSettings,
) -> Result<AsrModelSettingsView, String> {
    let settings = normalize_asr(settings)?;
    let device_changed = {
        let _lock = LOCK.lock().unwrap();
        let mut store = load(&app);
        let before = store.asr.get(&model_id).cloned().unwrap_or_default();
        if settings == AsrModelSettings::default() {
            store.asr.remove(&model_id);
        } else {
            store.asr.insert(model_id.clone(), settings.clone());
        }
        save(&app, &store)?;
        before.cpu_only != settings.cpu_only
    };
    if device_changed {
        use tauri::Manager;
        if let Some(tm) =
            app.try_state::<std::sync::Arc<crate::managers::transcription::TranscriptionManager>>()
        {
            if tm.get_current_model().as_deref() == Some(model_id.as_str()) {
                tm.reload_model_on_next_use();
            }
        }
    }
    Ok(asr_view(&app, &model_id, settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_tuned_values_and_never_stored() {
        let d = llm_defaults("gemma-4-e4b-qat");
        assert_eq!(d.temperature, 0.2);
        assert_eq!(d.chunk_chars, 3_000);
        assert_eq!(d.context_tokens, 8_192);
        assert_eq!(d.max_answer_tokens, 3_072);
        // The window shows the real built-in text, with the careful rule.
        assert!(d.prompt_ru.ends_with("Числа оставляй цифрами."));
        assert!(!d.prompt_en.is_empty());
        assert!(!llm_defaults("gemma-4-e2b-qat")
            .prompt_ru
            .contains("Числа оставляй цифрами."));
        // Sending the defaults back stores nothing.
        let same = LlmModelSettings {
            prompt_ru: Some(format!("  {}\n", d.prompt_ru)),
            prompt_en: Some(d.prompt_en.clone()),
            temperature: Some(0.2),
            chunk_chars: Some(3_000),
            context_tokens: Some(8_192),
            max_answer_tokens: Some(3_072),
            threads: None,
        };
        assert_eq!(
            normalize_llm("gemma-4-e4b-qat", same).unwrap(),
            LlmModelSettings::default()
        );
        assert_eq!(
            normalize_asr(AsrModelSettings {
                segment_max_secs: Some(25),
                cpu_only: Some(false)
            })
            .unwrap(),
            AsrModelSettings::default()
        );
    }

    #[test]
    fn changes_are_kept_and_bad_values_refused() {
        let s = normalize_llm(
            "gemma-4-e4b-qat",
            LlmModelSettings {
                prompt_ru: Some("Своя инструкция.".into()),
                temperature: Some(0.5),
                chunk_chars: Some(2_000),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.prompt_ru.as_deref(), Some("Своя инструкция."));
        assert_eq!(s.temperature, Some(0.5));
        assert_eq!(s.chunk_chars, Some(2_000));
        assert_eq!(s.prompt_en, None);
        // An emptied field means "built-in", not an empty instruction.
        let empty = LlmModelSettings {
            prompt_ru: Some("   ".into()),
            ..Default::default()
        };
        assert_eq!(normalize_llm("x", empty).unwrap().prompt_ru, None);
        let too_big = LlmModelSettings {
            chunk_chars: Some(20_000),
            ..Default::default()
        };
        assert!(normalize_llm("x", too_big).is_err());
        // The context must hold the chunk and the answer.
        let cramped = LlmModelSettings {
            context_tokens: Some(4_096),
            max_answer_tokens: Some(4_096),
            ..Default::default()
        };
        assert!(normalize_llm("x", cramped).is_err());
        assert!(normalize_asr(AsrModelSettings {
            segment_max_secs: Some(60),
            cpu_only: None
        })
        .is_err());
    }

    #[test]
    fn old_or_partial_files_still_load() {
        let store: Store =
            serde_json::from_str(r#"{"llm":{"m":{"temperature":0.3}},"future":1}"#).unwrap();
        assert_eq!(store.llm["m"].temperature, Some(0.3));
        assert_eq!(store.llm["m"].chunk_chars, None);
        assert!(store.asr.is_empty());
    }
}
