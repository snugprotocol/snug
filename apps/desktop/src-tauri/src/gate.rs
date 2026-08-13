//! In-shell hard-gate commands (TASK-20260812 P4, AC7/AC8).
//!
//! DEBUG BUILDS ONLY. This module is declared `#[cfg(debug_assertions)]` in
//! lib.rs and its commands are registered under the same cfg, so a release
//! binary contains neither the command bodies nor their name strings — there
//! is no runtime strictness knob to leave off (P0 amendment 4, C1 discipline).
//!
//! The gate configuration is read from the environment EXACTLY ONCE, at the
//! first call of either command, and is immutable thereafter (`OnceLock`):
//!   SNUG_SHELL_GATE=1            arms gate mode (anything else = off)
//!   SNUG_SHELL_GATE_OUT=<path>   where `write_gate_results` writes the JSON
//!   SNUG_SHELL_GATE_REMAP=<json> optional {host: replacement-origin} table for
//!                                the journey's provider hosts (amendment 4:
//!                                the webview remap table is populated ONLY
//!                                from this config — the TS bundle carries no
//!                                host literals of its own)
//!   SNUG_SHELL_GATE_PHASE=<leg>  optional: "full" (default), "persist-write",
//!                                or "persist-verify" — the two-process
//!                                close-flush proof (review finding 4). An
//!                                unknown value leaves the gate OFF rather than
//!                                silently running the wrong leg.
//!
//! `write_gate_results` REFUSES when gate mode is off: the results file is the
//! driver's only success signal, and a write outside gate mode could only be a
//! confused or hostile caller.

use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateConfig {
    pub out_path: String,
    pub remap: HashMap<String, String>,
    /// Which leg of the run this process is. `"full"` (default) is the whole
    /// harness. The close-flush proof (finding 4) needs TWO processes over one
    /// user file: `"persist-write"` mutates the db and closes the window;
    /// `"persist-verify"` reopens and asserts the row survived.
    pub phase: String,
}

/// Pure env → config translation, unit-tested below without process-global env.
fn parse_config(
    gate: Option<String>,
    out: Option<String>,
    remap: Option<String>,
    phase: Option<String>,
) -> Option<GateConfig> {
    if gate.as_deref() != Some("1") {
        return None;
    }
    let Some(out_path) = out else {
        eprintln!("[shell-gate] SNUG_SHELL_GATE=1 but SNUG_SHELL_GATE_OUT is unset — gate stays OFF");
        return None;
    };
    let phase = match phase.as_deref() {
        None | Some("full") => "full".to_string(),
        Some(p @ ("persist-write" | "persist-verify")) => p.to_string(),
        Some(other) => {
            eprintln!("[shell-gate] unknown SNUG_SHELL_GATE_PHASE {other:?} — gate stays OFF");
            return None;
        }
    };
    let remap: HashMap<String, String> = match remap {
        None => HashMap::new(),
        Some(raw) => match serde_json::from_str(&raw) {
            Ok(map) => map,
            Err(e) => {
                // Loud failure, never a silent half-armed gate: a bad remap
                // would let the journey dial real provider hosts.
                eprintln!("[shell-gate] SNUG_SHELL_GATE_REMAP is not a JSON string map ({e}) — gate stays OFF");
                return None;
            }
        },
    };
    Some(GateConfig {
        out_path,
        remap,
        phase,
    })
}

fn config() -> &'static Option<GateConfig> {
    static CONFIG: OnceLock<Option<GateConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        parse_config(
            std::env::var("SNUG_SHELL_GATE").ok(),
            std::env::var("SNUG_SHELL_GATE_OUT").ok(),
            std::env::var("SNUG_SHELL_GATE_REMAP").ok(),
            std::env::var("SNUG_SHELL_GATE_PHASE").ok(),
        )
    })
}

/// `None` = gate mode off (the production answer, including every debug run
/// without the env). The webview branches to the gate harness only on `Some`.
#[tauri::command]
pub fn shell_gate_config() -> Option<GateConfig> {
    config().clone()
}

/// Write the harness's verdict JSON to the configured path. Refused when gate
/// mode is off. Plain write (no atomicity dance): the driver reads the file
/// only after it appears and parses it — a torn write parses as failure.
#[tauri::command]
pub fn write_gate_results(json: String) -> Result<(), String> {
    let Some(cfg) = config() else {
        return Err("shell gate mode is off — refusing to write results".into());
    };
    std::fs::write(&cfg.out_path, json).map_err(|e| format!("write {}: {e}", cfg.out_path))
}

// ---------------------------------------------------------------------------
// IPC sentinel probe (whole-surface review finding 2).
//
// The `ipc-invoke-refused` check asks: did a keyless invoke posted from a
// sandboxed subframe actually EXECUTE a command? The original sensor was a
// callback installed in the subframe — a frame Tauri's response path can never
// reach, so it could not fire whether or not the command ran, and the check
// passed unconditionally.
//
// The sensor now lives where an effect IS observable. The subframe posts a
// keyless `write_user_file` for a sentinel FILENAME; if the invoke executed,
// that file exists in `~/Snug`. This command — called from the MAIN frame,
// which Tauri does answer — reports its existence. Absence of effect is the
// pass condition, matching the CSP suite's enforcement-signal discipline.
//
// Read-only and debug-only: it never creates, writes, or deletes anything, and
// `userfile.rs` (another owner) is untouched. It resolves the same `~/Snug`
// directory that `write_user_file` targets, and is name-restricted to the
// sentinel so it cannot be used as a general file-existence oracle.

/// The one filename this probe will answer for. A keyless invoke that executed
/// would land here; nothing in the product ever writes this name.
pub const IPC_SENTINEL_NAME: &str = "ipc-probe-canary.sqlite";

/// Pure: which path (if any) this probe is willing to stat. `None` = refused.
fn sentinel_path(home: Option<std::path::PathBuf>, name: &str) -> Option<std::path::PathBuf> {
    if name != IPC_SENTINEL_NAME {
        return None;
    }
    Some(home?.join("Snug").join(name))
}

/// Does the IPC sentinel file exist? `Ok(true)` = a keyless invoke EXECUTED a
/// write command from a sandboxed subframe = structural breakage.
#[tauri::command]
pub fn gate_ipc_sentinel_exists(name: String) -> Result<bool, String> {
    if config().is_none() {
        return Err("shell gate mode is off — refusing the sentinel probe".into());
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let Some(path) = sentinel_path(home, &name) else {
        return Err(format!("gate sentinel probe refuses the name {name:?}"));
    };
    Ok(path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn off_unless_exactly_one() {
        assert!(parse_config(None, s("/tmp/x"), None, None).is_none());
        assert!(parse_config(s("0"), s("/tmp/x"), None, None).is_none());
        assert!(parse_config(s("true"), s("/tmp/x"), None, None).is_none());
    }

    #[test]
    fn off_without_out_path() {
        assert!(parse_config(s("1"), None, None, None).is_none());
    }

    #[test]
    fn off_on_malformed_remap() {
        assert!(parse_config(s("1"), s("/tmp/x"), s("not-json"), None).is_none());
        assert!(parse_config(s("1"), s("/tmp/x"), s("[1,2]"), None).is_none());
    }

    #[test]
    fn on_with_out_and_remap() {
        let cfg = parse_config(
            s("1"),
            s("/tmp/results.json"),
            s(r#"{"api.provider.example":"http://127.0.0.1:43120"}"#),
            None,
        )
        .expect("gate must arm");
        assert_eq!(cfg.out_path, "/tmp/results.json");
        assert_eq!(
            cfg.remap.get("api.provider.example").map(String::as_str),
            Some("http://127.0.0.1:43120")
        );
    }

    #[test]
    fn remap_optional() {
        let cfg = parse_config(s("1"), s("/tmp/r.json"), None, None).expect("gate must arm");
        assert!(cfg.remap.is_empty());
    }

    #[test]
    fn sentinel_probe_answers_only_for_the_sentinel_name() {
        let home = Some(std::path::PathBuf::from("/home/x"));
        assert_eq!(
            sentinel_path(home.clone(), IPC_SENTINEL_NAME),
            Some(std::path::PathBuf::from("/home/x/Snug/ipc-probe-canary.sqlite"))
        );
        // The real user file, traversal, and anything else are all refused —
        // the probe is not a general file-existence oracle.
        for bad in ["user.sqlite", "../../etc/passwd", "", "ipc-probe-canary.sqlite.bak"] {
            assert!(
                sentinel_path(home.clone(), bad).is_none(),
                "{bad:?} must be refused"
            );
        }
    }

    #[test]
    fn sentinel_probe_needs_a_home() {
        assert!(sentinel_path(None, IPC_SENTINEL_NAME).is_none());
    }

    #[test]
    fn phase_defaults_to_full_and_accepts_the_two_persist_legs() {
        let full = parse_config(s("1"), s("/tmp/r.json"), None, None).expect("gate must arm");
        assert_eq!(full.phase, "full");
        for leg in ["full", "persist-write", "persist-verify"] {
            let cfg = parse_config(s("1"), s("/tmp/r.json"), None, s(leg)).expect("gate must arm");
            assert_eq!(cfg.phase, leg);
        }
    }

    #[test]
    fn an_unknown_phase_leaves_the_gate_off() {
        // Never silently run the wrong leg: a typo'd phase must not fall back to
        // "full" and report a green persist proof that never ran.
        assert!(parse_config(s("1"), s("/tmp/r.json"), None, s("persist-writ")).is_none());
        assert!(parse_config(s("1"), s("/tmp/r.json"), None, s("")).is_none());
    }
}
