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
}

/// Pure env → config translation, unit-tested below without process-global env.
fn parse_config(
    gate: Option<String>,
    out: Option<String>,
    remap: Option<String>,
) -> Option<GateConfig> {
    if gate.as_deref() != Some("1") {
        return None;
    }
    let Some(out_path) = out else {
        eprintln!("[shell-gate] SNUG_SHELL_GATE=1 but SNUG_SHELL_GATE_OUT is unset — gate stays OFF");
        return None;
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
    Some(GateConfig { out_path, remap })
}

fn config() -> &'static Option<GateConfig> {
    static CONFIG: OnceLock<Option<GateConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        parse_config(
            std::env::var("SNUG_SHELL_GATE").ok(),
            std::env::var("SNUG_SHELL_GATE_OUT").ok(),
            std::env::var("SNUG_SHELL_GATE_REMAP").ok(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn off_unless_exactly_one() {
        assert!(parse_config(None, s("/tmp/x"), None).is_none());
        assert!(parse_config(s("0"), s("/tmp/x"), None).is_none());
        assert!(parse_config(s("true"), s("/tmp/x"), None).is_none());
    }

    #[test]
    fn off_without_out_path() {
        assert!(parse_config(s("1"), None, None).is_none());
    }

    #[test]
    fn off_on_malformed_remap() {
        assert!(parse_config(s("1"), s("/tmp/x"), s("not-json")).is_none());
        assert!(parse_config(s("1"), s("/tmp/x"), s("[1,2]")).is_none());
    }

    #[test]
    fn on_with_out_and_remap() {
        let cfg = parse_config(
            s("1"),
            s("/tmp/results.json"),
            s(r#"{"api.provider.example":"http://127.0.0.1:43120"}"#),
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
        let cfg = parse_config(s("1"), s("/tmp/r.json"), None).expect("gate must arm");
        assert!(cfg.remap.is_empty());
    }
}
