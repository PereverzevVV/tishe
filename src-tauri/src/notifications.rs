//! Windows notifications for file transcription (Tishe;
//! UX_INTERACTION_ARCHITECTURE «Уведомления Windows», CF6, S16).
//!
//! - Only for file transcription: «готово» and «ошибка» once per queue, and
//!   the one-time «работаю в фоне» when the window is closed during a run.
//!   Dictation has the overlay.
//! - Only while the window is hidden, minimized or not in focus: a visible
//!   window already shows the result row.
//! - A click on the notification shows the window on «Расшифровка» at the
//!   target row (event `notification-activated`); the «Открыть» button opens
//!   the document.
//!
//! Toasts are built with WinRT from the `windows` crate, so there is no extra
//! dependency. The click handler lives in this process: a notification clicked
//! in the Action Center after the program has quit does nothing.

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

/// Sent to the window when a notification is clicked.
#[derive(Clone, Serialize, Type)]
pub struct NotificationActivated {
    /// Queue row to reveal, if the notification was about one.
    pub target: Option<String>,
}

/// The main window is on screen and in focus.
pub fn window_in_view(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| {
            w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
                && w.is_focused().unwrap_or(false)
        })
        .unwrap_or(false)
}

/// End of a transcription queue. The window composes the text (it knows the
/// files and the language); here it is shown if the setting allows and the
/// window is out of view. Returns whether a notification was shown.
#[tauri::command]
#[specta::specta]
pub fn notify_file_queue(
    app: AppHandle,
    title: String,
    body: String,
    open_path: Option<String>,
    open_label: Option<String>,
    target: Option<String>,
) -> bool {
    if !crate::settings::get_settings(&app).transcription_notifications {
        return false;
    }
    if window_in_view(&app) {
        return false;
    }
    let action = match (open_path, open_label) {
        (Some(path), Some(label)) => Some((label, format!("open:{path}"))),
        _ => None,
    };
    let launch = format!("target:{}", target.unwrap_or_default());
    show(&app, &title, &body, &launch, action)
}

/// «Tishe работает в фоне…»: once in the program's life, when the window is
/// closed while a transcription runs (the tray icon is often hidden by
/// Windows, so without it closing the window looks like quitting).
pub fn notify_background_once(app: &AppHandle) {
    let mut settings = crate::settings::get_settings(app);
    if settings.background_notice_shown || !settings.transcription_notifications {
        return;
    }
    let strings = crate::tray_i18n::get_tray_translations(Some(settings.app_language.clone()));
    let english = crate::tray_i18n::get_tray_translations(Some("en".to_string()));
    let pick = |s: &str, en: &str| {
        if s.is_empty() {
            en.to_string()
        } else {
            s.to_string()
        }
    };
    let title = pick(&strings.background_title, &english.background_title);
    let body = pick(&strings.background_body, &english.background_body);
    if show(app, &title, &body, "target:", None) {
        settings.background_notice_shown = true;
        crate::settings::write_settings(app, settings);
    }
}

fn activated(app: &AppHandle, arguments: &str) {
    log::info!("Notification activated: {arguments:?}");
    if let Some(path) = arguments.strip_prefix("open:") {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_path(path, None::<String>) {
            log::error!("Failed to open {path} from a notification: {e}");
        }
        return;
    }
    let target = arguments
        .strip_prefix("target:")
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    crate::show_main_window(app);
    let _ = app.emit("notification-activated", NotificationActivated { target });
}

#[cfg(target_os = "windows")]
fn show(
    app: &AppHandle,
    title: &str,
    body: &str,
    launch: &str,
    action: Option<(String, String)>,
) -> bool {
    match windows_toast::show(app, title, body, launch, action) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Windows notification failed: {e}");
            false
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn show(
    _app: &AppHandle,
    _title: &str,
    _body: &str,
    _launch: &str,
    _action: Option<(String, String)>,
) -> bool {
    false
}

#[cfg(target_os = "windows")]
mod windows_toast {
    use super::activated;
    use std::sync::Mutex;
    use tauri::AppHandle;
    use windows::core::{Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    };

    /// The installer gives the Start menu shortcut this id, which is what
    /// shows «Tishe» and its icon on the notification. A dev build has no
    /// shortcut, so it borrows PowerShell's id (as tauri-plugin-notification
    /// does).
    fn app_id(app: &AppHandle) -> String {
        if cfg!(debug_assertions) {
            "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
                .to_string()
        } else {
            app.config().identifier.clone()
        }
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// The last toast stays referenced so its click handler outlives this call.
    static LAST: Mutex<Option<ToastNotification>> = Mutex::new(None);

    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        launch: &str,
        action: Option<(String, String)>,
    ) -> windows::core::Result<()> {
        let actions = action
            .map(|(label, args)| {
                format!(
                    r#"<actions><action content="{}" arguments="{}" activationType="foreground"/></actions>"#,
                    escape(&label),
                    escape(&args)
                )
            })
            .unwrap_or_default();
        let xml = format!(
            r#"<toast launch="{}" activationType="foreground"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{}</toast>"#,
            escape(launch),
            escape(title),
            escape(body),
            actions
        );
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        let handle = app.clone();
        toast.Activated(&TypedEventHandler::<
            ToastNotification,
            windows::core::IInspectable,
        >::new(move |_, args| {
            let arguments = args
                .as_ref()
                .and_then(|a| a.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|a| a.Arguments().ok())
                .map(|h| h.to_string())
                .unwrap_or_default();
            activated(&handle, &arguments);
            Ok(())
        }))?;
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id(app)))?;
        notifier.Show(&toast)?;
        log::info!("Notification shown: {title}");
        if let Ok(mut last) = LAST.lock() {
            *last = Some(toast);
        }
        Ok(())
    }
}
