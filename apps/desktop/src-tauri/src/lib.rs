//! Snug desktop shell (TASK-20260812-desktop-hub-scaffold).
//!
//! The shell adds capability, never policy: persistence commands scoped to
//! `~/Snug`, single-use reads of OS-delivered open events, the loopback OAuth
//! listener (tauri-plugin-oauth), native fetch (tauri-plugin-http), and the
//! system-browser opener. All security policy (C1 credential custody, host
//! ceilings, C2 sandbox) stays in the TS packages, unchanged.

mod exportfile;
mod openfile;
mod userfile;

use openfile::OpenedFiles;
use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// Announce admitted open-event files to the webview. The payload carries only
/// paths; bytes flow later through the single-use `read_opened_file` command.
fn announce_opened(app: &tauri::AppHandle, candidates: Vec<PathBuf>) {
    let state = app.state::<OpenedFiles>();
    let admitted = openfile::admit_candidates(&state, &candidates);
    if admitted.is_empty() {
        return;
    }
    let paths: Vec<String> = admitted
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // Best-effort: if the webview isn't listening yet it will query on boot
    // via the `pending_opened_files` command.
    let _ = app.emit("snug:opened-files", paths);
}

/// Boot-time pull for files that arrived before the webview registered its
/// listener (cold start via double-click). Returns paths still allowlisted.
#[tauri::command]
fn pending_opened_files(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    openfile::peek_all(&state)
}

fn argv_candidates(argv: &[String]) -> Vec<PathBuf> {
    // Skip argv[0]; openfile::admit_candidates re-checks extension/existence,
    // so this only needs to be a cheap shape filter.
    argv.iter().skip(1).map(PathBuf::from).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance on Windows/Linux forwards its argv (may carry a
            // .snug path); focus the existing window either way.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            announce_opened(app, argv_candidates(&argv));
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenedFiles::default())
        .invoke_handler(tauri::generate_handler![
            userfile::read_user_file,
            userfile::write_user_file,
            openfile::read_opened_file,
            exportfile::export_user_bytes,
            pending_opened_files,
        ])
        .setup(|app| {
            // Cold-start argv (Windows/Linux file association).
            let args: Vec<String> = std::env::args().collect();
            announce_opened(app.handle(), argv_candidates(&args));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building snug desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                // macOS file association: file:// URLs via Apple Events.
                let candidates: Vec<PathBuf> =
                    urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
                announce_opened(app, candidates);
            }
        });
}
