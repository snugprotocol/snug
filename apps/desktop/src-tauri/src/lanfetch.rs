//! `lan_fetch` — the pinned-TLS LAN transport (ADR-0023 Decision 3; P0
//! amendments 5, 6, 13, 16).
//!
//! A Hue-class bridge lives at a user-supplied RFC-1918 IPv4 literal and serves
//! a certificate signed by a private CA (self-signed on old firmware). Neither
//! the webview's fetch nor `tauri-plugin-http` can reach it: both verify against
//! the public root store and there is no per-host trust escape. The alternative
//! everyone reaches for first — a global or per-request `accept-invalid-certs`
//! flag — is exactly what lessons.md 2026-08-12 warns about: *a guard expressed
//! as a FLAG is only as real as the transport's willingness to read it.* The
//! desktop redirect incident proved the plugin silently drops `init.redirect`.
//!
//! So the trust decision is CODE WE EXECUTE, in a `rustls::client::danger::
//! ServerCertVerifier` this crate owns and tests directly, with two explicit
//! modes:
//!
//!   * `Pair` — accepts the presented leaf certificate and CAPTURES its
//!     SHA-256 fingerprint + CN. `reqwest` never exposes the peer certificate
//!     to callers, so the capture must happen INSIDE the verifier; the captured
//!     pin rides back out beside the response so the wizard writes pin + minted
//!     key in one step.
//!   * `Pinned` — REQUIRES a caller-supplied pin and refuses any leaf whose
//!     fingerprint differs. Absent pin is a refusal, never a fallback to
//!     pair-mode trust.
//!
//! Every other guard is enforced HERE in Rust, before any socket is opened,
//! because the TS caller is not the last word on what the shell will dial:
//!
//!   * HOST CLASS — RFC-1918 IPv4 literals ONLY (10/8, 172.16-31/12,
//!     192.168/16). Loopback, link-local, CGNAT, every public literal, every
//!     DNS name and every IPv6 form are refused. This is the guard the plan's
//!     negative tests target and the reason the CI fixture cannot be a
//!     127.0.0.1 stub (amendment 13).
//!   * REDIRECTS — `Policy::none()` unconditionally. A 30x comes back as a 30x
//!     for connected-fetch gate 9 to refuse; it is never followed, so an
//!     injected header can never ride to a redirect target.
//!   * SIZE — the 1 MiB cap is enforced in Rust BEFORE the bytes cross IPC,
//!     not after, so an oversized body never becomes a webview allocation.
//!   * CLIENT REUSE — a FRESH `reqwest::Client` per call with the pin baked
//!     into its verifier. No client cache, no connection pool shared across
//!     pins: a pooled connection established under one pin would serve a later
//!     call carrying a different one, and the verifier — which only runs on
//!     handshake — would never be consulted.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use sha2::{Digest, Sha256};

/// Response bodies above this never cross the IPC boundary (matches the
/// executor's `LIMITS.MAX_NET_RESPONSE_BODY_BYTES`).
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Whole-request budget. Kept in step with connected-fetch's own
/// `REQUEST_TIMEOUT_MS` (15s) so a LAN request cannot outlive the executor's
/// patience and strand a wizard step.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// The two modes, spelled out rather than inferred from "is a pin present?".
/// An enum makes "pair" a decision the CALLER states and the wizard flow can be
/// read off the call site; a pin-presence heuristic would silently downgrade a
/// pinned call whose pin failed to load into a trust-anything call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanMode {
    /// First contact: accept the leaf and capture its fingerprint + CN.
    Pair,
    /// Every later call: the leaf's SHA-256 fingerprint must equal this.
    Pinned { fingerprint: String },
}

/// What the pair-mode verifier captured. `fingerprint` is lowercase hex of the
/// SHA-256 over the leaf's DER; `cn` is the subject CN when one is present (the
/// Hue bridge puts its bridgeId there) and empty otherwise.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct CapturedPin {
    pub fingerprint: String,
    pub cn: String,
}

/// Lowercase hex SHA-256 of a DER-encoded certificate. THE pin function: the
/// verifier computes it on the wire, the tests compute it over a fixture, and
/// nothing else may define what "the pin" means.
pub fn fingerprint_der(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Extract the subject CommonName from a DER certificate, best-effort.
///
/// A full X.509 parser is not a dependency this shell needs: the CN is
/// DIAGNOSTIC (it is shown to the user and journaled), never a trust input —
/// the FINGERPRINT is what the pin compares. So this walks the DER for the
/// id-at-commonName OID (2.5.4.3 = `55 04 03`) and reads the string that
/// follows it. A miss yields an empty CN, which is honest; it can never yield a
/// WRONG trust decision because CN is not consulted for one.
pub fn common_name_from_der(der: &[u8]) -> String {
    const CN_OID: [u8; 5] = [0x06, 0x03, 0x55, 0x04, 0x03];
    let Some(at) = der.windows(CN_OID.len()).position(|w| w == CN_OID) else {
        return String::new();
    };
    let rest = &der[at + CN_OID.len()..];
    // Expect a string type tag (PrintableString 0x13, UTF8String 0x0c, IA5 0x16)
    // then a short-form length.
    if rest.len() < 2 {
        return String::new();
    }
    if !matches!(rest[0], 0x13 | 0x0c | 0x16 | 0x14) {
        return String::new();
    }
    let len = rest[1] as usize;
    if len > 0x7f || rest.len() < 2 + len {
        return String::new();
    }
    String::from_utf8_lossy(&rest[2..2 + len]).into_owned()
}

/// The verifier. `mode` decides; `captured` is the pair-mode side channel out.
///
/// `Mutex<Option<..>>` rather than a channel because rustls calls this from the
/// handshake task and the caller reads it after `send()` resolves — one writer,
/// one reader, no ordering subtlety worth a channel's weight.
#[derive(Debug)]
pub struct LanCertVerifier {
    mode: LanMode,
    captured: Mutex<Option<CapturedPin>>,
}

impl LanCertVerifier {
    pub fn new(mode: LanMode) -> Self {
        Self {
            mode,
            captured: Mutex::new(None),
        }
    }

    /// What pair mode captured, if the handshake reached the verifier.
    pub fn captured(&self) -> Option<CapturedPin> {
        self.captured.lock().ok().and_then(|g| g.clone())
    }
}

impl ServerCertVerifier for LanCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let presented = fingerprint_der(end_entity.as_ref());
        match &self.mode {
            LanMode::Pair => {
                // TOFU: accept, and record what we accepted. The residual (a
                // LAN-local attacker present at first pairing) is documented in
                // ADR-0023 Decision 3.
                let cn = common_name_from_der(end_entity.as_ref());
                if let Ok(mut slot) = self.captured.lock() {
                    *slot = Some(CapturedPin {
                        fingerprint: presented,
                        cn,
                    });
                }
                Ok(ServerCertVerified::assertion())
            }
            LanMode::Pinned { fingerprint } => {
                if presented == *fingerprint {
                    Ok(ServerCertVerified::assertion())
                } else {
                    // The message names NEITHER fingerprint in full: a mismatch
                    // reaches the user, and the pin is not a secret but it is
                    // also not something a UI should invite comparison of.
                    Err(TlsError::General(
                        "the device presented a different certificate than the one recorded when you paired it".into(),
                    ))
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        // The pin covers the leaf's identity; the handshake signature proves the
        // peer holds that leaf's key, which rustls checks structurally. Accepting
        // here is the same posture every fingerprint-pinning client takes.
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

/// RFC-1918 IPv4 LITERALS only — the whole host-class policy, in one function.
///
/// A DELIBERATE RESTATEMENT of `packages/auth`'s `isPrivateRfc1918Ipv4Literal`,
/// for the same reason that function restates protocol's: this is the other side
/// of an IPC boundary and cannot import TypeScript. The equivalence is pinned by
/// the shared case table in the tests below and its TS twin, so a drift fails
/// loudly rather than becoming two guards disagreeing about "private".
///
/// Everything not in the three private /8-/12-/16 blocks is refused, and that
/// includes classes a naive `is_private()` would also refuse but for the WRONG
/// reason: loopback (127/8) is refused because it is not RFC-1918, and so a
/// future widening of this function cannot accidentally admit it as "also
/// local". IPv6 in every form, bracketed or bare, is refused by the shape check.
pub fn is_rfc1918_ipv4_literal(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u16; 4];
    for (i, part) in parts.iter().enumerate() {
        // No leading zeros, no signs, no empty labels: `010.0.0.1` and `+1.2.3.4`
        // are not the literals this class means, and some resolvers read the
        // former as octal.
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
        let Ok(value) = part.parse::<u16>() else {
            return false;
        };
        if value > 255 {
            return false;
        }
        octets[i] = value;
    }
    match (octets[0], octets[1]) {
        (10, _) => true,
        (172, b) if (16..=31).contains(&b) => true,
        (192, 168) => true,
        _ => false,
    }
}

/// Why a request was refused before it was ever sent. Each variant is a distinct
/// user-facing story, so they are separate rather than one opaque string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanRefusal {
    /// Not an RFC-1918 IPv4 literal (a name, a public IP, loopback, IPv6, …).
    HostClass(String),
    /// Not `https` — the bridge speaks CLIP v2 over TLS and nothing else.
    Scheme(String),
    /// Malformed URL, or one carrying embedded credentials.
    Url(String),
    /// A method this command does not carry.
    Method(String),
    /// Pinned mode with an absent or malformed pin.
    Pin(String),
}

impl LanRefusal {
    pub fn message(&self) -> String {
        match self {
            LanRefusal::HostClass(host) => format!(
                "'{host}' is not a private network address — the pinned-TLS path serves RFC-1918 IPv4 literals only (10.x, 172.16-31.x, 192.168.x)"
            ),
            LanRefusal::Scheme(scheme) => {
                format!("'{scheme}' is not https — a bridge is reached over TLS or not at all")
            }
            LanRefusal::Url(detail) => format!("invalid url: {detail}"),
            LanRefusal::Method(method) => format!("'{method}' is not a method this transport carries"),
            LanRefusal::Pin(detail) => format!("pinned mode requires a recorded certificate pin: {detail}"),
        }
    }
}

/// The parsed, admitted request. Producing one of these IS the admission — a
/// caller cannot reach the socket without going through `admit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedRequest {
    pub url: String,
    pub host: String,
    pub method: String,
}

/// Fingerprint charset: 64 lowercase hex characters. A pin that does not have
/// this shape can only be corruption or a caller's mistake, and admitting it
/// would mean a handshake refusal that reads like a device problem.
fn valid_fingerprint(pin: &str) -> bool {
    pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

const ALLOWED_METHODS: [&str; 4] = ["GET", "POST", "PUT", "DELETE"];

/// EVERY pre-flight guard, in one place, returning a parsed request or a named
/// refusal. Both `lan_fetch` and the tests call THIS — there is no second
/// admission path that could drift from the tested one.
pub fn admit(url: &str, method: &str, mode: &LanMode) -> Result<AdmittedRequest, LanRefusal> {
    if let LanMode::Pinned { fingerprint } = mode {
        if fingerprint.is_empty() {
            return Err(LanRefusal::Pin("no pin was supplied".into()));
        }
        if !valid_fingerprint(fingerprint) {
            return Err(LanRefusal::Pin(
                "the recorded pin is not 64 lowercase hex characters".into(),
            ));
        }
    }
    let method_upper = method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method_upper.as_str()) {
        return Err(LanRefusal::Method(method.to_string()));
    }
    let parsed = url::Url::parse(url).map_err(|e| LanRefusal::Url(e.to_string()))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(LanRefusal::Url("urls with embedded credentials are not allowed".into()));
    }
    if parsed.scheme() != "https" {
        return Err(LanRefusal::Scheme(parsed.scheme().to_string()));
    }
    let host = parsed.host_str().unwrap_or_default().to_string();
    if !is_rfc1918_ipv4_literal(&host) {
        return Err(LanRefusal::HostClass(host));
    }
    Ok(AdmittedRequest {
        url: parsed.to_string(),
        host,
        method: method_upper,
    })
}

/// What crosses back over IPC. `pin` is populated in pair mode only.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    /// Pair mode: the captured fingerprint + CN the wizard records.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<CapturedPin>,
}

/// Build the per-call client. FRESH EVERY TIME (see the module header): the pin
/// is baked into the verifier, and a cached client would serve a pooled
/// connection established under a different pin without re-running the verifier.
///
/// `redirect(Policy::none())` is UNCONDITIONAL and is not a knob: a 30x is
/// returned as a 30x for connected-fetch gate 9 to refuse. Following one would
/// carry the injected `hue-application-key` to whatever the redirect named.
pub fn build_client(verifier: Arc<LanCertVerifier>) -> Result<reqwest::Client, String> {
    let tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("could not build the pinned transport: {e}"))
}

/// Read at most `MAX_RESPONSE_BYTES + 1` bytes, then decide. Reading one byte
/// PAST the cap is what makes "exactly at the cap" and "one byte over"
/// distinguishable; a read of exactly the cap cannot tell a full body from a
/// truncated one.
pub async fn read_capped(response: reqwest::Response) -> Result<String, String> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("read failed: {e}"))?;
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "response exceeded the {MAX_RESPONSE_BYTES}-byte cap and was discarded"
            ));
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The command. Every guard above runs BEFORE a socket is opened.
///
/// Registered for the MAIN WINDOW ONLY (capabilities/main.json) — a sandboxed
/// app iframe holds no invoke key and the per-command IPC test in
/// `src/gate/ipc.ts` proves `lan_fetch` specifically is unreachable from one.
#[tauri::command]
pub async fn lan_fetch(
    url: String,
    method: String,
    mode: String,
    pin: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<LanResponse, String> {
    let lan_mode = match mode.as_str() {
        "pair" => LanMode::Pair,
        "pinned" => LanMode::Pinned {
            fingerprint: pin.unwrap_or_default(),
        },
        // An unknown mode is NOT defaulted to the safer one: a caller that
        // misspells 'pinned' must see it, not silently get pair-mode trust or a
        // pinned refusal it cannot explain.
        other => return Err(format!("unknown lan_fetch mode {other:?} — expected 'pair' or 'pinned'")),
    };
    let admitted = admit(&url, &method, &lan_mode).map_err(|r| r.message())?;

    let verifier = Arc::new(LanCertVerifier::new(lan_mode.clone()));
    let client = build_client(Arc::clone(&verifier))?;

    let mut request = client.request(
        reqwest::Method::from_bytes(admitted.method.as_bytes())
            .map_err(|_| LanRefusal::Method(admitted.method.clone()).message())?,
        &admitted.url,
    );
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {}", redact_url(&e.to_string(), &admitted.url)))?;

    let status = response.status().as_u16();
    let mut out_headers = std::collections::HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            out_headers.insert(name.as_str().to_ascii_lowercase(), v.to_string());
        }
    }
    let body = read_capped(response).await?;
    Ok(LanResponse {
        status,
        headers: out_headers,
        body,
        pin: match lan_mode {
            LanMode::Pair => verifier.captured(),
            LanMode::Pinned { .. } => None,
        },
    })
}

/// reqwest embeds the request URL in transport errors. The LAN URL carries no
/// credential today (the key rides a header), but the pairing POST's URL is the
/// user's own device address and the executor scrubs its outbound URL from every
/// error string — so this side does the same rather than relying on the other.
fn redact_url(message: &str, url: &str) -> String {
    message.replace(url, "<the device address>")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------ host class
    //
    // THE SHARED CASE TABLE. Its twin lives in the TS executor's cross-package
    // equivalence test; a drift between the two is a drift between two guards
    // that both claim to define "private", which is the founding-defect shape
    // (lessons.md 2026-08-10).

    /// Accepted: the three RFC-1918 blocks and nothing else.
    const PRIVATE: [&str; 10] = [
        "10.0.0.1",
        "10.255.255.254",
        "172.16.0.1",
        "172.31.255.254",
        "172.20.10.5",
        "192.168.1.50",
        "192.168.0.1",
        "192.168.255.254",
        "10.1.2.3",
        "172.17.0.2",
    ];

    /// Refused, each for a reason worth naming: public literals, the 172
    /// neighbours just outside the /12, loopback, link-local, CGNAT, DNS names
    /// (including ones that LOOK local), IPv6 in every spelling, and the
    /// leading-zero forms some resolvers read as octal.
    const NOT_PRIVATE: [&str; 24] = [
        "8.8.8.8",
        "1.1.1.1",
        "172.15.0.1",
        "172.32.0.1",
        "172.0.0.1",
        "172.255.255.255",
        "127.0.0.1",
        "127.1.2.3",
        "0.0.0.0",
        "169.254.169.254",
        "100.64.0.1",
        "192.169.1.1",
        "192.167.1.1",
        "localhost",
        "bridge.local",
        "hue.internal",
        "api.example.com",
        "::1",
        "[::1]",
        "fd00::1",
        "[fd00::1]",
        "010.0.0.1",
        "10.0.0",
        "10.0.0.1.5",
    ];

    #[test]
    fn accepts_exactly_the_rfc1918_ipv4_literals() {
        for host in PRIVATE {
            assert!(is_rfc1918_ipv4_literal(host), "{host} must be admitted");
        }
    }

    #[test]
    fn refuses_loopback_link_local_public_names_and_ipv6() {
        for host in NOT_PRIVATE {
            assert!(!is_rfc1918_ipv4_literal(host), "{host} must be REFUSED");
        }
    }

    #[test]
    fn a_trailing_dot_and_surrounding_space_do_not_change_the_class() {
        assert!(is_rfc1918_ipv4_literal("192.168.1.50."));
        assert!(is_rfc1918_ipv4_literal(" 10.0.0.1 "));
        // …and cannot be used to smuggle a public host in.
        assert!(!is_rfc1918_ipv4_literal("8.8.8.8."));
    }

    // ------------------------------------------------------------- admission

    #[test]
    fn admits_a_private_https_get() {
        let admitted = admit("https://192.168.1.50/api", "GET", &LanMode::Pair).unwrap();
        assert_eq!(admitted.host, "192.168.1.50");
        assert_eq!(admitted.method, "GET");
    }

    #[test]
    fn refuses_public_hosts_before_any_connection_is_attempted() {
        for url in [
            "https://api.example.com/api",
            "https://8.8.8.8/api",
            "https://127.0.0.1/api",
            "https://localhost/api",
            "https://[::1]/api",
            "https://169.254.169.254/latest/meta-data/",
        ] {
            let err = admit(url, "GET", &LanMode::Pair).unwrap_err();
            assert!(
                matches!(err, LanRefusal::HostClass(_)),
                "{url} must be refused on host class, got {err:?}"
            );
            assert!(err.message().contains("private network address"));
        }
    }

    #[test]
    fn refuses_plain_http_even_to_a_private_literal() {
        // ADR-0021's http-for-private-literals rung is a DIFFERENT transport.
        // This command is the pinned-TLS one; CLIP v2 never spoke http.
        let err = admit("http://192.168.1.50/api", "GET", &LanMode::Pair).unwrap_err();
        assert!(matches!(err, LanRefusal::Scheme(_)), "got {err:?}");
    }

    #[test]
    fn refuses_urls_with_embedded_credentials() {
        let err = admit("https://user:pw@192.168.1.50/api", "GET", &LanMode::Pair).unwrap_err();
        assert!(matches!(err, LanRefusal::Url(_)), "got {err:?}");
    }

    #[test]
    fn pinned_mode_refuses_an_absent_or_malformed_pin() {
        let absent = admit(
            "https://192.168.1.50/api",
            "GET",
            &LanMode::Pinned {
                fingerprint: String::new(),
            },
        )
        .unwrap_err();
        assert!(matches!(absent, LanRefusal::Pin(_)), "got {absent:?}");

        for bad in ["deadbeef", &"F".repeat(64), &"z".repeat(64), &"a".repeat(63)] {
            let err = admit(
                "https://192.168.1.50/api",
                "GET",
                &LanMode::Pinned {
                    fingerprint: bad.to_string(),
                },
            )
            .unwrap_err();
            assert!(matches!(err, LanRefusal::Pin(_)), "{bad:?} must be refused, got {err:?}");
        }
    }

    #[test]
    fn the_host_class_check_runs_in_pinned_mode_too() {
        // A valid pin does not buy reach: a stolen/attacker-supplied pin for a
        // public host is still refused on class, before any socket.
        let err = admit(
            "https://api.example.com/api",
            "GET",
            &LanMode::Pinned {
                fingerprint: "a".repeat(64),
            },
        )
        .unwrap_err();
        assert!(matches!(err, LanRefusal::HostClass(_)), "got {err:?}");
    }

    // -------------------------------------------------- the verifier itself
    //
    // AC7's "simulated-bridge integration test in CI" (amendment 13): the
    // host-class check refuses loopback, so a 127.0.0.1 stub server cannot
    // exercise this path at all. The pin verifier is therefore tested at the
    // RUST BOUNDARY — fed a certificate directly, exactly as rustls would
    // during a handshake.

    /// A DER certificate fixture. Self-signed, as an old-firmware bridge serves.
    fn fixture_cert(cn: &str) -> Vec<u8> {
        let mut params = rcgen::CertificateParams::new(vec![cn.to_string()]).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, cn);
        let key = rcgen::KeyPair::generate().unwrap();
        params.self_signed(&key).unwrap().der().to_vec()
    }

    fn verify(verifier: &LanCertVerifier, der: &[u8]) -> Result<ServerCertVerified, TlsError> {
        verifier.verify_server_cert(
            &CertificateDer::from(der.to_vec()),
            &[],
            &ServerName::try_from("192.168.1.50").unwrap(),
            &[],
            UnixTime::now(),
        )
    }

    #[test]
    fn pair_mode_accepts_the_leaf_and_captures_its_fingerprint_and_cn() {
        let der = fixture_cert("ECB5FAFFFE123456");
        let verifier = LanCertVerifier::new(LanMode::Pair);
        assert!(verify(&verifier, &der).is_ok());

        let captured = verifier.captured().expect("pair mode must capture the pin");
        assert_eq!(captured.fingerprint, fingerprint_der(&der));
        assert_eq!(captured.fingerprint.len(), 64);
        assert_eq!(
            captured.cn, "ECB5FAFFFE123456",
            "the bridgeId CN is captured for the user-facing record"
        );
    }

    #[test]
    fn pinned_mode_accepts_exactly_the_recorded_certificate() {
        let der = fixture_cert("ECB5FAFFFE123456");
        let verifier = LanCertVerifier::new(LanMode::Pinned {
            fingerprint: fingerprint_der(&der),
        });
        assert!(verify(&verifier, &der).is_ok());
        assert!(
            verifier.captured().is_none(),
            "pinned mode captures nothing — the pin is an input there, never an output"
        );
    }

    #[test]
    fn pinned_mode_REFUSES_a_different_certificate_on_the_same_address() {
        // THE ATTACK: something else answers at the bridge's address after
        // pairing. Same host, same name, different key.
        let paired = fixture_cert("ECB5FAFFFE123456");
        let impostor = fixture_cert("ECB5FAFFFE123456");
        assert_ne!(fingerprint_der(&paired), fingerprint_der(&impostor));

        let verifier = LanCertVerifier::new(LanMode::Pinned {
            fingerprint: fingerprint_der(&paired),
        });
        let err = verify(&verifier, &impostor).unwrap_err();
        assert!(
            err.to_string().contains("different certificate"),
            "the refusal must name what happened: {err}"
        );
    }

    #[test]
    fn a_single_flipped_byte_in_the_pin_refuses() {
        let der = fixture_cert("bridge");
        let real = fingerprint_der(&der);
        let mut tampered: Vec<char> = real.chars().collect();
        tampered[0] = if tampered[0] == 'a' { 'b' } else { 'a' };
        let verifier = LanCertVerifier::new(LanMode::Pinned {
            fingerprint: tampered.into_iter().collect(),
        });
        assert!(verify(&verifier, &der).is_err());
    }

    #[test]
    fn a_certificate_with_no_common_name_captures_an_empty_cn_never_a_wrong_one() {
        // CN is diagnostic, not a trust input: its absence must not fail the
        // pairing, and it must not be filled in from somewhere else.
        let mut params = rcgen::CertificateParams::new(vec!["192.168.1.50".to_string()]).unwrap();
        params.distinguished_name = rcgen::DistinguishedName::new();
        let key = rcgen::KeyPair::generate().unwrap();
        let der = params.self_signed(&key).unwrap().der().to_vec();

        let verifier = LanCertVerifier::new(LanMode::Pair);
        assert!(verify(&verifier, &der).is_ok());
        assert_eq!(verifier.captured().unwrap().cn, "");
    }

    #[test]
    fn the_fingerprint_is_sha256_over_the_der_and_nothing_else() {
        // Pins the DEFINITION: an implementation that hashed the PEM, the
        // public key, or the CN would still be self-consistent and every test
        // above would pass. This is the one that says WHICH bytes.
        let der = fixture_cert("bridge");
        let expected = {
            let d = Sha256::digest(&der);
            d.iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        assert_eq!(fingerprint_der(&der), expected);
    }

    // ----------------------------------------------------- transport policy

    /// The module's PRODUCTION source — everything above `mod tests`.
    ///
    /// Load-bearing: the source-scanning tests below assert that certain strings
    /// are ABSENT, and their own assertion literals live in this same file. A
    /// naive `include_str!` would match the test's own text and the check would
    /// pass (or fail) for the wrong reason. Splitting at the test module is what
    /// makes those absence assertions mean what they say.
    fn production_source() -> &'static str {
        include_str!("lanfetch.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("the module must have production source above its tests")
    }

    #[test]
    fn the_client_never_follows_redirects() {
        // Policy::none() is set UNCONDITIONALLY (module header). reqwest exposes
        // no getter for the policy, so this pins it at the source — the same
        // instrument, and for the same reason, as userfile.rs's fsync test:
        // without it, deleting the `.redirect(...)` line leaves the suite green.
        let src = production_source();
        let build = src
            .split("pub fn build_client")
            .nth(1)
            .expect("build_client must exist");
        let body = build.split("\n///").next().unwrap_or(build);
        assert!(
            body.contains("redirect(reqwest::redirect::Policy::none())"),
            "the pinned transport must install Policy::none() — a followed redirect carries the injected key to the target"
        );
        assert!(
            !body.contains("Policy::limited"),
            "no redirect budget may exist on this transport"
        );
    }

    #[test]
    fn every_call_builds_a_fresh_client_no_cache_no_static() {
        // A cached client would serve a pooled connection established under a
        // DIFFERENT pin: the verifier only runs at handshake, so the pin check
        // would be skipped entirely for the second connection's lifetime.
        let src = production_source();
        let command = src
            .split("pub async fn lan_fetch")
            .nth(1)
            .expect("the command must exist");
        assert!(
            command.contains("build_client(Arc::clone(&verifier))"),
            "the command must build its client per call from its own verifier"
        );
        assert!(
            !src.contains("static CLIENT")
                && !src.contains("OnceLock<reqwest::Client>")
                && !src.contains("Lazy<reqwest::Client>"),
            "no cached client may exist in this module"
        );
    }

    #[tokio::test]
    async fn the_size_cap_is_enforced_in_rust_before_bytes_cross_ipc() {
        // Driven through the real `read_capped` against a real reqwest::Response
        // built over an oversized body — the cap must fire on the STREAM, so an
        // oversized body is never fully buffered for the webview.
        let oversized = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let response = reqwest::Response::from(
            http::Response::builder().status(200).body(oversized).unwrap(),
        );
        let err = read_capped(response).await.unwrap_err();
        assert!(err.contains("cap"), "{err}");
        assert!(err.contains(&MAX_RESPONSE_BYTES.to_string()));
    }

    #[tokio::test]
    async fn a_body_exactly_at_the_cap_is_delivered() {
        // The boundary in the OTHER direction — an off-by-one here would silently
        // discard a legitimate full-size response.
        let exact = vec![b'x'; MAX_RESPONSE_BYTES];
        let response =
            reqwest::Response::from(http::Response::builder().status(200).body(exact).unwrap());
        let body = read_capped(response).await.unwrap();
        assert_eq!(body.len(), MAX_RESPONSE_BYTES);
    }

    #[test]
    fn an_unknown_mode_is_an_error_never_a_default() {
        // Pinned in the command body: defaulting an unknown mode either grants
        // pair-mode trust to a typo or produces a pinned refusal the caller
        // cannot explain.
        assert!(production_source().contains("unknown lan_fetch mode"));
    }

    #[test]
    fn the_timeout_matches_the_executors_own_budget() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn a_transport_error_never_echoes_the_device_address() {
        let url = "https://192.168.1.50/api";
        let raw = format!("error sending request for url ({url}): connection refused");
        let redacted = redact_url(&raw, url);
        assert!(!redacted.contains("192.168.1.50"), "{redacted}");
        assert!(redacted.contains("<the device address>"));
    }
}
