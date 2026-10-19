//! Tishe: one-time move of user data from the previous app identifier.
//!
//! Until the public release Tishe ran as `com.handyplus.app` (from its
//! "Handy Plus" days). Tauri derives every data folder from the identifier,
//! so after the switch the settings, history, recordings, downloaded models,
//! logs and the window's own storage would all look empty. On the first start
//! with the new identifier each old folder is moved to the new place by
//! renaming (same drive, so multi-gigabyte models move instantly).
//!
//! Rules (DOCUMENTATION §5.25):
//! - The old folder is renamed as a whole when the new one does not exist yet
//!   (the usual case for the data folder: nothing has created it before
//!   `setup`). Otherwise its entries are moved one by one and folders merge.
//! - A locked file (a lingering WebView2 or antivirus process) is retried for
//!   a couple of seconds. Whatever still fails stays in the old folder, and
//!   the old folder existing is what makes the next start try again.
//! - On a name clash the user's old data wins: the file the new build created
//!   meanwhile (an empty history after a failed first attempt) is set aside as
//!   `<name>.replaced-<unix time>`. If that file is open (the log the current
//!   start writes to), the old one is kept beside it as `previous-<name>`.
//!   Nothing is ever deleted or overwritten.
//!
//! Windows only in practice: on macOS the web view's storage lives outside
//! these folders and would not move. Portable installs keep their data next
//! to the exe and are skipped.

use log::{info, warn};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Identifier of builds before the public release.
pub const OLD_IDENTIFIER: &str = "com.handyplus.app";
/// The release identifier (`tauri.conf.json`). Builds run under any other
/// identifier — e.g. a dev build with `com.handyplus.dev` — never migrate:
/// they must not take the installed app's data.
const RELEASE_IDENTIFIER: &str = "io.github.pereverzevvv.tishe";

pub fn run(app: &AppHandle) {
    let identifier = &app.config().identifier;
    if identifier != RELEASE_IDENTIFIER || crate::portable::data_dir().is_some() {
        return;
    }
    let path = app.path();
    let Ok(data_dir) = path.app_data_dir() else {
        return;
    };
    // Roaming: settings, history, recordings, models. Local: WebView2 storage
    // (EBWebView) and, on Windows, the logs folder inside it.
    let mut dirs = vec![data_dir.clone()];
    for dir in [path.app_local_data_dir(), path.app_log_dir()]
        .into_iter()
        .flatten()
    {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    let mut data_moved = false;
    for new_dir in dirs {
        let Some(old_dir) = old_sibling(&new_dir, identifier) else {
            continue;
        };
        if !old_dir.is_dir() {
            continue;
        }
        let moved = move_entry(&old_dir, &new_dir);
        info!(
            "Moved {moved} item(s) of user data from {} to {}",
            old_dir.display(),
            new_dir.display()
        );
        if new_dir == data_dir && moved > 0 {
            data_moved = true;
        }
        if old_dir.exists() {
            warn!(
                "Some user data is still in {}; the move is retried on the next start",
                old_dir.display()
            );
        }
    }
    if data_moved {
        if let Some(old_dir) = old_sibling(&data_dir, identifier) {
            rewrite_paths_in_settings(&data_dir, &old_dir);
        }
    }
}

/// The folder the old identifier used in place of `new_dir`: the same path
/// with the path component equal to the new identifier replaced. `None` when
/// the path does not contain the identifier (nothing to migrate).
fn old_sibling(new_dir: &Path, identifier: &str) -> Option<PathBuf> {
    if identifier == OLD_IDENTIFIER {
        return None;
    }
    let mut found = false;
    let old: PathBuf = new_dir
        .components()
        .map(|c| {
            if c.as_os_str() == identifier {
                found = true;
                std::ffi::OsStr::new(OLD_IDENTIFIER)
            } else {
                c.as_os_str()
            }
        })
        .collect();
    found.then_some(old)
}

/// Move `src` (file or folder) to `dst` by the rules in the module comment.
/// Returns how many entries were moved; never fails, problems are logged.
fn move_entry(src: &Path, dst: &Path) -> usize {
    if !dst.exists() {
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        return match rename_with_retry(src, dst) {
            Ok(()) => 1,
            // A folder that cannot move as a whole may still move piece by
            // piece (one locked file inside blocks renaming the folder).
            Err(_) if src.is_dir() && fs::create_dir_all(dst).is_ok() => merge_dir(src, dst),
            Err(e) => {
                warn!("Could not move {}: {e}", src.display());
                0
            }
        };
    }
    if src.is_dir() && dst.is_dir() {
        return merge_dir(src, dst);
    }
    // Name clash: the old data wins, the newer file is set aside.
    let mut aside = dst.as_os_str().to_owned();
    aside.push(format!(".replaced-{}", unix_time()));
    if fs::rename(dst, &aside).is_ok() {
        return match rename_with_retry(src, dst) {
            Ok(()) => 1,
            Err(e) => {
                // Put the new file back so the app keeps a working copy.
                let _ = fs::rename(&aside, dst);
                warn!("Could not move {}: {e}", src.display());
                0
            }
        };
    }
    // The new file is open (the current log): keep the old one beside it.
    let Some(name) = dst.file_name() else {
        return 0;
    };
    let mut previous = std::ffi::OsString::from("previous-");
    previous.push(name);
    let previous = dst.with_file_name(previous);
    if previous.exists() {
        return 0;
    }
    match rename_with_retry(src, &previous) {
        Ok(()) => 1,
        Err(e) => {
            warn!("Could not move {}: {e}", src.display());
            0
        }
    }
}

fn merge_dir(src: &Path, dst: &Path) -> usize {
    let entries = match fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("Could not read {}: {e}", src.display());
            return 0;
        }
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        moved += move_entry(&entry.path(), &dst.join(entry.file_name()));
    }
    // Remove the emptied folder (fails, as it should, if something stayed).
    let _ = fs::remove_dir(src);
    moved
}

/// Files can stay locked for a moment after the old build exits (WebView2
/// helper processes, antivirus scans); try for about two seconds.
fn rename_with_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            // Access denied (5), sharing (32) and lock (33) violations.
            Err(e)
                if attempt < 8
                    && (e.kind() == std::io::ErrorKind::PermissionDenied
                        || matches!(e.raw_os_error(), Some(5 | 32 | 33))) =>
            {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => return Err(e),
        }
    }
}

fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Settings may hold absolute paths inside the old data folder (e.g. a model
/// the user picked from there). Point them at the new folder.
fn rewrite_paths_in_settings(data_dir: &Path, old_dir: &Path) {
    let file = data_dir.join(crate::settings::SETTINGS_STORE_PATH);
    let Ok(text) = fs::read_to_string(&file) else {
        return;
    };
    // Paths are stored as JSON strings, so backslashes are escaped.
    let escape = |p: &Path| p.to_string_lossy().replace('\\', "\\\\");
    let (old, new) = (escape(old_dir), escape(data_dir));
    if !text.contains(&old) {
        return;
    }
    let tmp = file.with_extension("json.migrating");
    let result = fs::write(&tmp, text.replace(&old, &new)).and_then(|_| fs::rename(&tmp, &file));
    match result {
        Ok(()) => info!("Updated paths in {} to the new data folder", file.display()),
        Err(e) => warn!("Could not update paths in {}: {e}", file.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("tishe-migration-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn release_identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], RELEASE_IDENTIFIER);
    }

    #[test]
    fn old_sibling_replaces_only_the_identifier_component() {
        let new_dir = Path::new("/home/u/.local/share/io.github.pereverzevvv.tishe/logs");
        assert_eq!(
            old_sibling(new_dir, "io.github.pereverzevvv.tishe").unwrap(),
            Path::new("/home/u/.local/share/com.handyplus.app/logs")
        );
        assert!(old_sibling(Path::new("/tmp/other"), "io.github.pereverzevvv.tishe").is_none());
        assert!(old_sibling(new_dir, OLD_IDENTIFIER).is_none());
    }

    #[test]
    fn whole_folder_moves_when_the_new_one_does_not_exist() {
        let root = temp_root("whole");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("models")).unwrap();
        fs::write(old.join("history.db"), "history").unwrap();
        fs::write(old.join("models").join("a.bin"), "model").unwrap();

        assert_eq!(move_entry(&old, &new), 1);

        assert!(!old.exists());
        assert_eq!(
            fs::read_to_string(new.join("history.db")).unwrap(),
            "history"
        );
        assert!(new.join("models").join("a.bin").is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn old_data_wins_over_files_created_after_a_failed_attempt() {
        let root = temp_root("merge");
        let (old, new) = (root.join("old"), root.join("new"));
        for dir in [
            old.join("models"),
            old.join("logs"),
            new.join("logs"),
            new.join("models"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(old.join("history.db"), "real history").unwrap();
        fs::write(old.join("models").join("a.bin"), "model").unwrap();
        fs::write(old.join("logs").join("handy.1.log"), "older log").unwrap();
        // Created by a start whose move failed: an empty history, a fresh
        // download.
        fs::write(new.join("history.db"), "empty").unwrap();
        fs::write(new.join("models").join("b.bin"), "new model").unwrap();

        let moved = move_entry(&old, &new);

        assert_eq!(moved, 3); // history.db, a.bin, handy.1.log
        assert!(!old.exists());
        assert_eq!(
            fs::read_to_string(new.join("history.db")).unwrap(),
            "real history"
        );
        let replaced: Vec<_> = fs::read_dir(&new)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("history.db.replaced-")
            })
            .collect();
        assert_eq!(replaced.len(), 1);
        assert_eq!(fs::read_to_string(replaced[0].path()).unwrap(), "empty");
        assert!(new.join("models").join("a.bin").is_file());
        assert!(new.join("models").join("b.bin").is_file());
        assert!(new.join("logs").join("handy.1.log").is_file());
        fs::remove_dir_all(&root).unwrap();
    }
}
