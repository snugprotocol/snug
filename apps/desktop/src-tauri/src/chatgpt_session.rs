//! ChatGPT-plan session custody (TASK-20261023-siwc-chatgpt-plan D2, ADR-0078 §2).
//!
//! CUSTODY ONLY: three commands — read, write, clear — over ONE fixed file,
//! `~/Snug/.chatgpt-plan/session.json`. No policy, no network, no parsing, nothing logged.
//!
//!   - The directory is a DOT-directory on purpose (Gate-2 blocker F1/S2): `userfile.rs`'s
//!     `valid_name` refuses a leading `.` and every separator, so `read_user_file` /
//!     `write_user_file` can never address it. The user-file commands' refusal is pinned by
//!     tests in `userfile.rs`.
//!   - The directory is `0700` (an existing looser one is tightened); `~/Snug` itself is NOT
//!     chmod'ed (it holds `user.snug` and the sidecar socket).
//!   - The file is written through a temp in the same directory opened with
//!     `OpenOptions::new().write(true).create_new(true).mode(0o600)` — so the temp is `0600`
//!     from its first byte (S5) and a planted symlink is never followed — then `sync_all`,
//!     `rename` over `session.json`, and the directory fsync'ed.
//!   - The payload is OPAQUE bytes with a size cap: no serde, no JSON parse (a serde type error
//!     would quote the offending string — a token — back into an error message).
//!   - The IPC wall for these commands is the invoke key, exactly as for `read_user_file`
//!     (ADR-0021 §8); `capabilities/main.json` is unchanged. The in-shell gate's rows prove a
//!     sandboxed app frame cannot reach them (AC13).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The size cap on one session payload. Over it → `Err` naming the cap, nothing written.
pub const MAX_SESSION_BYTES: usize = 64 * 1024;

/// The dot-directory under `~/Snug`. The leading `.` is what keeps it out of `valid_name`'s reach.
const SESSION_DIR_NAME: &str = ".chatgpt-plan";
/// The one file inside it. `pub(crate)` for the debug-only gate stat probe (gate.rs).
pub(crate) const SESSION_FILE: &str = "session.json";
/// The staging name. DETERMINISTIC on purpose: a crash leaves at most one leftover, at a name
/// the next write collides with and removes unopened (see `open_temp`) — a random name would
/// need a directory sweep to be sure no half-written copy of the tokens survives.
const TEMP_FILE: &str = "session.json.tmp";

/// `<home>/Snug/.chatgpt-plan` — the ONE location (pinned by test).
pub fn session_dir(home: &Path) -> PathBuf {
    home.join("Snug").join(SESSION_DIR_NAME)
}

/// The commands' directory. The home comes from `userfile::snug_dir()` — the one place the
/// HOME/USERPROFILE precedence lives (where a Windows-ordering bug already shipped once) — and
/// the location from `session_dir`, so neither rule is spelled twice.
pub(crate) fn custody_dir() -> Result<PathBuf, String> {
    let snug = crate::userfile::snug_dir()?;
    let home = snug.parent().ok_or_else(|| "no home directory".to_string())?;
    Ok(session_dir(home))
}

/// `Ok(None)` when no session file exists (or the directory does not). The bytes, verbatim,
/// otherwise — and an error, never a lossy string, when they are not UTF-8: a silently altered
/// refresh token is worse than a refused read.
pub fn read_impl(dir: &Path) -> Result<Option<String>, String> {
    match fs::read(dir.join(SESSION_FILE)) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "session file is not valid UTF-8".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read session file: {e}")),
    }
}

/// The production write: `write_impl_with_hook` with a no-op hook.
pub fn write_impl(dir: &Path, payload: &str) -> Result<(), String> {
    write_impl_with_hook(dir, payload, |_tmp| {})
}

/// The write, with a seam at the moment between the temp being fully written + synced and the
/// rename: `before_rename` receives the TEMP path so a test can `stat` it (S5). Production
/// passes a no-op — one write path, not a test-only variant.
///
/// Order is load-bearing (the four steps of `userfile.rs`'s staged write, plus the modes):
///   1. the cap — checked before anything touches the disk; the error names the cap, never
///      the payload;
///   2. the directory, created `0700` or tightened to it;
///   3. the temp — `create_new` + `mode(0o600)`, written, `sync_all`;
///   4. `rename` over the target — readers see old-or-new, never torn;
///   5. the directory fsync'ed, so the rename itself survives a power cut.
/// On any failure the temp is removed and the target is left exactly as it was.
pub fn write_impl_with_hook(
    dir: &Path,
    payload: &str,
    before_rename: impl FnOnce(&Path),
) -> Result<(), String> {
    if payload.len() > MAX_SESSION_BYTES {
        return Err(format!(
            "session payload is {} bytes; the cap is {MAX_SESSION_BYTES} bytes (64 KiB)",
            payload.len()
        ));
    }
    ensure_private_dir(dir)?;
    let target = dir.join(SESSION_FILE);
    let tmp = dir.join(TEMP_FILE);
    let result = (|| -> Result<(), String> {
        let mut f = open_temp(&tmp)?;
        f.write_all(payload.as_bytes()).map_err(|e| format!("write session temp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync session temp: {e}"))?;
        drop(f);
        before_rename(&tmp);
        fs::rename(&tmp, &target).map_err(|e| format!("rename session file into place: {e}"))?;
        // The directory entry the rename created is durable only once the DIRECTORY is
        // fsync'ed (userfile.rs `fsync_dir` carries the full reasoning). Best-effort: a
        // durability barrier failing must not fail a completed write. No-op on Windows.
        #[cfg(not(windows))]
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp); // best-effort cleanup; the target was never touched
    }
    result
}

/// Removes `session.json`; idempotent; leaves the directory in place (and creates nothing).
pub fn clear_impl(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(SESSION_FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove session file: {e}")),
    }
}

/// The custody directory, `0700`. Only the LEAF gets the mode: `~/Snug` is created with the
/// process default when missing and never chmod'ed when present.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("create {}: {e}", dir.display())),
    }
    // Tighten an existing (or umask-widened) directory; a no-op on one already 0700.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Open the staging file `create_new` — never through an existing path, so a symlink planted
/// at the temp name is refused rather than followed — with mode `0600` from its first byte. A
/// leftover from a crash collides: it is removed unopened and the open retried ONCE, so a stale
/// copy of the tokens never blocks the next write and never survives it.
fn open_temp(tmp: &Path) -> Result<fs::File, String> {
    let open = || {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(tmp)
    };
    match open() {
        Ok(f) => Ok(f),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::remove_file(tmp).map_err(|e| format!("remove stale session temp: {e}"))?;
            open().map_err(|e| format!("create session temp: {e}"))
        }
        Err(e) => Err(format!("create session temp: {e}")),
    }
}

#[tauri::command]
pub fn chatgpt_session_read() -> Result<Option<String>, String> {
    read_impl(&custody_dir()?)
}

#[tauri::command]
pub fn chatgpt_session_write(payload: String) -> Result<(), String> {
    write_impl(&custody_dir()?, &payload)
}

#[tauri::command]
pub fn chatgpt_session_clear() -> Result<(), String> {
    clear_impl(&custody_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const FILE: &str = "session.json";

    /// A fresh `<tmp>/.chatgpt-plan` that does NOT exist yet — the impl must create it.
    fn fresh_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".chatgpt-plan");
        (root, dir)
    }

    fn mode_of(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The module's PRODUCTION CODE — everything before the test module, comment lines
    /// dropped (the header prose names `serde` and `.mode(0o600)`; prose must neither trip
    /// nor satisfy a source pin).
    fn production_source() -> String {
        let src = include_str!("chatgpt_session.rs");
        src.split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // ---- the fixed location ----------------------------------------------------------

    #[test]
    fn the_session_lives_in_a_dot_directory_under_snug() {
        // A plain `~/Snug/chatgpt-plan.json` would be reachable by read_user_file /
        // write_user_file (valid_name admits it) — the Gate-2 blocker this path exists to close.
        assert_eq!(
            session_dir(Path::new("/h")),
            PathBuf::from("/h").join("Snug").join(".chatgpt-plan")
        );
    }

    // ---- read --------------------------------------------------------------------------

    #[test]
    fn read_of_a_missing_file_is_none_not_an_error() {
        let (_root, dir) = fresh_dir();
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_impl(&dir).unwrap(), None);
    }

    #[test]
    fn read_of_a_missing_directory_is_none_and_creates_nothing() {
        let (_root, dir) = fresh_dir();
        assert_eq!(read_impl(&dir).unwrap(), None);
        assert!(!dir.exists(), "a read must never create the custody directory");
    }

    #[test]
    fn a_non_utf8_file_is_an_error_never_a_lossy_string() {
        // Opaque bytes come back byte-identical or not at all — a lossy conversion would
        // hand the keeper a silently altered refresh token.
        let (_root, dir) = fresh_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), [0x7b, 0xff, 0xfe, 0x7d]).unwrap();
        assert!(read_impl(&dir).is_err());
    }

    // ---- write: opaque, atomic, round-trips ---------------------------------------------

    #[test]
    fn the_payload_is_opaque_bytes_round_tripped_byte_identical() {
        // No serde, no JSON parse: something that is not JSON at all must survive verbatim.
        let (_root, dir) = fresh_dir();
        let payload = "not json {{{ \u{1F512} \n\t\"unterminated";
        write_impl(&dir, payload).unwrap();
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some(payload));
        assert_eq!(fs::read(dir.join(FILE)).unwrap(), payload.as_bytes());
    }

    #[test]
    fn a_second_write_replaces_the_first_whole() {
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "{\"v\":1,\"first\":\"a much longer first payload\"}").unwrap();
        write_impl(&dir, "{\"v\":1}").unwrap();
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some("{\"v\":1}"));
    }

    #[test]
    fn a_successful_write_leaves_exactly_one_file_behind() {
        // A temp holds a refresh token: litter is a credential copy, not just clutter.
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "one").unwrap();
        write_impl(&dir, "two").unwrap();
        assert_eq!(entries(&dir), vec![FILE.to_string()]);
    }

    // ---- modes ---------------------------------------------------------------------------

    #[test]
    fn a_created_directory_is_0700_and_the_file_is_0600() {
        // The test process umask is typically 022: a create_dir_all / File::create without an
        // explicit mode lands 0755 / 0644 and fails here.
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "payload").unwrap();
        assert_eq!(mode_of(&dir), 0o700, "custody directory must be 0700");
        assert_eq!(mode_of(&dir.join(FILE)), 0o600, "session file must be 0600");
    }

    #[test]
    fn an_existing_looser_directory_is_tightened_to_0700() {
        let (_root, dir) = fresh_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        write_impl(&dir, "payload").unwrap();
        assert_eq!(mode_of(&dir), 0o700);
    }

    #[test]
    fn an_existing_0644_session_file_is_replaced_by_a_0600_one() {
        // Catches an in-place write (truncate + write keeps the old inode's mode).
        let (_root, dir) = fresh_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE), "old").unwrap();
        fs::set_permissions(dir.join(FILE), fs::Permissions::from_mode(0o644)).unwrap();
        write_impl(&dir, "new").unwrap();
        assert_eq!(mode_of(&dir.join(FILE)), 0o600);
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn the_temp_file_is_0600_complete_and_beside_the_target_before_the_rename() {
        // S5: `userfile.rs`-style `File::create` leaves a 0644 temp holding the tokens for the
        // whole write window. The hook runs after write + sync_all and before the rename.
        let (_root, dir) = fresh_dir();
        let payload = "{\"tokens\":\"TEMP-MODE-PROBE\"}";
        let mut seen: Option<PathBuf> = None;
        write_impl_with_hook(&dir, payload, |tmp| {
            assert_eq!(mode_of(tmp), 0o600, "the TEMP must be 0600 while it exists");
            assert_eq!(tmp.parent(), Some(dir.as_path()), "the temp must sit in the custody dir (same-filesystem rename)");
            assert_ne!(tmp.file_name(), Some(std::ffi::OsStr::new(FILE)), "the temp is not the target");
            assert_eq!(fs::read(tmp).unwrap(), payload.as_bytes(), "the temp holds the COMPLETE payload pre-rename");
            assert!(!dir.join(FILE).exists(), "the target is untouched until the rename");
            seen = Some(tmp.to_path_buf());
        })
        .unwrap();
        let tmp = seen.expect("the before_rename hook must run exactly at the rename seam");
        assert!(!tmp.exists(), "the temp is consumed by the rename");
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some(payload));
    }

    #[test]
    fn the_production_write_goes_through_the_hooked_path() {
        // Without this, write_impl could be reduced to `fs::write` while the hooked function
        // sat beside it, fully tested and unused. Observable difference: a plain write to a
        // target that is a DIRECTORY fails at open; the staged path fails at the rename.
        let (_root, dir) = fresh_dir();
        fs::create_dir_all(dir.join(FILE)).unwrap();
        let err = write_impl(&dir, "payload").unwrap_err();
        assert!(err.contains("rename"), "the production write must stage and fail at the rename; got: {err}");
        assert_eq!(entries(&dir), vec![FILE.to_string()], "a failed write leaves no temp behind");
    }

    // ---- a crash's leftover temp ----------------------------------------------------------

    /// Learn the temp path a write uses, so a test can plant a crash leftover AT that name.
    fn learn_temp_path(dir: &Path) -> PathBuf {
        let mut seen = None;
        write_impl_with_hook(dir, "learn", |tmp| seen = Some(tmp.to_path_buf())).unwrap();
        seen.unwrap()
    }

    #[test]
    fn a_leftover_temp_from_a_crash_does_not_break_the_next_write_and_is_not_left_behind() {
        // PINNED STRATEGY: the next write succeeds AND no stale temp survives it (the leftover
        // holds a credential). With a deterministic temp name `create_new` collides and the impl
        // must remove the stale temp and retry; with a random name it must still sweep it.
        let (_root, dir) = fresh_dir();
        let tmp = learn_temp_path(&dir);
        fs::write(&tmp, "STALE-HALF-WRITTEN-TOKENS").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();

        let mut temp_mode = None;
        write_impl_with_hook(&dir, "fresh", |t| temp_mode = Some(mode_of(t))).unwrap();

        assert_eq!(temp_mode, Some(0o600), "a reused stale temp keeps its 0644 — create_new must not open it");
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some("fresh"));
        assert_eq!(entries(&dir), vec![FILE.to_string()], "the stale temp must not survive the next write");
    }

    #[test]
    fn a_symlink_planted_at_the_temp_name_is_never_written_through() {
        // `create_new` refuses an existing path, symlink included — a `create(true)` open would
        // follow the link and write the tokens wherever it points.
        let (root, dir) = fresh_dir();
        let tmp = learn_temp_path(&dir);
        let elsewhere = root.path().join("attacker-readable.txt");
        fs::write(&elsewhere, "untouched").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &tmp).unwrap();

        write_impl(&dir, "SECRET-REFRESH-TOKEN").unwrap();

        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "untouched");
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some("SECRET-REFRESH-TOKEN"));
    }

    // ---- the size cap -----------------------------------------------------------------------

    #[test]
    fn the_cap_is_64_kib() {
        assert_eq!(MAX_SESSION_BYTES, 65_536);
    }

    #[test]
    fn a_payload_of_exactly_the_cap_is_accepted() {
        let (_root, dir) = fresh_dir();
        let payload = "a".repeat(MAX_SESSION_BYTES);
        write_impl(&dir, &payload).unwrap();
        assert_eq!(read_impl(&dir).unwrap().map(|s| s.len()), Some(MAX_SESSION_BYTES));
    }

    #[test]
    fn an_over_cap_payload_is_refused_by_name_and_writes_nothing() {
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "previous").unwrap();
        let payload = format!("SECRET-MARKER{}", "a".repeat(MAX_SESSION_BYTES));
        let err = write_impl(&dir, &payload).unwrap_err();
        assert!(
            err.contains("65536") || err.contains("64 KiB"),
            "the error must name the cap; got: {err}"
        );
        assert!(!err.contains("SECRET-MARKER"), "an error must never quote the payload");
        assert_eq!(read_impl(&dir).unwrap().as_deref(), Some("previous"), "the previous file is untouched");
        assert_eq!(entries(&dir), vec![FILE.to_string()], "no temp is left behind");
    }

    #[test]
    fn an_over_cap_payload_on_a_fresh_machine_creates_no_file() {
        let (_root, dir) = fresh_dir();
        assert!(write_impl(&dir, &"a".repeat(MAX_SESSION_BYTES + 1)).is_err());
        assert!(!dir.join(FILE).exists());
    }

    // ---- clear ------------------------------------------------------------------------------

    #[test]
    fn clear_removes_the_file_and_leaves_the_directory() {
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "payload").unwrap();
        clear_impl(&dir).unwrap();
        assert!(!dir.join(FILE).exists());
        assert!(dir.is_dir(), "the directory (and its 0700) stays for the next sign-in");
        assert_eq!(read_impl(&dir).unwrap(), None);
    }

    #[test]
    fn clear_is_idempotent() {
        let (_root, dir) = fresh_dir();
        write_impl(&dir, "payload").unwrap();
        clear_impl(&dir).unwrap();
        clear_impl(&dir).unwrap();
        // …and on a machine that never signed in at all.
        let (_root2, never) = fresh_dir();
        clear_impl(&never).unwrap();
    }

    // ---- the commands resolve the fixed location under HOME ----------------------------------

    #[test]
    fn the_three_commands_operate_on_home_snug_dot_chatgpt_plan_and_leave_snug_mode_alone() {
        crate::userfile::tests::with_home(|| {
            let home = PathBuf::from(std::env::var_os("HOME").unwrap());
            let snug = home.join("Snug");
            fs::create_dir_all(&snug).unwrap();
            fs::set_permissions(&snug, fs::Permissions::from_mode(0o755)).unwrap();

            chatgpt_session_write("COMMAND-PAYLOAD".to_string()).unwrap();
            let file = snug.join(".chatgpt-plan").join(FILE);
            assert_eq!(fs::read_to_string(&file).unwrap(), "COMMAND-PAYLOAD");
            assert_eq!(mode_of(&file), 0o600);
            assert_eq!(mode_of(&snug), 0o755, "~/Snug itself is NOT chmod'ed (it holds user.snug and the sidecar socket)");

            assert_eq!(chatgpt_session_read().unwrap().as_deref(), Some("COMMAND-PAYLOAD"));
            chatgpt_session_clear().unwrap();
            assert!(!file.exists());
            assert_eq!(chatgpt_session_read().unwrap(), None);
        });
    }

    #[test]
    fn the_user_file_commands_cannot_see_what_the_session_commands_wrote() {
        // The wall from both sides: after a real session write, no name the user-file reader
        // accepts reaches it (the refusal of the dot-dir names is pinned in userfile.rs).
        crate::userfile::tests::with_home(|| {
            chatgpt_session_write("WALLED-OFF".to_string()).unwrap();
            for name in [".chatgpt-plan", ".chatgpt-plan/session.json", "../Snug/.chatgpt-plan/session.json"] {
                assert!(crate::userfile::read_user_file_impl(name).is_err(), "{name:?} must be refused");
            }
            assert_eq!(crate::userfile::read_user_file_impl("session.json").unwrap(), None, "a bare name never aliases the dot-dir");
        });
    }

    // ---- registration: BOTH handler lists ---------------------------------------------------

    /// The two `generate_handler![...]` bodies in lib.rs, debug first then release.
    fn handler_lists() -> (String, String) {
        let lib = include_str!("lib.rs");
        let debug_at = lib.find("#[cfg(debug_assertions)]\n    let builder = builder.invoke_handler(").expect("the debug handler list");
        let release_at = lib.find("#[cfg(not(debug_assertions))]\n    let builder = builder.invoke_handler(").expect("the release handler list");
        let body = |from: usize| -> String {
            let rest = &lib[from..];
            let open = rest.find("generate_handler![").unwrap();
            let close = rest[open..].find("]);").unwrap();
            rest[open..open + close].to_string()
        };
        (body(debug_at), body(release_at))
    }

    #[test]
    fn the_three_commands_are_registered_in_both_handler_lists() {
        // Registration is per-command and per-list: a command missing from the RELEASE list
        // works in every dev run and dies in the shipped binary.
        let (debug, release) = handler_lists();
        for cmd in ["chatgpt_session_read", "chatgpt_session_write", "chatgpt_session_clear"] {
            let entry = format!("{cmd},");
            assert!(debug.contains(&entry), "debug list must register {cmd}");
            assert!(release.contains(&entry), "release list must register {cmd}");
        }
    }

    #[test]
    fn the_gate_stat_probe_is_registered_in_the_debug_list_only() {
        // The in-shell gate's effect sensors (AC13) need a main-frame view of the file's mode;
        // like every gate command it must not exist in a release binary (P0 amendment 4).
        let (debug, release) = handler_lists();
        assert!(debug.contains("gate_chatgpt_session_stat,"));
        assert!(!release.contains("gate_chatgpt_session_stat"));
    }

    // ---- nothing logged, nothing parsed ------------------------------------------------------

    #[test]
    fn the_module_never_logs() {
        let src = production_source();
        for needle in ["println!", "eprintln!", "print!(", "eprint!(", "dbg!", "log::", "tracing::"] {
            assert!(!src.contains(needle), "custody code must log nothing; found {needle}");
        }
    }

    #[test]
    fn the_module_never_parses_the_payload() {
        // A serde type error would quote the offending string — a token — back to the caller.
        let src = production_source();
        assert!(!src.contains("serde"), "the payload is opaque: no serde in custody code");
    }

    #[test]
    fn the_write_opens_the_temp_create_new_0600_and_fsyncs_the_directory_after_the_rename() {
        // Source pins for what no in-process test can observe (power-cut durability) and for
        // the open flags the behavioural tests above can only approximate.
        let src = &production_source();
        assert!(src.contains("create_new(true)"), "the temp must be opened create_new");
        assert!(src.contains(".mode(0o600)"), "the temp must be opened with mode 0o600");
        let rename_at = src.find("fs::rename(").expect("the write must rename");
        let after = &src[rename_at..];
        assert!(after.contains("sync_all()"), "the directory must be fsync'ed AFTER the rename");
    }
}
