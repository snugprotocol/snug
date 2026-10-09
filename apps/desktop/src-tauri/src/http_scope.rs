//! The main window's `http:default` scope, tested by BEHAVIOUR (TASK-20261008-p0-clearance W3).
//!
//! `capabilities/main.json` once listed `http://192.168.*.*:*`, `http://10.*.*.*:*` and the
//! sixteen `http://172.N.*.*:*` entries, and a test pinned those STRINGS. None of them ever
//! matched a single address: urlpattern 0.3 canonicalises every fixed-text hostname part
//! through `url::Url::set_host`, which IPv4-parses digit text, so `192.168.*.*` compiled to the
//! host `192.0.0.168*.*` (next-steps 2026-09-05; measured again 2026-10-09). The plain-http LAN
//! rung (ADR-0021 D4) was dead in every release. This module runs the scope the way the plugin
//! does and asserts what it ADMITS and REFUSES — the only kind of test that can see that class.
//!
//! `parse_url_pattern` is private to tauri-plugin-http, so it is copied VERBATIM below from
//! `tauri-plugin-http-2.5.9/src/scope.rs:17-34`; `the_copied_matcher_is_from_the_locked_plugin`
//! fails the moment Cargo.lock moves either crate, and the in-shell gate (`src/gate/netScope.ts`)
//! asks the REAL plugin over IPC, so a drift between this copy and the plugin cannot pass both.

use std::sync::OnceLock;

use url::Url;
use urlpattern::{UrlPattern, UrlPatternMatchInput};

/// VERBATIM from tauri-plugin-http-2.5.9/src/scope.rs:17-34 (private there).
fn parse_url_pattern(s: &str) -> Result<UrlPattern, urlpattern::quirks::Error> {
    let mut init = urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(s, None)?;
    if init.search.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.search.replace("*".to_string());
    }
    if init.hash.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.hash.replace("*".to_string());
    }
    if init
        .pathname
        .as_ref()
        .map(|p| p.is_empty() || p == "/")
        .unwrap_or(true)
    {
        init.pathname.replace("*".to_string());
    }
    UrlPattern::parse(init, Default::default())
}

struct Scope {
    allow: Vec<(String, UrlPattern)>,
    deny: Vec<(String, UrlPattern)>,
}

fn entries(permission: &serde_json::Value, key: &str) -> Vec<(String, UrlPattern)> {
    permission
        .get(key)
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .map(|entry| {
                    let raw = entry["url"].as_str().expect("every scope entry is { \"url\": … }").to_string();
                    let pattern = parse_url_pattern(&raw)
                        .unwrap_or_else(|e| panic!("`{raw}` does not parse with the plugin's rules: {e:?} — the plugin would fail EVERY fetch"));
                    (raw, pattern)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parsed ONCE: the equivalence sweep below asks ~8,700 questions.
fn scope() -> &'static Scope {
    static SCOPE: OnceLock<Scope> = OnceLock::new();
    SCOPE.get_or_init(parse_scope)
}

fn parse_scope() -> Scope {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).expect("main.json is JSON");
    let permission = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p.get("identifier").and_then(|i| i.as_str()) == Some("http:default"))
        .expect("main.json scopes http:default");
    Scope { allow: entries(permission, "allow"), deny: entries(permission, "deny") }
}

/// `Scope::is_allowed` (scope.rs:76-96) over the URL the plugin sees: `ClientConfig.url` is a
/// `url::Url`, so the scope matches the WHATWG-canonical host, never the raw spelling.
fn admitted(raw: &str) -> bool {
    let s = scope();
    let url = Url::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"));
    let hit = |list: &[(String, UrlPattern)]| {
        list.iter().any(|(_, p)| p.test(UrlPatternMatchInput::Url(url.clone())).unwrap_or_default())
    };
    !hit(&s.deny) && hit(&s.allow)
}

fn assert_all(urls: &[&str], want: bool) {
    let wrong: Vec<&&str> = urls.iter().filter(|u| admitted(u) != want).collect();
    assert!(wrong.is_empty(), "expected {} but got the opposite for: {wrong:?}", if want { "ADMITTED" } else { "REFUSED" });
}

#[test]
fn every_scope_entry_parses_with_the_plugins_rules() {
    let s = scope();
    assert!(!s.allow.is_empty());
    // A parse failure fails Entry deserialisation, which fails EVERY plugin:http fetch —
    // all desktop networking, https included. scope() panics on one; reaching here is the pass.
    assert!(s.deny.len() >= 4, "the loopback/IPv6 denies are present");
}

#[test]
fn rfc1918_http_is_admitted_on_any_port_and_path() {
    assert_all(
        &[
            "http://10.0.0.5/",
            "http://10.255.255.255/",
            "http://10.0.0.5:8080/x?y=1#z",
            "http://172.16.0.1/",
            "http://172.31.255.254:1/",
            "http://192.168.4.40:8787/v1/bundles?expires=7d", // the owner's 2026-09-05 repro
            "http://192.168.0.1",
            "http://192.168.0.1:80/",
            "http://192.168.1.20:8123/api/states", // a Home Assistant on its IP literal
        ],
        true,
    );
}

#[test]
fn non_canonical_spellings_that_decode_into_rfc1918_are_the_same_address_and_admitted() {
    // The plugin never sees these spellings: url::Url canonicalises them first (and so does the
    // browser's `new URL`, which connected-fetch classifies). Documented as the same address.
    for (raw, canonical) in [
        ("http://012.0.0.5/", "10.0.0.5"),
        ("http://0xA.0.0.5/", "10.0.0.5"),
        ("http://167772165/", "10.0.0.5"),
        ("http://172.16.1/", "172.16.0.1"),
        ("http://192.168.0.1./", "192.168.0.1"),
    ] {
        assert_eq!(Url::parse(raw).unwrap().host_str(), Some(canonical), "{raw}");
        assert!(admitted(raw), "{raw} decodes to {canonical}");
    }
}

#[test]
fn neighbours_lookalikes_and_tricks_are_refused_over_http() {
    assert_all(
        &[
            "http://11.0.0.1/",
            "http://9.255.255.255/",
            "http://110.0.0.1/",
            "http://210.0.0.5/",
            "http://172.15.0.1/",
            "http://172.32.0.1/",
            "http://192.167.0.1/",
            "http://192.169.0.1/",
            "http://1.2.3.4/",
            "http://example.com/",
            "http://localhost/",
            "http://127.0.0.1:8080/",
            "http://192.168.evil.com/",
            "http://10.0.0.5.evil.com/",
            "http://10.0.0.5.nip.io/",
            "http://10.0.0.5@evil.com/",
            "http://evil.com#@10.0.0.5",
            "http://010.0.0.1/",          // octal → 8.0.0.1, out of range
            "http://0xac.0x20.0.1/",      // hex → 172.32.0.1, out of range
            "http://[::ffff:192.168.0.1]/", // IPv6-mapped: not on the rung (ADR-0021/0023)
            "http://[fd00::1]/",
            "http://0.0.0.0:8080/",
        ],
        false,
    );
}

#[test]
fn https_is_admitted_on_any_port_for_names_and_ipv4_literals() {
    // R-14: a port is not part of a host's identity — an approved https host on :8123/:5001
    // (Home Assistant, Synology) failed on desktop while working on the web (owner, 2026-10-08).
    assert_all(
        &[
            "https://example.com/",
            "https://example.com:8443/x",
            "https://ha.duckdns.org:8123/api/",
            "https://api.github.com/user",
            "https://192.168.1.10:5001/",
            "https://10.0.0.5:8443/",
        ],
        true,
    );
}

#[test]
fn https_to_loopback_and_ipv6_literals_is_denied_on_every_port() {
    // `https://*:*` alone would admit these on every port (https://** admitted only :443).
    // Loopback is never a legitimate https target from the main window; IPv6 literals are
    // never what a registry entry or a provider declares (and they carry the embedded-IPv4
    // forms the SSRF guard has known gaps on — launch security review item 3).
    assert_all(
        &[
            "https://localhost/",
            "https://localhost:6443/",
            "https://localhost.:8443/",
            "https://LOCALHOST:443/",
            "https://foo.localhost:443/",
            "https://127.0.0.1/",
            "https://127.5.5.5:8443/",
            "https://0.0.0.0:8443/",
            "https://[::1]:6443/",
            "https://[::ffff:127.0.0.1]:8443/",
            "https://[2001:db8::1]/",
        ],
        false,
    );
}

#[test]
fn loopback_http_is_admitted_only_on_its_two_single_purpose_ports() {
    assert_all(&["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:43120/"], true);
    assert_all(
        &["http://127.0.0.1:11435/", "http://127.0.0.1:80/", "http://127.0.0.1/", "http://localhost:11434/api/tags", "http://[::1]:11434/"],
        false,
    );
}

#[test]
fn other_schemes_are_refused() {
    assert_all(&["ftp://192.168.0.1/", "ws://192.168.0.1/", "wss://example.com/"], false);
}

#[test]
fn http_admission_equals_the_lan_fetch_host_class() {
    // Over canonical dotted quads only (the spellings above are canonicalised before either side).
    let mut checked = 0;
    for a in [0u16, 9, 10, 11, 126, 127, 128, 169, 171, 172, 173, 191, 192, 193, 223, 224, 255] {
        for b in 0u16..=255 {
            for tail in ["0.1", "255.254"] {
                let host = format!("{a}.{b}.{tail}");
                let scoped = admitted(&format!("http://{host}/"));
                let lan = crate::lanfetch::is_rfc1918_ipv4_literal(&host);
                assert_eq!(scoped, lan, "{host}: scope {scoped} vs lan_fetch {lan}");
                checked += 1;
            }
        }
    }
    assert!(checked > 8_000);
}

#[test]
fn the_star_form_is_dead_in_this_engine() {
    // Lesson 2026-09-05, executable: the fixed digits are IPv4-parsed by Url::set_host.
    let dead = parse_url_pattern("http://192.168.*.*:*").unwrap();
    assert!(dead.hostname().starts_with("192.0.0.168"), "compiled hostname: {}", dead.hostname());
    let url = Url::parse("http://192.168.4.40:8787/").unwrap();
    assert!(!dead.test(UrlPatternMatchInput::Url(url)).unwrap());
}

#[test]
fn the_copied_matcher_is_from_the_locked_plugin() {
    let lock = include_str!("../Cargo.lock");
    for (name, version) in [("tauri-plugin-http", "2.5.9"), ("urlpattern", "0.3.0")] {
        assert!(
            lock.contains(&format!("name = \"{name}\"\nversion = \"{version}\"")),
            "{name} is no longer {version} in Cargo.lock — re-copy parse_url_pattern from the new \
             plugin source, re-verify this module, then update this pin"
        );
    }
}
