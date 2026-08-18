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
const APP_ROUTES: [(&str, &str); 7] = [
    ("GET", "/chats"),
    ("GET", "/chats/:jid/history"),
    ("GET", "/chats/:jid/messages"),
    ("POST", "/chats/:jid/messages"),
    // Surface v2 (ADR-0034, TASK-20260817-telepath): the hint long-poll and the image
    // reads. All GET; media and picture ride the same 1 MiB while-reading response cap.
    ("GET", "/events"),
    ("GET", "/chats/:jid/media/:id"),
    ("GET", "/chats/:jid/picture"),
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

/// Does `path` match `pattern`, where any `:param` segment (`:jid`, `:id`) stands for
/// exactly one non-empty segment? The traversal guard, not the segment pattern, is what
/// refuses `..`-shaped values — same division of labor as the TypeScript twin.
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
            if pattern_segment.starts_with(':') {
                !path_segment.is_empty()
            } else {
                pattern_segment == path_segment
            }
        })
}

/// The WIZARD-reachable routes: the whole enumerated contract, pairing included.
///
/// The wizard is the surface that CREATES the credential — start a link, render the QR, poll
/// for the scan, then prove the minted token (ADR-0025). Apps get `APP_ROUTES` instead, which
/// deliberately omits every one of these.
///
/// The split is enforced by having TWO COMMANDS, not by a parameter: a `{ wizard: true }`
/// argument would be a claim the caller makes, and an app can make any claim. A separate
/// command inherits the C2 boundary instead — capabilities are scoped to the "main" window
/// and app iframes cannot reach the IPC bridge at all, which the in-shell gate asserts
/// per command. The wizard runs in the main window; an app never does.
const WIZARD_ROUTES: [(&str, &str); 11] = [
    ("POST", "/pair/start"),
    ("GET", "/pair/qr"),
    ("GET", "/pair/status"),
    ("GET", "/session/status"),
    // The app routes too: the wizard reads a thread list to prove the token works, and a
    // door that admitted only pairing would force a second command for that one read.
    ("GET", "/chats"),
    ("GET", "/chats/:jid/history"),
    ("GET", "/chats/:jid/messages"),
    ("POST", "/chats/:jid/messages"),
    ("GET", "/events"),
    ("GET", "/chats/:jid/media/:id"),
    ("GET", "/chats/:jid/picture"),
];

/// EVERY pre-flight guard for an APP request, in one place. Both `sidecar_fetch` and the
/// tests call THIS — there is no second admission path that could drift from the tested one.
pub fn admit_app_request(method: &str, path_and_query: &str) -> Result<AdmittedSidecarRequest, SidecarRefusal> {
    admit_against(method, path_and_query, &APP_ROUTES)
}

/// The wizard's admission. Same guards, wider table.
///
/// Shares `admit_against` rather than repeating the traversal and method checks, because a
/// second copy of those is how the two doors end up disagreeing about what `%2e%2e` means —
/// and the weaker one would then be the one worth attacking.
pub fn admit_wizard_request(method: &str, path_and_query: &str) -> Result<AdmittedSidecarRequest, SidecarRefusal> {
    admit_against(method, path_and_query, &WIZARD_ROUTES)
}

fn admit_against(
    method: &str,
    path_and_query: &str,
    routes: &[(&str, &str)],
) -> Result<AdmittedSidecarRequest, SidecarRefusal> {
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

    let admitted = routes
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
            // Through `socket_path`, not a second `join`: that function documents itself as
            // the owner of this rule, and a rule whose only caller is its own test is a
            // comment the compiler cannot check.
            let socket = socket_path(&dir, SOCKET_BASENAME);

            // PREFLIGHT, before anything is spawned (both added 2026-08-17 after the owner
            // hit "the WhatsApp helper could not be started" on real hardware). A GUI app
            // inherits a minimal PATH, so the `node` found here is often NOT the one on a
            // developer's shell PATH — the owner's resolved to v18, and baileys needs 20+.
            // Checking after the fact is not enough: `spawn` succeeds the instant the process
            // exists, so a runtime that dies on its first import looks like a clean start.
            if let Some(refusal) = helper_entry_refusal(&dir) {
                return Err(refusal);
            }
            node_version_preflight()?;

            // A stale socket file from a crashed run would make bind fail; removing it is
            // safe because this path is ours and nothing else may write it.
            let _ = std::fs::remove_file(&socket);
            let nonce = mint_nonce();
            let mut child = std::process::Command::new("node")
                .arg("--enable-source-maps")
                .arg(helper_entry(&dir))
                .env("SNUG_SIDECAR_SOCKET", &socket)
                .env("SNUG_SIDECAR_NONCE", &nonce)
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("could not start the WhatsApp helper: {e}"))?;

            // DID IT SURVIVE? `spawn` only proves the process was created. The helper binds
            // its socket within milliseconds, so a short wait distinguishes "running" from
            // "exited immediately" — and the difference matters enormously to the user, who
            // was previously told the helper could not start when it started and then died.
            std::thread::sleep(std::time::Duration::from_millis(600));
            if let Ok(Some(status)) = child.try_wait() {
                let mut detail = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = stderr.read_to_string(&mut buf);
                    // The helper's own last words are the most useful thing we have, but they
                    // are a subprocess's stderr: cap them, and keep them out of any route.
                    detail = buf.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
                    detail.truncate(400);
                }
                let _ = std::fs::remove_file(&socket);
                return Err(format!(
                    "the WhatsApp helper started and then stopped ({status}). {detail}"
                ));
            }
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

/// The oldest Node the helper can run on — pinned against baileys' own `engines.node`.
///
/// Its `lru-cache` dependency imports `tracingChannel` from `node:diagnostics_channel`, which
/// Node 18 does not export, so an old runtime does not degrade: it dies on the first import.
const MIN_NODE_MAJOR: u32 = 20;

/// Parse `node --version` output (`v22.13.1`) into its major.
///
/// Returns `None` for anything unrecognized, and the CALLER treats `None` as "cannot vouch
/// for this runtime". Guessing that an unparseable version is new enough is how this bug
/// would ship a second time.
fn parse_node_major(output: &str) -> Option<u32> {
    let trimmed = output.trim().trim_start_matches('v');
    let major = trimmed.split('.').next()?;
    if major.is_empty() {
        return None;
    }
    major.parse::<u32>().ok()
}

fn node_major_is_supported(major: u32) -> bool {
    major >= MIN_NODE_MAJOR
}

/// The refusal a too-old runtime earns. Names the version found, the version needed, and the
/// thing to fix — "could not be started" named none of those, which is why it was useless.
fn node_version_refusal(found: u32) -> String {
    format!(
        "the WhatsApp helper needs Node {MIN_NODE_MAJOR} or newer, but this computer runs \
         Node {found}. Snug launches the helper with whatever `node` the system provides, \
         which on macOS is often an older one than your terminal uses. Install Node \
         {MIN_NODE_MAJOR}+ system-wide (or symlink your newer node into /usr/local/bin) and \
         try again."
    )
}

/// Refuse before spawning when the helper is not installed.
///
/// Packaging the helper into the app bundle is deliberately out of scope (v1 spawns the
/// system `node` against `~/Snug/helpers/`), so a missing helper is an ordinary state that
/// deserves an instruction rather than a spawn failure whose message names the wrong problem.
fn helper_entry_refusal(snug_dir: &std::path::Path) -> Option<String> {
    let entry = helper_entry(snug_dir);
    if entry.is_file() {
        return None;
    }
    Some(format!(
        "the WhatsApp helper is not installed — expected it at {}. Build and install it with \
         `pnpm --filter whatsapp-sidecar build && pnpm --filter whatsapp-sidecar install:helper`.",
        entry.display()
    ))
}

/// Ask the `node` this shell would actually spawn for its version.
///
/// Deliberately the SAME bare `node` the spawn uses, not a path we resolved separately: the
/// whole failure was that the GUI's `node` differs from the developer's, so a preflight that
/// asked a different binary would vouch for the wrong one.
fn node_version_preflight() -> Result<(), String> {
    let output = std::process::Command::new("node")
        .arg("--version")
        .output()
        .map_err(|e| {
            format!(
                "could not find Node on this computer ({e}). The WhatsApp helper runs on Node \
                 {MIN_NODE_MAJOR}+; install it and try again."
            )
        })?;
    let text = String::from_utf8_lossy(&output.stdout);
    match parse_node_major(&text) {
        Some(major) if node_major_is_supported(major) => Ok(()),
        Some(major) => Err(node_version_refusal(major)),
        None => Err(format!(
            "could not read the version of Node on this computer. The WhatsApp helper runs on \
             Node {MIN_NODE_MAJOR}+."
        )),
    }
}

/// Call the helper over its unix socket.
///
/// `headers` carries the EXECUTOR's injected values — the minted access token among them —
/// because the helper requires it on every route. The app never sees them: the executor
/// injects and hands back a scrubbed answer, the same C1 posture as the network path.
///
/// Every guard runs in `admit_app_request` BEFORE a socket is opened. `/pair/*` and
/// `/session/*` are refused here unconditionally — an app that reached them could mint
/// itself the access token and drive the user's WhatsApp.
#[tauri::command]
pub async fn sidecar_fetch(
    method: String,
    path_and_query: String,
    body: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
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
    send_over_unix_socket_with_headers(&socket, &admitted, body.as_deref(), None, headers.as_ref()).await
}

/// The WIZARD's transport: the same socket, the wider table (pairing routes included).
///
/// A SEPARATE COMMAND, not a flag on the one above. The distinction that matters is "who is
/// calling", and a parameter is a claim the caller makes — an app could make the same one.
/// Command identity is not forgeable from an app iframe: capabilities are scoped to the main
/// window, app iframes cannot reach the IPC bridge, and the in-shell gate asserts that per
/// command. So the boundary is structural rather than checked.
///
/// This command carries the spawn nonce automatically — the wizard proves it is the surface
/// that started the helper, and the nonce never crosses into the webview's control (it is
/// read from shell state here, not accepted as a parameter).
#[tauri::command]
pub async fn sidecar_wizard_fetch(
    method: String,
    path_and_query: String,
    body: Option<String>,
    state: tauri::State<'_, SidecarState>,
) -> Result<SidecarResponse, String> {
    let admitted = admit_wizard_request(&method, &path_and_query).map_err(|refusal| refusal.message())?;
    let (socket, nonce) = {
        let guard = state.inner.lock().map_err(|_| "sidecar state is poisoned".to_string())?;
        match guard.as_ref() {
            Some(running) => (running.socket.clone(), running.nonce.clone()),
            None => return Err(SidecarRefusal::NotRunning.message()),
        }
    };
    send_over_unix_socket_with_nonce(&socket, &admitted, body.as_deref(), Some(&nonce)).await
}

/// The transport, with the wizard's spawn nonce when the caller is the wizard.
///
/// Hand-rolled rather than pulled from a client crate because the surface is a handful of
/// routes and the cap must be enforced WHILE READING — a client that buffers first would
/// defeat the bound before this code saw a byte.
///
/// The nonce is read from SHELL STATE by the caller and never accepted from the webview: it
/// is what proves to the helper that this request came from the process that started it, so a
/// value the webview could set would prove nothing at all.
async fn send_over_unix_socket_with_nonce(
    socket: &std::path::Path,
    request: &AdmittedSidecarRequest,
    body: Option<&str>,
    spawn_nonce: Option<&str>,
) -> Result<SidecarResponse, String> {
    send_over_unix_socket_with_headers(socket, request, body, spawn_nonce, None).await
}

async fn send_over_unix_socket_with_headers(
    socket: &std::path::Path,
    request: &AdmittedSidecarRequest,
    body: Option<&str>,
    spawn_nonce: Option<&str>,
    extra_headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<SidecarResponse, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|e| format!("could not reach the WhatsApp helper: {e}"))?;

    let payload = body.unwrap_or("");
    // `x-snug-spawn-nonce` — one spelling, shared with the helper's router and pinned by the
    // cross-language contract test. The helper requires it on every wizard-only route.
    let nonce_header = match spawn_nonce {
        Some(nonce) => format!("x-snug-spawn-nonce: {nonce}\r\n"),
        None => String::new(),
    };
    // Injected headers, rendered with CR/LF stripped from both name and value: a header value
    // carrying a newline could otherwise inject a second header (or a whole second request)
    // into the stream. The values here come from the host's own credential store, but a
    // transport that only holds when its input is trusted is one refactor from not holding.
    let mut injected = String::new();
    if let Some(map) = extra_headers {
        let mut names: Vec<&String> = map.keys().collect();
        names.sort(); // deterministic order — a stable request is a debuggable one
        for name in names {
            let clean_name: String = name.chars().filter(|c| *c != '\r' && *c != '\n').collect();
            if clean_name.is_empty() || clean_name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            let value = map.get(name).map(String::as_str).unwrap_or_default();
            let clean_value: String = value.chars().filter(|c| *c != '\r' && *c != '\n').collect();
            injected.push_str(&format!("{clean_name}: {clean_value}\r\n"));
        }
    }
    let head = format!(
        "{} {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n{}{}Content-Length: {}\r\n\r\n",
        request.method,
        request.path,
        nonce_header,
        injected,
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
    fn admits_exactly_the_seven_app_routes() {
        for (method, path) in [
            ("GET", "/chats"),
            ("GET", "/chats/123@g.us/history"),
            ("GET", "/chats/123@g.us/messages"),
            ("POST", "/chats/123@g.us/messages"),
            ("GET", "/events"),
            ("GET", "/events?cursor=42"),
            ("GET", "/chats/123@g.us/media/3EB0C127A2"),
            ("GET", "/chats/123@g.us/picture"),
        ] {
            assert!(
                admit_app_request(method, path).is_ok(),
                "{method} {path} must be admitted"
            );
        }
    }

    #[test]
    fn surface_v2_routes_stay_method_pinned_and_shape_pinned() {
        // The hint stream is read-only from every consumer, and the image reads are reads.
        for (method, path) in [
            ("POST", "/events"),
            ("POST", "/chats/1@g.us/media/IMG1"),
            ("POST", "/chats/1@g.us/picture"),
            ("GET", "/events/anything"),
            ("GET", "/chats/1@g.us/media"),
            ("GET", "/chats/1@g.us/media/a/b"),
        ] {
            assert!(
                matches!(admit_app_request(method, path), Err(SidecarRefusal::Route(_))),
                "{method} {path} must be refused"
            );
        }
    }

    #[test]
    fn refuses_traversal_through_the_id_segment() {
        // The new `:id` placeholder inherits the :jid lesson verbatim: `..` is a legal
        // single segment, so `/chats/1@g.us/media/..` MATCHES the pattern and only the
        // traversal guard stands between it and a socket.
        for path in [
            "/chats/1@g.us/media/..",
            "/chats/1@g.us/media/%2e%2e",
            "/chats/../media/x",
            "/chats/1@g.us/media/..%2fpicture",
        ] {
            assert!(
                matches!(admit_app_request("GET", path), Err(SidecarRefusal::Traversal(_))),
                "{path} must be refused as traversal"
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

#[cfg(test)]
mod spawn_preconditions_tests {
    use super::*;

    // ---------------------------------------------------------------- node version
    //
    // FOUND ON REAL HARDWARE (2026-08-17), not by a test. The owner clicked "start linking"
    // and got "the WhatsApp helper could not be started". Cause: a macOS GUI app inherits a
    // minimal PATH, so `Command::new("node")` resolved `/usr/local/bin/node` (v18.18.0) —
    // NOT the nvm v22 on the developer's shell PATH. Baileys declares `engines.node >= 20`,
    // and its lru-cache dependency imports `tracingChannel` from `node:diagnostics_channel`,
    // which v18 does not export. The helper died on its first import.
    //
    // TWO defects, and the second is why the message was useless: `spawn()` reports success
    // as soon as the process EXISTS, so a child that dies a millisecond later is invisible
    // here. The user was told the helper "could not be started" when it had started fine and
    // then exited — an error that points at the wrong thing costs more than no error.

    #[test]
    fn node_version_output_is_parsed_into_a_major() {
        assert_eq!(parse_node_major("v22.13.1\n"), Some(22));
        assert_eq!(parse_node_major("v20.0.0"), Some(20));
        assert_eq!(parse_node_major("v18.18.0\n"), Some(18));
        // Unparseable output must not read as "new enough" — an unknown version is a version
        // we cannot vouch for, and guessing high is how this bug ships twice.
        assert_eq!(parse_node_major("not a version"), None);
        assert_eq!(parse_node_major(""), None);
    }

    #[test]
    fn the_minimum_matches_what_the_helper_actually_needs() {
        // Pinned against baileys' own `engines.node`. If that floor rises, this fails loudly
        // rather than letting a too-old runtime through to a mystifying import error.
        assert_eq!(MIN_NODE_MAJOR, 20);
    }

    #[test]
    fn a_too_old_node_is_refused_by_NAME_and_says_what_to_do() {
        let refusal = node_version_refusal(18);
        assert!(refusal.contains("18"), "names the version actually found: {refusal}");
        assert!(refusal.contains("20"), "names the version required: {refusal}");
        // The message must be actionable. "could not be started" was not.
        assert!(
            refusal.to_lowercase().contains("node"),
            "names the thing to fix: {refusal}"
        );
    }

    #[test]
    fn a_new_enough_node_produces_no_refusal() {
        assert!(node_major_is_supported(20));
        assert!(node_major_is_supported(22));
        assert!(!node_major_is_supported(18));
    }

    // ---------------------------------------------------------------- missing helper

    #[test]
    fn a_missing_helper_entry_is_named_before_anything_is_spawned() {
        let dir = tempfile::tempdir().expect("tempdir");
        let refusal = helper_entry_refusal(dir.path()).expect("a missing helper must be refused");
        assert!(
            refusal.contains("helper"),
            "names what is missing: {refusal}"
        );
        // The path is named so the owner can see WHERE it was expected — this is a dev/owner
        // install step (packaging is out of scope), so "install it" needs a location.
        assert!(
            refusal.contains("whatsapp-sidecar"),
            "names the expected location: {refusal}"
        );
    }

    #[test]
    fn a_present_helper_entry_passes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let entry = helper_entry(dir.path());
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("mkdir");
        std::fs::write(&entry, "// helper").expect("write");
        assert!(helper_entry_refusal(dir.path()).is_none());
    }
}

#[cfg(test)]
mod state_registration_tests {
    //! EVERY command that takes a `tauri::State<T>` needs `T` registered with `.manage()`.
    //!
    //! FOUND ON REAL HARDWARE (2026-08-17), after two wrong diagnoses of the same symptom.
    //! `sidecar_ctl` and `sidecar_fetch` both take `tauri::State<'_, SidecarState>`, and
    //! `SidecarState` was never managed in `lib.rs` — so Tauri failed the invoke BEFORE the
    //! command body ran. The wizard reported "the WhatsApp helper could not be started",
    //! which is what its catch says for any thrown invoke, and every subsequent fix inside
    //! the command was invisible because the command never executed.
    //!
    //! This is the Phase G shape repeating: the commands were written, unit-tested, and
    //! registered in the handler list — three green signals — while the one wiring step that
    //! makes them callable was missing, and nothing anywhere asserted it. A command's tests
    //! prove what it does WHEN CALLED; they say nothing about whether it can be called.
    //!
    //! Parses `lib.rs` rather than restating its contents, the same discipline the Rust/TS
    //! route-table equivalence test uses: a hand-copied expectation drifts silently.

    const LIB_RS: &str = include_str!("lib.rs");

    #[test]
    fn sidecar_state_is_managed() {
        assert!(
            LIB_RS.contains(".manage(sidecar::SidecarState::default())")
                || LIB_RS.contains(".manage(SidecarState::default())"),
            "SidecarState must be registered with .manage() or every sidecar_ctl/sidecar_fetch \
             invoke fails before the command body runs"
        );
    }

    #[test]
    fn every_managed_state_the_sidecar_commands_need_is_registered() {
        // Non-vacuity: prove this test can SEE the manage calls at all, so a refactor that
        // renamed or moved them cannot leave the assertion above passing against nothing.
        assert!(
            LIB_RS.contains(".manage("),
            "lib.rs should carry .manage() registrations; if this fails the parse is wrong, \
             not the code"
        );
        // The sibling state, pinned so the two cannot diverge in how they are registered.
        assert!(LIB_RS.contains("OpenedFiles::default()"), "OpenedFiles stays managed");
    }

    #[test]
    fn the_commands_really_do_take_managed_state() {
        // The reason the test above matters. If these signatures ever stop taking State,
        // the manage requirement changes and this file should be revisited deliberately.
        const SELF_SRC: &str = include_str!("sidecar.rs");
        let ctl = SELF_SRC
            .split("pub async fn sidecar_ctl")
            .nth(1)
            .expect("sidecar_ctl exists");
        assert!(
            ctl[..400].contains("tauri::State<'_, SidecarState>"),
            "sidecar_ctl takes SidecarState — that is why it must be managed"
        );
        let fetch = SELF_SRC
            .split("pub async fn sidecar_fetch")
            .nth(1)
            .expect("sidecar_fetch exists");
        assert!(
            fetch[..400].contains("tauri::State<'_, SidecarState>"),
            "sidecar_fetch takes SidecarState — that is why it must be managed"
        );
    }
}

#[cfg(test)]
mod wizard_admission_tests {
    //! THE WIZARD'S OWN ADMISSION (added 2026-08-17, after the owner hit
    //! "the WhatsApp helper stopped answering" at the pairing step).
    //!
    //! ADR-0032 §4 says `/pair/*` is "reachable from the wizard only, never from an app".
    //! Phase G implemented the second half and not the first: there was ONE command,
    //! `sidecar_fetch`, refusing every pairing route unconditionally — so the wizard, which
    //! calls the same command, could not start a link either. The refusal was correct and
    //! total, and totality was the bug.
    //!
    //! The fix is a SECOND command rather than a parameter, because the security property
    //! must not be forgeable by its caller. A `{ wizard: true }` argument would be a claim an
    //! app could also make; a separate command inherits the C2 boundary instead — app iframes
    //! cannot reach the IPC bridge at all (capabilities are scoped to the "main" window, and
    //! the in-shell gate asserts unreachability per command). The wizard runs in the main
    //! window; an app never does.

    use super::*;

    #[test]
    fn the_wizard_may_reach_every_pairing_route() {
        // Exactly the four the wizard drives: start, qr, poll, and the ADR-0025 verify.
        for (method, path) in [
            ("POST", "/pair/start"),
            ("GET", "/pair/qr"),
            ("GET", "/pair/status"),
            ("GET", "/session/status"),
        ] {
            assert!(
                admit_wizard_request(method, path).is_ok(),
                "the wizard must reach {method} {path} — it is the pairing flow"
            );
        }
    }

    #[test]
    fn the_wizard_may_NOT_reach_arbitrary_paths() {
        // A wizard command is not a general local HTTP client either. The enumerated
        // contract still bounds it; only the app/wizard SPLIT differs.
        for (method, path) in [("GET", "/etc/passwd"), ("POST", "/pair/../chats"), ("GET", "/admin")] {
            assert!(
                admit_wizard_request(method, path).is_err(),
                "{method} {path} is outside the contract and must be refused"
            );
        }
    }

    #[test]
    fn the_wizard_admission_refuses_traversal_on_the_decoded_form() {
        // `%2e%2e` defeats a literal `..` scan; the app path already refuses this and the
        // wizard path must not be the weaker twin.
        assert!(admit_wizard_request("GET", "/pair/%2e%2e/chats").is_err());
        assert!(admit_wizard_request("GET", "/pair/../chats").is_err());
    }

    #[test]
    fn the_APP_admission_still_refuses_every_pairing_route() {
        // THE PROPERTY THIS SPLIT EXISTS TO PRESERVE. Adding a wizard door must not open the
        // app's. `/pair/status` releases the access token: an app reaching it could mint
        // itself a credential and drive the user's WhatsApp (blocker B5).
        for (method, path) in [
            ("POST", "/pair/start"),
            ("GET", "/pair/qr"),
            ("GET", "/pair/status"),
            ("GET", "/session/status"),
        ] {
            assert!(
                admit_app_request(method, path).is_err(),
                "an app must NEVER reach {method} {path}"
            );
        }
    }

    #[test]
    fn the_two_admissions_are_not_the_same_function() {
        // Non-vacuity: if a refactor ever made these aliases, the test above would pass while
        // the boundary vanished. One admits a pairing route; the other refuses it.
        assert!(admit_wizard_request("GET", "/pair/qr").is_ok());
        assert!(admit_app_request("GET", "/pair/qr").is_err());
    }

    #[test]
    fn the_wizard_may_also_reach_the_app_routes() {
        // The wizard's probe reads a thread list to prove the token works. A wizard door that
        // admitted ONLY pairing would force a second command for that.
        assert!(admit_wizard_request("GET", "/chats").is_ok());
    }
}
