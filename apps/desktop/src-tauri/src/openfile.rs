//! `.snug` open-file routing (TASK-20260812-desktop-hub-scaffold, AC4).
//!
//! macOS delivers opened files as `RunEvent::Opened` (Apple Events);
//! Windows/Linux deliver them as argv on a second instance, forwarded by
//! tauri-plugin-single-instance. Both paths funnel here.
//!
//! Security shape (P0 amendment 12): the webview may only read a file the OS
//! *actually delivered as an open event* — paths go into a single-use
//! allowlist, and `read_opened_file` serves allowlisted paths exactly once.
//! There is no generic "read any path" command. Only `.snug` / `.sqlite`
//! extensions are ever admitted; everything else is silently ignored
//! (flag-shaped and URL-shaped argv included).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct OpenedFiles(Mutex<HashSet<PathBuf>>);

fn admissible(path: &Path) -> bool {
    let ext_ok = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("snug") | Some("sqlite")
    );
    ext_ok && path.is_absolute() && path.is_file()
}

/// Filter raw candidates (argv strings or Opened URLs already converted to
/// paths) down to admissible ones, admit them to the allowlist, and return
/// what should be announced to the webview.
pub fn admit_candidates(state: &OpenedFiles, candidates: &[PathBuf]) -> Vec<PathBuf> {
    let mut admitted = Vec::new();
    let mut set = state.0.lock().unwrap();
    for path in candidates {
        if admissible(path) {
            set.insert(path.clone());
            admitted.push(path.clone());
        }
    }
    admitted
}

pub fn take_allowlisted(state: &OpenedFiles, path: &Path) -> bool {
    state.0.lock().unwrap().remove(path)
}

/// Non-consuming view of currently allowlisted paths (webview boot-time pull).
pub fn peek_all(state: &OpenedFiles) -> Vec<String> {
    state
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Single-use read of a previously admitted open-event path.
#[tauri::command]
pub fn read_opened_file(
    state: tauri::State<'_, OpenedFiles>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    if !take_allowlisted(&state, &p) {
        return Err("path was not delivered by an open event".into());
    }
    std::fs::read(&p)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("read opened file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn only_snug_like_existing_files_are_admitted_and_single_use() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("backup.snug");
        std::fs::File::create(&good).unwrap().write_all(b"x").unwrap();
        let missing = dir.path().join("ghost.snug");
        let wrong_ext = dir.path().join("evil.sh");
        std::fs::File::create(&wrong_ext).unwrap();

        let state = OpenedFiles::default();
        let admitted = admit_candidates(
            &state,
            &[
                good.clone(),
                missing,
                wrong_ext,
                PathBuf::from("--flag"),
                PathBuf::from("https://evil.example/x.snug"),
                PathBuf::from("relative.snug"),
            ],
        );
        assert_eq!(admitted, vec![good.clone()]);
        assert!(take_allowlisted(&state, &good), "first take succeeds");
        assert!(!take_allowlisted(&state, &good), "second take refused (single-use)");
    }
}
