//! Export-to-disk with native save dialog (TASK-20260812-desktop-hub-scaffold).
//!
//! Consent design: the dialog and the write live in ONE command, so the
//! webview supplies bytes and a *suggested name* only — it can never name a
//! filesystem path. A cancelled dialog is a successful no-op.

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn export_user_bytes(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let suggested = request
        .headers()
        .get("suggested-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| urlencoding_decode(v))
        .unwrap_or_else(|| "snug-user.snug".to_string());
    // Keep the dialog's default name shaped like a filename, nothing more.
    let suggested: String = suggested
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        .take(128)
        .collect();

    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw byte body".into());
    };
    let bytes = bytes.clone();

    let (tx, rx) = std::sync::mpsc::channel::<Option<tauri_plugin_dialog::FilePath>>();
    app.dialog()
        .file()
        .set_file_name(&suggested)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.recv().map_err(|e| format!("dialog: {e}"))? else {
        return Ok(false); // user cancelled
    };
    let path = path.into_path().map_err(|e| format!("dialog path: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write export: {e}"))?;
    Ok(true)
}

fn urlencoding_decode(s: &str) -> String {
    // Minimal percent-decoding (suggested names are ASCII-safe by contract).
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
