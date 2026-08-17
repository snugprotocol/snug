//! `sidecar_ctl` and `sidecar_fetch` — the WhatsApp helper's lifecycle and its transport
//! (ADR-0032, TASK-20260816).
//!
//! WHY THIS EXISTS AS A DEDICATED COMMAND rather than a host in a connection's ceiling.
//! The first draft of this task gave the helper a loopback address and a port, and put
//! `127.0.0.1` into the frozen ceiling. Three facts, each independently fatal, killed it:
//!
//!   1. The ceiling is HOST-granular — `isHostAllowed` compares `new URL(url).hostname`,
//!      which drops the port — and `CONNECTION_HOST_RULE` is LDH-only, so `127.0.0.1:8787`
//!      cannot even be stored. The only representable entry, bare `127.0.0.1`, admits
//!      EVERY loopback port on the machine: the container runtime, the local model server,
//!      database admin surfaces, another app's helper.
//!   2. `isForbiddenNetHost` refuses loopback unconditionally, and says why in its own
//!      comment: "an approved ceiling containing 127.0.0.1 is still refused at this gate."
//!      That guard was installed against exactly this.
//!   3. `lanfetch.rs` already anticipated the request: its host-class comment records that
//!      loopback is refused "because it is not RFC-1918, and so a future change to this
//!      policy must make its own decision about it, not inherit one meant for 'local'."
//!
//! So the helper is not a host at all. It listens on a UNIX-DOMAIN SOCKET whose path THIS
//! MODULE owns, and the webview can neither name it nor reach it any other way. There is no
//! port to race for, and filesystem permissions (0600) decide who may connect rather than
//! bind order. The general executor path is untouched: `isForbiddenNetHost`,
//! `transportPolicy`, and the capability belt all keep their current values, so the browser
//! profile stays byte-identical and `netTransportCapability.test.ts`'s two-port assertion
//! passes unmodified.
//!
//! WHAT IS ENFORCED HERE, IN RUST, BEFORE A SOCKET IS OPENED — because the TS caller is not
//! the last word on what the shell will dial (the `lan_fetch` precedent):
//!   * METHOD + PATH against the enumerated contract, with `/pair/*` and `/session/*`
//!     refused outright on the app-facing path. Those routes MINT and release the access
//!     token, so an app able to reach them could mint itself a credential.
//!   * Traversal refused on the decoded form, because `..` is a legal path segment and
//!     `%2e%2e` defeats a literal scan.
//!   * A response size cap, enforced while reading, before bytes cross IPC.
//!
//! The socket path and the spawn nonce are generated here and handed to the child process;
//! neither is ever accepted as a parameter. A caller that could name the socket could point
//! this transport at any socket on the machine — the same class of defect as letting it name
//! a host.

use std::path::PathBuf;

/// The app-facing routes, mirroring `APP_REACHABLE_SIDECAR_ROUTES` in
/// `packages/protocol/src/sidecar-contract.ts`.
///
/// A DELIBERATE RESTATEMENT, exactly like `is_rfc1918_ipv4_literal` restates its TypeScript
/// twin: this crate sits on the far side of an IPC boundary and cannot import TypeScript.
/// The equivalence is pinned by a cross-language test (`sidecarContract.test.ts` reads this
/// file), so a drift fails loudly rather than becoming two guards that quietly disagree
/// about which routes an app may reach.
const APP_ROUTES: [(&str, &str); 4] = [
    ("GET", "/chats"),
    ("GET", "/chats/:jid/history"),
    ("GET", "/chats/:jid/messages"),
    ("POST", "/chats/:jid/messages"),
];

/// Response bytes accepted from the helper before the read is abandoned. Matches the net
/// frame class the executor already enforces; a helper that answered unboundedly would
/// otherwise be a memory exhaustion path into the webview.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Why a request never reached the socket. Separate variants because each is a distinct
/// story a human might have to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarRefusal {
    /// A method this transport does not carry.
    Method(String),
    /// A path outside the app-reachable contract (including every pairing route).
    Route(String),
    /// A path containing a traversal segment, in any encoding.
    Traversal(String),
    /// The helper is not running, so there is no socket to dial.
    NotRunning,
}

impl SidecarRefusal {
    pub fn message(&self) -> String {
        match self {
            SidecarRefusal::Method(method) => {
                format!("'{method}' is not a method this transport carries")
            }
            SidecarRefusal::Route(path) => format!(
                "'{path}' is not a route apps may reach — setup and pairing belong to the connection wizard"
            ),
            SidecarRefusal::Traversal(path) => {
                format!("'{path}' contains a path traversal and was refused")
            }
            SidecarRefusal::NotRunning => {
                "the WhatsApp helper is not running — open the connection settings to start it".into()
            }
        }
    }
}

/// An admitted request. Producing one IS the admission: a caller cannot reach the socket
/// without going through `admit_app_request`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedSidecarRequest {
    pub method: String,
    pub path: String,
}

/// Percent-decode enough to reason about separators and traversal.
///
/// Deliberately NOT a full URL decoder: the only question here is whether a path smuggles a
/// separator or a dot-segment through an encoding. A malformed escape returns `None` and the
/// caller fails closed — a value we cannot decode is a value we cannot reason about.
fn decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Does `path` match `pattern`, where `:jid` stands for exactly one non-empty segment?
fn route_matches(pattern: &str, path: &str) -> bool {
    let pattern_segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if pattern_segments.len() != path_segments.len() {
        return false;
    }
    // A leading-slash path that produced no segments is only legal for the root, which is
    // not a route — `filter` above would equate `/` and `//`, so length equality alone is
    // not enough for the empty case.
    if pattern_segments.is_empty() {
        return false;
    }
    pattern_segments
        .iter()
        .zip(path_segments.iter())
        .all(|(pattern_segment, path_segment)| {
            if *pattern_segment == ":jid" {
                !path_segment.is_empty()
            } else {
                pattern_segment == path_segment
            }
        })
}

/// EVERY pre-flight guard for an APP request, in one place. Both `sidecar_fetch` and the
/// tests call THIS — there is no second admission path that could drift from the tested one.
pub fn admit_app_request(method: &str, path_and_query: &str) -> Result<AdmittedSidecarRequest, SidecarRefusal> {
    let method_upper = method.to_ascii_uppercase();
    if method_upper != "GET" && method_upper != "POST" {
        return Err(SidecarRefusal::Method(method.to_string()));
    }
    if !path_and_query.starts_with('/') {
        return Err(SidecarRefusal::Route(path_and_query.to_string()));
    }
    let path = path_and_query
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();

    // Traversal, on the DECODED form and against the segment primitive rather than one
    // spelling. `..` is a legal single segment, so `/chats/../messages` matches the
    // `/chats/:jid/messages` pattern exactly — only this check refuses it — and `%2e%2e`
    // walks past any literal `..` scan.
    let decoded = match decode_path(&path) {
        Some(value) => value,
        None => return Err(SidecarRefusal::Traversal(path_and_query.to_string())),
    };
    if decoded
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(SidecarRefusal::Traversal(path_and_query.to_string()));
    }
    // A separator that survived encoding would let one segment become two after decoding,
    // so a decoded form with more segments than it started with is refused.
    if decoded != path && decoded.split('/').count() != path.split('/').count() {
        return Err(SidecarRefusal::Traversal(path_and_query.to_string()));
    }

    let admitted = APP_ROUTES
        .iter()
        .any(|(route_method, pattern)| *route_method == method_upper && route_matches(pattern, &path));
    if !admitted {
        return Err(SidecarRefusal::Route(path_and_query.to_string()));
    }
    Ok(AdmittedSidecarRequest {
        method: method_upper,
        path,
    })
}

/// Where the helper's socket lives, given `~/Snug`. Chosen HERE and never accepted from the
/// webview — the same rule the user-file commands follow for their directory.
pub fn socket_path(snug_dir: &std::path::Path, basename: &str) -> PathBuf {
    snug_dir.join(basename)
}

// ---------------------------------------------------------------- the commands
//
// Both are thin: every decision they make is delegated to the pure functions above, which
// is what makes the guards testable without a running Tauri app or a real helper process.

/// Shell-owned helper state. The socket path and the spawn nonce are generated HERE and
/// handed to the child; neither is ever accepted from the webview.
#[derive(Default)]
pub struct SidecarState {
    inner: std::sync::Mutex<Option<RunningSidecar>>,
}

pub struct RunningSidecar {
    child: std::process::Child,
    socket: PathBuf,
    /// Passed to the child at spawn; the wizard needs it to reach the pairing routes.
    nonce: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub running: bool,
    /// Present only while running — the wizard's pairing routes require it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// What crosses back over IPC from a helper call.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarResponse {
    pub status: u16,
    pub body: String,
}

/// 256 bits of CSPRNG, hex. The nonce is what stops a process that wins a race to the
/// socket path from completing pairing and minting itself the user's WhatsApp.
fn mint_nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Start, stop, or report the helper.
///
/// `start` is idempotent: a second call while one is running returns the SAME nonce rather
/// than spawning a rival that would race for the socket.
#[tauri::command]
pub async fn sidecar_ctl(
    action: String,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    let mut guard = state.inner.lock().map_err(|_| "sidecar state is poisoned".to_string())?;
    match action.as_str() {
        "status" => Ok(SidecarStatus {
            running: guard.is_some(),
            nonce: guard.as_ref().map(|s| s.nonce.clone()),
        }),
        "start" => {
            if let Some(running) = guard.as_ref() {
                return Ok(SidecarStatus {
                    running: true,
                    nonce: Some(running.nonce.clone()),
                });
            }
            // `snug_dir` is the ONE owner of this path rule (userfile.rs) — re-deriving it
            // here would be a second spelling of a decision that already shipped a
            // platform-ordering bug once.
            let dir = crate::userfile::snug_dir()?;
            std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            let socket = dir.join(SOCKET_BASENAME);
            // A stale socket file from a crashed run would make bind fail; removing it is
            // safe because this path is ours and nothing else may write it.
            let _ = std::fs::remove_file(&socket);
            let nonce = mint_nonce();
            let child = std::process::Command::new("node")
                .arg("--enable-source-maps")
                .arg(helper_entry(&dir))
                .env("SNUG_SIDECAR_SOCKET", &socket)
                .env("SNUG_SIDECAR_NONCE", &nonce)
                .spawn()
                .map_err(|e| format!("could not start the WhatsApp helper: {e}"))?;
            *guard = Some(RunningSidecar {
                child,
                socket,
                nonce: nonce.clone(),
            });
            Ok(SidecarStatus {
                running: true,
                nonce: Some(nonce),
            })
        }
        "stop" => {
            if let Some(mut running) = guard.take() {
                let _ = running.child.kill();
                let _ = running.child.wait();
                let _ = std::fs::remove_file(&running.socket);
            }
            Ok(SidecarStatus {
                running: false,
                nonce: None,
            })
        }
        other => Err(format!("'{other}' is not a sidecar action")),
    }
}

/// The helper's entry point, under `~/Snug/helpers/`. Never supplied by the webview, for
/// the same reason the socket path is not.
fn helper_entry(snug_dir: &std::path::Path) -> PathBuf {
    snug_dir.join("helpers").join("whatsapp-sidecar").join("index.js")
}

/// The socket file's basename. Mirrors `SIDECAR_SOCKET_BASENAME` in the protocol contract;
/// the cross-language test pins the two equal.
pub const SOCKET_BASENAME: &str = "whatsapp-sidecar.sock";

/// Call the helper over its unix socket.
///
/// Every guard runs in `admit_app_request` BEFORE a socket is opened. `/pair/*` and
/// `/session/*` are refused here unconditionally — an app that reached them could mint
/// itself the access token and drive the user's WhatsApp.
#[tauri::command]
pub async fn sidecar_fetch(
    method: String,
    path_and_query: String,
    body: Option<String>,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarResponse, String> {
    let admitted = admit_app_request(&method, &path_and_query).map_err(|refusal| refusal.message())?;
    let socket = {
        let guard = state.inner.lock().map_err(|_| "sidecar state is poisoned".to_string())?;
        match guard.as_ref() {
            Some(running) => running.socket.clone(),
            None => return Err(SidecarRefusal::NotRunning.message()),
        }
    };
    send_over_unix_socket(&socket, &admitted, body.as_deref()).await
}

/// The transport itself: a minimal HTTP/1.1 exchange over the unix socket.
///
/// Hand-rolled rather than pulled from a client crate because the surface is four routes
/// and the cap must be enforced WHILE READING — a client that buffers first would defeat
/// the bound before this code saw a byte.
async fn send_over_unix_socket(
    socket: &std::path::Path,
    request: &AdmittedSidecarRequest,
    body: Option<&str>,
) -> Result<SidecarResponse, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|e| format!("could not reach the WhatsApp helper: {e}"))?;

    let payload = body.unwrap_or("");
    let head = format!(
        "{} {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        request.method,
        request.path,
        payload.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("could not write to the helper: {e}"))?;
    if !payload.is_empty() {
        stream
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("could not write to the helper: {e}"))?;
    }

    // THE CAP, enforced while reading. A helper that answered unboundedly would otherwise
    // be a memory-exhaustion path straight into the webview.
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("could not read from the helper: {e}"))?;
        if read == 0 {
            break;
        }
        if raw.len() + read > MAX_RESPONSE_BYTES {
            return Err("the helper's response was too large".into());
        }
        raw.extend_from_slice(&chunk[..read]);
    }

    parse_http_response(&raw)
}

/// Split an HTTP/1.1 response into its status and body. Deliberately minimal: this speaks to
/// one process we ship, over a socket only we can name.
fn parse_http_response(raw: &[u8]) -> Result<SidecarResponse, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "the helper's response was malformed".to_string())?;
    let status_line = head.lines().next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| "the helper's response had no status".to_string())?;
    Ok(SidecarResponse {
        status,
        body: body.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_exactly_the_four_app_routes() {
        for (method, path) in [
            ("GET", "/chats"),
            ("GET", "/chats/123@g.us/history"),
            ("GET", "/chats/123@g.us/messages"),
            ("POST", "/chats/123@g.us/messages"),
        ] {
            assert!(
                admit_app_request(method, path).is_ok(),
                "{method} {path} must be admitted"
            );
        }
    }

    #[test]
    fn refuses_every_pairing_route_by_both_verbs() {
        // THE TOKEN-CAPTURE REFUSAL. `/pair/status` releases the access token, so an app
        // able to reach it could mint itself a credential and drive the user's WhatsApp
        // without ever breaking the credential store.
        for path in ["/pair/start", "/pair/qr", "/pair/status", "/session/status"] {
            for method in ["GET", "POST"] {
                assert!(
                    matches!(
                        admit_app_request(method, path),
                        Err(SidecarRefusal::Route(_))
                    ),
                    "{method} {path} must be refused to apps"
                );
            }
        }
    }

    #[test]
    fn matches_on_method_as_well_as_path() {
        assert!(matches!(
            admit_app_request("POST", "/chats"),
            Err(SidecarRefusal::Route(_))
        ));
        assert!(matches!(
            admit_app_request("POST", "/chats/1@g.us/history"),
            Err(SidecarRefusal::Route(_))
        ));
    }

    #[test]
    fn refuses_methods_the_transport_does_not_carry() {
        for method in ["DELETE", "PUT", "PATCH", "OPTIONS", "TRACE"] {
            assert!(matches!(
                admit_app_request(method, "/chats"),
                Err(SidecarRefusal::Method(_))
            ));
        }
    }

    #[test]
    fn refuses_a_traversal_segment_the_route_pattern_would_otherwise_admit() {
        // `/chats/../messages` MATCHES `/chats/:jid/messages` — `..` is a legal segment —
        // so the pattern alone admits it and only the traversal guard refuses it. This is
        // the case a naive fixture misses, because every OTHER traversal spelling is
        // already refused by the pattern.
        for path in ["/chats/../messages", "/chats/../history"] {
            assert!(
                matches!(
                    admit_app_request("GET", path),
                    Err(SidecarRefusal::Traversal(_))
                ),
                "{path} must be refused as traversal"
            );
        }
    }

    #[test]
    fn refuses_percent_encoded_traversal() {
        // The attacker picks the spelling: `%2e%2e` is `..` and `%2f` is `/` to anything
        // that decodes before resolving.
        for path in [
            "/chats/%2e%2e/messages",
            "/chats/%2E%2E/messages",
            "/chats/..%2fpair%2fstatus/messages",
        ] {
            assert!(
                matches!(
                    admit_app_request("GET", path),
                    Err(SidecarRefusal::Traversal(_))
                ),
                "{path} must be refused as traversal"
            );
        }
    }

    #[test]
    fn refuses_malformed_percent_encoding_rather_than_passing_it_through() {
        for path in ["/chats/%zz/messages", "/chats/%2/messages", "/chats/%/messages"] {
            assert!(
                matches!(
                    admit_app_request("GET", path),
                    Err(SidecarRefusal::Traversal(_))
                ),
                "{path} must fail closed"
            );
        }
    }

    #[test]
    fn refuses_prefix_extension_and_unknown_paths() {
        for path in [
            "/chatsX",
            "/chats/1@g.us/messages/extra",
            "/",
            "/admin",
            "/chats/a/b/messages",
        ] {
            assert!(
                admit_app_request("GET", path).is_err(),
                "{path} must be refused"
            );
        }
    }

    #[test]
    fn refuses_a_path_that_is_not_absolute() {
        for path in ["chats", "../chats", "http://example.com/chats"] {
            assert!(admit_app_request("GET", path).is_err(), "{path} must be refused");
        }
    }

    #[test]
    fn ignores_a_query_string_and_never_admits_by_it() {
        assert!(admit_app_request("GET", "/chats/1@g.us/messages?since=42").is_ok());
        assert!(admit_app_request("GET", "/pair/status?x=1").is_err());
    }

    #[test]
    fn parses_a_well_formed_http_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let parsed = parse_http_response(raw).expect("must parse");
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, "{\"ok\":true}");
    }

    #[test]
    fn refuses_a_malformed_response_rather_than_guessing() {
        // No header/body separator, or no status: the helper is ours, so a malformed
        // answer means something is wrong — reporting it beats inventing a 200.
        assert!(parse_http_response(b"garbage with no separator").is_err());
        assert!(parse_http_response(b"NOTHTTP\r\n\r\nbody").is_err());
    }

    #[test]
    fn the_not_running_refusal_names_what_the_user_can_do() {
        // An error a user cannot act on is a bug report waiting to happen; this one says
        // where to go.
        let message = SidecarRefusal::NotRunning.message();
        assert!(message.contains("not running"));
        assert!(message.contains("connection settings"));
    }

    #[test]
    fn every_refusal_message_is_non_empty_and_names_its_subject() {
        // Each variant exists BECAUSE it is a distinct user-facing story; a variant whose
        // message dropped its subject would collapse back into an opaque failure.
        assert!(SidecarRefusal::Method("DELETE".into()).message().contains("DELETE"));
        assert!(SidecarRefusal::Route("/pair/status".into()).message().contains("/pair/status"));
        assert!(SidecarRefusal::Traversal("/chats/../x".into()).message().contains("/chats/../x"));
    }

    #[test]
    fn the_response_cap_is_the_net_frame_class() {
        // Pinned so a future edit cannot quietly raise it: the cap is what stops a helper
        // from being a memory-exhaustion path into the webview.
        assert_eq!(MAX_RESPONSE_BYTES, 1024 * 1024);
    }

    #[test]
    fn socket_path_is_under_the_snug_directory() {
        let path = socket_path(std::path::Path::new("/home/someone/Snug"), SOCKET_BASENAME);
        assert_eq!(
            path,
            PathBuf::from("/home/someone/Snug/whatsapp-sidecar.sock")
        );
    }
}
