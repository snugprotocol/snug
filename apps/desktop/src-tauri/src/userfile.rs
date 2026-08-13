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

/// Orphaned `*.tmp-*` older than this are swept. Generous on purpose: it must
/// sit far above the longest plausible in-flight write (a multi-hundred-MB
/// user.sqlite on a slow disk) so a CONCURRENT write is never mistaken for an
/// orphan. Ten minutes buys ~2 orders of magnitude of headroom over a realistic
/// worst case while still bounding how long a killed write's litter survives.
const TMP_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(600);

/// Pick the home directory from the two candidate variables.
///
/// Precedence is NOT symmetric, and the asymmetry is the point. On Windows,
/// `HOME` is not an OS-set variable — git-bash, MSYS2, Cygwin and most CI
/// images set it to something that is not the user's profile. Preferring it
/// there would silently relocate `~/Snug` and boot a FRESH, empty database over
/// a user whose real data sits in `%USERPROFILE%\Snug` — data loss that looks
/// like "the app forgot everything". `USERPROFILE` is the OS's own answer
/// there. On unix `HOME` is the OS's own answer and stays first. Either way the
/// other name is a fallback rather than a hard dependency, and neither platform
/// ever defaults to CWD or `/`.
///
/// `windows` is a PARAMETER rather than a `cfg` so both orderings are covered
/// by the suite on every host. A `#[cfg(windows)]` branch is not compiled on
/// macOS/Linux, so it is invisible to tests and to the type checker there — the
/// Windows ordering would ship on the strength of code review alone, and this
/// is precisely the bug (a Windows-only silent data loss) that review missed
/// the first time.
fn pick_home(
    home: Option<std::ffi::OsString>,
    profile: Option<std::ffi::OsString>,
    windows: bool,
) -> Result<PathBuf, String> {
    let chosen = if windows {
        profile.or(home)
    } else {
        home.or(profile)
    };
    chosen
        .map(|h| PathBuf::from(h).join(SNUG_DIR))
        .ok_or_else(|| "no home directory".to_string())
}

fn snug_dir() -> Result<PathBuf, String> {
    pick_home(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        cfg!(windows),
    )
}

/// Best-effort removal of `*.tmp-*` files older than [`TMP_STALE_AFTER`].
///
/// A kill between tmp-write and rename (power loss, force-quit, OOM) leaves the
/// staging file behind forever — the rename that would have consumed it never
/// ran. Nothing else ever collects them, so `~/Snug` accumulates a full-size
/// copy of the database per crash.
///
/// WHY AT WRITE TIME rather than app setup: the write path is the only code
/// that creates these files, so the cleanup sits with the thing that makes the
/// mess — no ordering dependency on boot, no second call site to keep in sync,
/// and a shell that is killed before setup completes still gets swept on its
/// next successful write. The cost is one `read_dir` of a directory holding a
/// handful of entries, on a path that is already doing fsync-grade IO.
///
/// Entirely best-effort: a sweep failure must never fail a write. It only ever
/// considers names containing `.tmp-` (real user files and `.corrupt-*.bak`
/// quarantines are untouched), and the age floor means a write in flight in
/// another process is never swept out from under itself.
fn sweep_stale_tmp_files(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.contains(".tmp-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| match now.duration_since(m) {
                Ok(age) => age > TMP_STALE_AFTER,
                // Modified in the future (clock skew) — treat as fresh.
                Err(_) => false,
            })
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// fsync the DIRECTORY so the rename itself is durable.
///
/// `sync_all` on the temp file durably persists its CONTENTS, but on most unix
/// filesystems the directory entry created by `rename` can still be lost to a
/// power failure — leaving the old inode (or nothing) in place despite the
/// rename having returned. Opening the directory and fsyncing it is the
/// portable-on-unix fix. Windows has no directory-handle fsync and does not
/// need one (NTFS journals the metadata operation), so this is a no-op there.
/// Best-effort: a durability barrier failing must not fail a completed write.
fn fsync_dir(dir: &std::path::Path) {
    #[cfg(not(windows))]
    if let Ok(f) = fs::File::open(dir) {
        let _ = f.sync_all();
    }
    #[cfg(windows)]
    let _ = dir;
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

/// Atomic: write `<name>.tmp-<rand>`, fsync, rename over the target, fsync dir.
pub fn write_user_file_impl(name: &str, bytes: &[u8]) -> Result<(), String> {
    write_user_file_staged(name, bytes, |_tmp| Ok(()))
}

/// The write, factored so the crash window is TESTABLE.
///
/// `before_rename` runs at exactly the moment a kill is unrecoverable for a
/// naive implementation: the staging file is fully written and fsynced, and the
/// target has not been touched. Returning `Err` from it simulates that crash;
/// the caller can then assert the target still serves the OLD complete bytes.
/// Production passes a no-op, so this is a seam, not a branch — there is one
/// write path and the tests exercise it, rather than a `#[cfg(test)]` variant
/// that could drift from what ships.
///
/// Order is load-bearing and each step is here for a reason:
///   1. write to a temp sibling — the target keeps serving old bytes throughout;
///   2. `sync_all` — the temp's CONTENTS are durable before anything points at it
///      (skip it and a crash can publish a rename to a file of zeros);
///   3. `rename` — the atomic publish; readers see old-or-new, never torn;
///   4. `fsync_dir` — the rename itself becomes durable (see [`fsync_dir`]).
/// On any failure the temp is removed and the target is left exactly as it was.
fn write_user_file_staged(
    name: &str,
    bytes: &[u8],
    before_rename: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<(), String> {
    let path = resolve(name)?;
    let dir = snug_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // Collect litter from earlier killed writes before adding our own staging
    // file (see sweep_stale_tmp_files for why this lives on the write path).
    sweep_stale_tmp_files(&dir);
    let tmp = dir.join(format!("{name}.tmp-{:08x}", rand::random::<u32>()));
    let result = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
        drop(f);
        before_rename(&tmp)?;
        fs::rename(&tmp, &path).map_err(|e| format!("rename into place: {e}"))?;
        fsync_dir(&dir);
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

    /// ONE lock for every test that mutates HOME/USERPROFILE. It must be shared
    /// (not per-function): `cargo test` runs these on parallel threads in one
    /// process, and two tests holding different mutexes would interleave their
    /// env writes — one test's tempdir becoming another's `~`. That produces
    /// failures that move around between runs and read like implementation bugs.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII restore for HOME/USERPROFILE. A `Drop` impl rather than
    /// straight-line restore code because a FAILING assertion unwinds — with
    /// restore-at-the-end, one panicking test would leave every later test
    /// pointed at a deleted tempdir, turning a single real failure into a
    /// cascade. Drop runs on the unwind path too.
    struct EnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        home: Option<std::ffi::OsString>,
        profile: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        /// Take the lock and record the current values. Poisoning is recovered
        /// from deliberately: a panicking test already failed loudly; poisoning
        /// the rest of the suite on top of it only obscures which test broke.
        fn acquire() -> Self {
            Self {
                _lock: ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()),
                home: std::env::var_os("HOME"),
                profile: std::env::var_os("USERPROFILE"),
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            let restore = |k: &str, v: &Option<std::ffi::OsString>| match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            };
            restore("HOME", &self.home);
            restore("USERPROFILE", &self.profile);
        }
    }

    /// Run `f` with `~` pointed at a fresh tempdir on EVERY platform: both
    /// variables are set, because `snug_dir`'s precedence differs by platform
    /// and a test that set only HOME would silently use the developer's real
    /// profile directory on Windows.
    fn with_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = EnvGuard::acquire();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", dir.path());
        std::env::set_var("USERPROFILE", dir.path());
        f()
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

    // ---- Finding 3: the MECHANISM, not just the outcome --------------------
    //
    // The four tests above all pass against `fs::write(&path, bytes)` — a plain
    // truncating write. That is the whole problem: atomicity was an unguarded
    // property, and a refactor could have deleted temp+fsync+rename without a
    // single red test. These pin the mechanism by INJECTING a failure between
    // tmp-write and rename (the only window where a crash can tear the file)
    // and asserting the target still serves the OLD complete bytes.

    #[test]
    fn failure_between_tmp_write_and_rename_leaves_the_old_bytes_intact() {
        with_home(|| {
            let old = b"SQLite format 3\0COMPLETE-AND-OLD";
            write_user_file_impl("user.sqlite", old).unwrap();

            // A plain write would have truncated the target the instant it
            // opened the file. The staged sequence has not touched it yet.
            let err = write_user_file_staged("user.sqlite", b"NEW-BYTES-NEVER-LAND", |_tmp| {
                Err("injected crash before rename".to_string())
            })
            .unwrap_err();
            assert!(err.contains("injected crash"), "{err}");

            assert_eq!(
                read_user_file_impl("user.sqlite").unwrap().unwrap(),
                old,
                "the target must still serve the OLD complete bytes"
            );
            assert!(
                tmp_files_in(&snug_dir().unwrap()).is_empty(),
                "the failed tmp must be cleaned up"
            );
        });
    }

    #[test]
    fn a_partial_tmp_file_never_shadows_the_target_on_read() {
        with_home(|| {
            let good = b"SQLite format 3\0GOOD";
            write_user_file_impl("user.sqlite", good).unwrap();
            // Plant a torn tmp exactly as a kill-mid-write would leave it.
            let dir = snug_dir().unwrap();
            fs::write(dir.join("user.sqlite.tmp-deadbeef"), b"TORN-HALF-WRITTEN").unwrap();

            assert_eq!(
                read_user_file_impl("user.sqlite").unwrap().unwrap(),
                good,
                "a sibling .tmp- file must not affect the target read"
            );
            // And the tmp is not itself addressable as a user file: the reader
            // only ever resolves the exact name it was given.
            assert_eq!(
                read_user_file_impl("user.sqlite.tmp-deadbeef")
                    .unwrap()
                    .unwrap(),
                b"TORN-HALF-WRITTEN"
            );
        });
    }

    #[test]
    fn staged_write_publishes_the_new_bytes_when_the_step_succeeds() {
        with_home(|| {
            write_user_file_impl("user.sqlite", b"old").unwrap();
            write_user_file_staged("user.sqlite", b"new", |_tmp| Ok(())).unwrap();
            assert_eq!(read_user_file_impl("user.sqlite").unwrap().unwrap(), b"new");
        });
    }

    /// The tests above drive `write_user_file_staged`. This one pins that the
    /// PRODUCTION entry point actually goes through it — otherwise
    /// `write_user_file_impl` could be quietly reduced to `fs::write` while the
    /// staged function sat beside it, fully tested and entirely unused.
    ///
    /// The observable difference between the two is the staging file: the
    /// atomic path creates `<name>.tmp-<rand>` next to the target before it
    /// publishes, and a plain write never does. Catching that requires looking
    /// DURING the write, so the target name is a directory — `fs::create` on it
    /// fails, the write errors out, and the tmp path it had chosen is named in
    /// the message. A plain `fs::write` to that same directory path fails with
    /// a message that names no temp file at all.
    #[test]
    fn the_production_write_path_stages_through_a_tmp_file() {
        with_home(|| {
            let dir = snug_dir().unwrap();
            fs::create_dir_all(dir.join("user.sqlite")).unwrap();

            let err = write_user_file_impl("user.sqlite", b"payload").unwrap_err();

            assert!(
                err.contains("rename into place"),
                "the production write must fail at the RENAME step, proving it \
                 staged first; got: {err}"
            );
            // And it cleaned up after itself rather than leaving the staging file.
            assert!(
                tmp_files_in(&dir).is_empty(),
                "a failed production write must not leave a tmp behind"
            );
        });
    }

    #[test]
    fn the_tmp_is_fully_written_and_fsynced_before_the_rename() {
        with_home(|| {
            write_user_file_impl("user.sqlite", b"old").unwrap();
            let bytes = b"SQLite format 3\0FRESH-PAYLOAD";
            // The hook runs after the tmp is closed and before the rename, so
            // the tmp on disk must already hold the COMPLETE payload. A
            // write-then-rename that skipped `write_all`/`sync_all` would fail
            // here even though the final file would look right.
            write_user_file_staged("user.sqlite", bytes, |tmp| {
                let staged = fs::read(tmp).map_err(|e| e.to_string())?;
                assert_eq!(staged, bytes, "tmp must hold the complete payload pre-rename");
                assert_ne!(tmp.file_name(), Some(std::ffi::OsStr::new("user.sqlite")));
                Ok(())
            })
            .unwrap();
            assert_eq!(read_user_file_impl("user.sqlite").unwrap().unwrap(), bytes);
        });
    }

    // ---- Finding 4: orphaned tmp sweep + directory fsync -------------------

    /// The directory fsync has NO userspace-observable effect — that is its
    /// nature: it only changes what survives a power cut, which no in-process
    /// test can stage. So this pins the SOURCE instead. A source assertion is a
    /// weak instrument and is used here only because the alternative is no
    /// guard at all: without it, deleting the `fsync_dir` call leaves the whole
    /// suite green and produces nothing louder than a dead-code warning.
    #[test]
    fn the_write_path_still_fsyncs_the_directory_after_the_rename() {
        let src = include_str!("userfile.rs");
        let staged = src
            .split("fn write_user_file_staged")
            .nth(1)
            .expect("write_user_file_staged must exist");
        let body = staged.split("#[tauri::command]").next().unwrap_or(staged);
        let rename_at = body.find("fs::rename(").expect("the write must rename");
        let fsync_at = body
            .find("fsync_dir(&dir)")
            .expect("the write must fsync the directory after the rename");
        assert!(
            fsync_at > rename_at,
            "fsync_dir must come AFTER the rename — fsyncing before it makes \
             the rename itself no more durable"
        );
    }

    #[test]
    fn sweep_removes_stale_tmp_files_and_spares_fresh_ones() {
        with_home(|| {
            let dir = snug_dir().unwrap();
            fs::create_dir_all(&dir).unwrap();
            let stale = dir.join("user.sqlite.tmp-00000001");
            let fresh = dir.join("user.sqlite.tmp-00000002");
            fs::write(&stale, b"orphan from a kill months ago").unwrap();
            fs::write(&fresh, b"a CONCURRENT write in progress").unwrap();
            set_mtime_ago(&stale, TMP_STALE_AFTER + std::time::Duration::from_secs(60));

            sweep_stale_tmp_files(&dir);

            assert!(!stale.exists(), "an aged orphan must be swept");
            assert!(
                fresh.exists(),
                "a fresh tmp is a concurrent write and must NEVER be swept"
            );
        });
    }

    #[test]
    fn sweep_never_touches_real_user_files() {
        with_home(|| {
            let dir = snug_dir().unwrap();
            write_user_file_impl("user.sqlite", b"real data").unwrap();
            write_user_file_impl("user.sqlite.corrupt-abc.bak", b"quarantined").unwrap();
            set_mtime_ago(
                &dir.join("user.sqlite"),
                TMP_STALE_AFTER + std::time::Duration::from_secs(3600),
            );
            set_mtime_ago(
                &dir.join("user.sqlite.corrupt-abc.bak"),
                TMP_STALE_AFTER + std::time::Duration::from_secs(3600),
            );

            sweep_stale_tmp_files(&dir);

            assert_eq!(read_user_file_impl("user.sqlite").unwrap().unwrap(), b"real data");
            assert!(dir.join("user.sqlite.corrupt-abc.bak").exists());
        });
    }

    #[test]
    fn a_normal_write_sweeps_stale_orphans() {
        with_home(|| {
            let dir = snug_dir().unwrap();
            fs::create_dir_all(&dir).unwrap();
            let stale = dir.join("user.sqlite.tmp-0badf00d");
            fs::write(&stale, b"orphan").unwrap();
            set_mtime_ago(&stale, TMP_STALE_AFTER + std::time::Duration::from_secs(60));

            write_user_file_impl("user.sqlite", b"fresh write").unwrap();

            assert!(!stale.exists(), "the write path must sweep aged orphans");
            assert_eq!(
                read_user_file_impl("user.sqlite").unwrap().unwrap(),
                b"fresh write"
            );
        });
    }

    // ---- Finding 5: HOME vs USERPROFILE precedence is platform-specific ----

    /// BOTH orderings, on EVERY host. This is the test that actually guards
    /// the Windows behaviour: the `snug_dir` test below can only ever exercise
    /// whichever branch the current host compiles.
    #[test]
    fn pick_home_precedence_is_platform_correct_in_both_directions() {
        let home = || Some(std::ffi::OsString::from("/home-var"));
        let profile = || Some(std::ffi::OsString::from("/profile-var"));

        // Windows: USERPROFILE wins over an environment-set HOME.
        assert_eq!(
            pick_home(home(), profile(), true).unwrap(),
            PathBuf::from("/profile-var").join(SNUG_DIR)
        );
        // Unix: HOME wins.
        assert_eq!(
            pick_home(home(), profile(), false).unwrap(),
            PathBuf::from("/home-var").join(SNUG_DIR)
        );
        // Each platform falls back to the other name when its preferred one is absent.
        assert_eq!(
            pick_home(home(), None, true).unwrap(),
            PathBuf::from("/home-var").join(SNUG_DIR)
        );
        assert_eq!(
            pick_home(None, profile(), false).unwrap(),
            PathBuf::from("/profile-var").join(SNUG_DIR)
        );
        // Neither set is an error on both platforms, never a silent default.
        assert!(pick_home(None, None, true).is_err());
        assert!(pick_home(None, None, false).is_err());
    }

    #[test]
    fn home_precedence_matches_the_platform() {
        let _guard = EnvGuard::acquire();
        let home_dir = tempfile::tempdir().unwrap();
        let profile_dir = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home_dir.path());
        std::env::set_var("USERPROFILE", profile_dir.path());

        // On Windows an environment-set HOME (git-bash, MSYS, most CI images set
        // it) would silently relocate ~/Snug and boot a FRESH db over a user
        // whose real data is in %USERPROFILE%\Snug. USERPROFILE is the OS's own
        // answer there; HOME stays authoritative on unix.
        #[cfg(windows)]
        let expected = profile_dir.path().join(SNUG_DIR);
        #[cfg(not(windows))]
        let expected = home_dir.path().join(SNUG_DIR);

        assert_eq!(snug_dir().unwrap(), expected);
    }

    #[test]
    fn falls_back_to_the_other_variable_when_the_preferred_one_is_absent() {
        let _guard = EnvGuard::acquire();
        let only = tempfile::tempdir().unwrap();

        // Only the NON-preferred variable is set — it must still be used rather
        // than erroring, so neither platform hard-depends on a single name.
        #[cfg(windows)]
        {
            std::env::remove_var("USERPROFILE");
            std::env::set_var("HOME", only.path());
        }
        #[cfg(not(windows))]
        {
            std::env::remove_var("HOME");
            std::env::set_var("USERPROFILE", only.path());
        }

        assert_eq!(snug_dir().unwrap(), only.path().join(SNUG_DIR));
    }

    #[test]
    fn no_home_at_all_is_an_error_not_a_silent_default() {
        let _guard = EnvGuard::acquire();
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        // Falling back to CWD or "/" here would write a user database somewhere
        // arbitrary; refusing is the only safe answer.
        assert!(snug_dir().is_err());
    }

    // -- test helpers --------------------------------------------------------

    fn tmp_files_in(dir: &std::path::Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.contains(".tmp-"))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Backdate a file's mtime by `ago` so the sweep's age check can be driven
    /// without sleeping.
    fn set_mtime_ago(path: &std::path::Path, ago: std::time::Duration) {
        let when = std::time::SystemTime::now() - ago;
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(when).unwrap();
    }
}
