//! Snug desktop shell (TASK-20260812-desktop-hub-scaffold).
//!
//! The shell adds capability, never policy: persistence commands scoped to
//! `~/Snug`, single-use reads of OS-delivered open events, the loopback OAuth
//! listener (tauri-plugin-oauth), native fetch (tauri-plugin-http), and the
//! system-browser opener. All security policy (C1 credential custody, host
//! ceilings, C2 sandbox) stays in the TS packages, unchanged.

mod exportfile;
/// In-shell hard-gate commands (P4). Debug builds only — a release binary
/// carries neither the commands nor their strings (P0 amendment 4).
#[cfg(debug_assertions)]
mod gate;
mod openfile;
mod userfile;

use openfile::OpenedFiles;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

// --------------------------------------------------------------- close flush
//
// ADR-0021 §5. Desktop persistence rides a 250ms write-back debounce, so the
// LAST mutation before a window close could not survive it: the webview is torn
// down with the pending write still queued. `pagehide` (the web path's backstop)
// is not a reliable close signal in a native shell.
//
// The handshake: CloseRequested -> prevent_close + emit `snug:close-flush` ->
// the webview awaits `userDb.flush()` -> `close_flush_done` -> close for real.
// It is TIME-BOXED: a hung or crashed webview must never trap the user in an
// unclosable window, so the close proceeds anyway after the deadline. Losing the
// last debounced write is bad; an app that cannot be quit is worse.

/// How long the shell waits for the webview's flush before closing regardless.
const CLOSE_FLUSH_DEADLINE_MS: u64 = 3_000;

/// Set once the flush handshake is underway (or has been abandoned): the second
/// close request must pass straight through rather than re-arming the wait.
static CLOSING: AtomicBool = AtomicBool::new(false);

/// The webview reports its flush finished (or failed — either way it is done and
/// the window may close). Idempotent: a late call after the deadline is a no-op
/// because the window is already gone.
#[tauri::command]
fn close_flush_done(window: tauri::Window) {
    CLOSING.store(true, Ordering::SeqCst);
    let _ = window.destroy();
}

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
    let builder = tauri::Builder::default()
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
        .manage(OpenedFiles::default());
    // The gate commands exist in DEBUG builds only (P4/AC7). The handler list
    // is duplicated under cfg rather than stubbed: a release binary must not
    // contain the command names even as registered no-ops.
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        userfile::read_user_file,
        userfile::write_user_file,
        openfile::read_opened_file,
        exportfile::export_user_bytes,
        pending_opened_files,
        close_flush_done,
        gate::shell_gate_config,
        gate::write_gate_results,
        gate::gate_ipc_sentinel_exists,
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        userfile::read_user_file,
        userfile::write_user_file,
        openfile::read_opened_file,
        exportfile::export_user_bytes,
        pending_opened_files,
        close_flush_done,
    ]);
    builder
        .setup(|app| {
            // Cold-start argv (Windows/Linux file association).
            let args: Vec<String> = std::env::args().collect();
            announce_opened(app.handle(), argv_candidates(&args));

            // ADR-0021 §5 close-requested flush (see the module header).
            if let Some(window) = app.get_webview_window("main") {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                        return;
                    };
                    // Second request (or a post-deadline close): let it through.
                    if CLOSING.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_close();
                    let _ = handle.emit("snug:close-flush", ());
                    // The deadline: a webview that never answers must not trap
                    // the user. `destroy()` is idempotent against the command.
                    let deadline_handle = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(
                            CLOSE_FLUSH_DEADLINE_MS,
                        ));
                        let _ = deadline_handle.destroy();
                    });
                });
            }
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
