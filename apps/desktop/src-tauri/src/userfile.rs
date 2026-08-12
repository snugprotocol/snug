//! User-file persistence commands (TASK-20260812-desktop-hub-scaffold, AC2).
//!
//! The webview's `'file'` PersistenceBackend calls these. Two hard rules carried
//! from the OPFS backend's crash lessons (docs/lessons.md 2026-08-03):
//! writes are atomic (temp + fsync + rename — a torn `user.sqlite` is
//! unrecoverable data loss under the strict magic check), and a read never
//! fabricates emptiness (absent file is the ONLY "not found"; any IO error is
//! an error).
//!
//! Security: `name` is a bare filename inside `~/Snug` — path separators and
//! dotfiles are refused so the webview can never address anything else.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

const SNUG_DIR: &str = "Snug";
/// Filename charset: conservative on purpose; quarantine names use `.` and `-`.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn snug_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "no home directory".to_string())?;
    Ok(PathBuf::from(home).join(SNUG_DIR))
}

fn resolve(name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("invalid user-file name: {name:?}"));
    }
    Ok(snug_dir()?.join(name))
}

/// `Ok(None)` means the file genuinely does not exist. Every other failure is `Err`.
pub fn read_user_file_impl(name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = resolve(name)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {name}: {e}")),
    }
}

/// Atomic: write `<name>.tmp-<rand>`, fsync, rename over the target.
pub fn write_user_file_impl(name: &str, bytes: &[u8]) -> Result<(), String> {
    let path = resolve(name)?;
    let dir = snug_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!("{name}.tmp-{:08x}", rand::random::<u32>()));
    let result = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
        drop(f);
        fs::rename(&tmp, &path).map_err(|e| format!("rename into place: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp); // best-effort cleanup; the target was never touched
    }
    result
}

#[tauri::command]
pub fn read_user_file(name: String) -> Result<tauri::ipc::Response, String> {
    match read_user_file_impl(&name)? {
        // One-byte discriminant so absence is unambiguous (empty bytes are CORRUPT
        // to the caller, never "fresh" — the discriminant keeps that signal intact).
        Some(mut bytes) => {
            bytes.insert(0, 1);
            Ok(tauri::ipc::Response::new(bytes))
        }
        None => Ok(tauri::ipc::Response::new(vec![0u8])),
    }
}

#[tauri::command]
pub fn write_user_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    // Raw-body invokes carry scalar args as headers (JS: invoke(cmd, bytes, {headers})).
    let name = request
        .headers()
        .get("name")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing name header".to_string())?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw byte body".into());
    };
    write_user_file_impl(&name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_home<T>(f: impl FnOnce() -> T) -> T {
        // Serialize env mutation across tests.
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        let out = f();
        match old {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        out
    }

    #[test]
    fn rejects_traversal_and_dotfiles() {
        for bad in ["../x", "a/b", "a\\b", ".hidden", "", "x\0y", &"a".repeat(129)] {
            assert!(!valid_name(bad), "{bad:?} must be refused");
        }
        for good in ["user.sqlite", "user.sqlite.corrupt-abc.bak", "a-b_c.1"] {
            assert!(valid_name(good), "{good:?} must be accepted");
        }
    }

    #[test]
    fn absent_is_none_and_roundtrip_works() {
        with_home(|| {
            assert_eq!(read_user_file_impl("user.sqlite").unwrap(), None);
            write_user_file_impl("user.sqlite", b"SQLite format 3\0hello").unwrap();
            assert_eq!(
                read_user_file_impl("user.sqlite").unwrap().unwrap(),
                b"SQLite format 3\0hello"
            );
        });
    }

    #[test]
    fn overwrite_is_atomic_leaves_no_tmp() {
        with_home(|| {
            write_user_file_impl("f.bin", b"one").unwrap();
            write_user_file_impl("f.bin", b"two").unwrap();
            assert_eq!(read_user_file_impl("f.bin").unwrap().unwrap(), b"two");
            let leftovers: Vec<_> = fs::read_dir(snug_dir().unwrap())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
                .collect();
            assert!(leftovers.is_empty(), "no tmp files may survive: {leftovers:?}");
        });
    }
}
