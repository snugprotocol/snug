//! On-demand helper download (ADR-0060). The shell PINS each helper by content — tag,
//! version, per-arch sha256 and sizes — downloads it from that pinned GitHub release on the
//! user's click, verifies the minisign signature with the UPDATER pubkey, checks the pinned
//! sha256 (the signature binds bytes, not identity — §5), unpacks under its own admission
//! rules (§7), swaps the tree in with two renames, stamps it, and starts it.
//!
//! Nothing under `~/Snug/helpers/<name>` is touched until the archive has verified. A
//! developer install (stamp `kind: "dev"`, or no stamp at all) is never overwritten (§4).

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::Digest;
use tauri::Emitter;

/// One arch's pinned artifact. Sizes are what the consent card shows BEFORE any network
/// request (§3) and what the download/inflate caps are derived from (§7).
#[derive(Debug, Clone, Copy)]
pub struct HelperAsset {
    pub sha256: &'static str,
    pub size: u64,
    pub unpacked_size: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct RequiredHelper {
    pub name: &'static str,
    pub version: &'static str,
    pub tag: &'static str,
    pub aarch64: HelperAsset,
    pub x86_64: HelperAsset,
}

/// THE PIN. Printed by `scripts/release-helper.mjs` after a pack; `check-helper-pin` fails
/// the root gate if `version` disagrees with `apps/whatsapp-sidecar/package.json`.
pub const REQUIRED_HELPERS: &[RequiredHelper] = &[RequiredHelper {
    name: "whatsapp-sidecar",
    version: "0.1.0",
    tag: "helper-whatsapp-sidecar-v0.1.0",
    aarch64: HelperAsset { sha256: "331fa05e157aca339ea6103828078349440b9d74a8c06bb906f2c8acf500bdde", size: 42781510, unpacked_size: 142348572 },
    x86_64: HelperAsset { sha256: "4c784449999bf4355186ea3d60f3afe54d99851f23bd95166e4c0d2e077b2b81", size: 43996175, unpacked_size: 144851164 },
}];

/// Where helper releases live. Single-homed like the updater endpoint (ADR-0047 §11) and
/// MUST-APPEAR in the release binary (`run-release-gate.mjs`).
pub const HELPER_RELEASE_BASE: &str = "https://github.com/snugprotocol/snug/releases/download/";

/// The only hosts a download may touch, including across redirects (§7). GitHub serves
/// release assets through a 302 to one of the two CDN hosts.
pub const ALLOWED_HOSTS: &[&str] = &["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
pub const MAX_REDIRECTS: usize = 5;
/// Hard ceilings beneath the pin-derived caps.
pub const HARD_COMPRESSED_CAP: u64 = 300 * 1024 * 1024;
pub const HARD_INFLATED_CAP: u64 = 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 50_000;

pub fn required(name: &str) -> Option<&'static RequiredHelper> {
    REQUIRED_HELPERS.iter().find(|h| h.name == name)
}

pub fn asset_for(helper: &RequiredHelper, arch: &str) -> Option<HelperAsset> {
    match arch {
        "aarch64" => Some(helper.aarch64),
        "x86_64" => Some(helper.x86_64),
        _ => None,
    }
}

pub fn archive_file_name(name: &str, arch: &str) -> String {
    format!("{name}-darwin-{arch}.tar.gz")
}

pub fn download_url(helper: &RequiredHelper, arch: &str) -> String {
    format!("{HELPER_RELEASE_BASE}{}/{}", helper.tag, archive_file_name(helper.name, arch))
}

pub fn helper_dir(snug_dir: &Path, name: &str) -> PathBuf {
    snug_dir.join("helpers").join(name)
}

// ---- the stamp -----------------------------------------------------------------------

/// `helper.json` at the tree root. Written by the downloader (`downloaded`) or by
/// `install-helper.mjs` (`dev`). A tree WITHOUT one is a legacy dev install.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct HelperStamp {
    pub kind: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

pub fn read_stamp(dir: &Path) -> Option<HelperStamp> {
    let raw = std::fs::read_to_string(dir.join("helper.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// What the webview learns. `mismatch` never blocks anything (§3): a mismatched tree still
/// starts; the UI offers the update.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub name: String,
    pub installed: bool,
    /// `absent` | `dev` | `downloaded`
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub required_version: String,
    pub mismatch: bool,
    pub arch: String,
    pub download_bytes: u64,
    pub unpacked_bytes: u64,
}

pub fn current_arch() -> &'static str {
    std::env::consts::ARCH
}

/// Pure verdict over what is on disk. EXACT equality on the version (review finding 12):
/// a downgraded shell must not call a newer helper "outdated".
pub fn status_for(helper: &RequiredHelper, dir: &Path, arch: &str) -> HelperStatus {
    restore_old_if_needed(dir);
    let asset = asset_for(helper, arch).unwrap_or(HelperAsset { sha256: "", size: 0, unpacked_size: 0 });
    let installed = dir.join("index.js").is_file();
    let stamp = read_stamp(dir);
    let kind = if !installed {
        "absent"
    } else {
        match stamp.as_ref().map(|s| s.kind.as_str()) {
            Some("downloaded") => "downloaded",
            _ => "dev",
        }
    };
    let installed_version = if installed { stamp.as_ref().map(|s| s.version.clone()) } else { None };
    let mismatch = installed && installed_version.as_deref() != Some(helper.version);
    HelperStatus {
        name: helper.name.to_string(),
        installed,
        kind: kind.to_string(),
        installed_version,
        required_version: helper.version.to_string(),
        mismatch,
        arch: arch.to_string(),
        download_bytes: asset.size,
        unpacked_bytes: asset.unpacked_size,
    }
}

/// A crash between the two swap renames leaves `<name>` missing and `<name>.old-*` beside
/// it (§7). Put the old tree back so the user keeps a working helper.
pub fn restore_old_if_needed(dir: &Path) {
    if dir.exists() {
        return;
    }
    let Some(parent) = dir.parent() else { return };
    let Some(base) = dir.file_name().and_then(|n| n.to_str()) else { return };
    let prefix = format!("{base}.old-");
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::rename(entry.path(), dir);
            return;
        }
    }
}

/// Remove `.partial-*`/`.old-*` litter beside a helper dir (never the dir itself).
pub fn reap_litter(dir: &Path) {
    let (Some(parent), Some(base)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str())) else { return };
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let n = entry.file_name().to_string_lossy().to_string();
        if n.starts_with(&format!("{base}.partial-")) || n.starts_with(&format!("{base}.old-")) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// ---- redirects ----------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct RedirectPolicy {
    pub allowed_hosts: Vec<String>,
    pub https_only: bool,
}

impl RedirectPolicy {
    pub fn production() -> Self {
        RedirectPolicy { allowed_hosts: ALLOWED_HOSTS.iter().map(|s| s.to_string()).collect(), https_only: true }
    }
}

/// Admit a URL (the first one, or any redirect target) under the policy (§7).
pub fn admit_url(url: &str, policy: &RedirectPolicy) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("helper download URL is malformed: {e}"))?;
    if policy.https_only && parsed.scheme() != "https" {
        return Err(format!("helper download refused: {} is not https", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or("");
    if !policy.allowed_hosts.iter().any(|h| h == host) {
        return Err(format!("helper download refused: host {host} is not a release host"));
    }
    Ok(parsed)
}

/// Resolve a redirect `Location` against the current URL and admit it.
pub fn admit_redirect(current: &url::Url, location: &str, policy: &RedirectPolicy) -> Result<url::Url, String> {
    let next = current.join(location).map_err(|e| format!("helper download redirect is malformed: {e}"))?;
    admit_url(next.as_str(), policy)
}

// ---- tar admission ------------------------------------------------------------------

/// Is this archive entry one the shell will write? Regular files and directories only,
/// relative paths without `..` or a leading `/`, and never a name we would mistake for the
/// stamp (the downloader writes that itself).
pub fn admit_entry(entry_type: tar::EntryType, path: &Path) -> Result<(), String> {
    use tar::EntryType::*;
    match entry_type {
        Regular | Directory => {}
        Symlink | Link => return Err(format!("archive entry {} is a link — refused", path.display())),
        other => return Err(format!("archive entry {} has type {other:?} — refused", path.display())),
    }
    if path.is_absolute() {
        return Err(format!("archive entry {} is absolute — refused", path.display()));
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => return Err(format!("archive entry {} escapes the tree — refused", path.display())),
        }
    }
    if path == Path::new("helper.json") || path == Path::new("./helper.json") {
        return Err("archive carries its own helper.json — refused".into());
    }
    Ok(())
}

/// Unpack `archive` into `dest` (which must not exist yet), enforcing the inflated cap and
/// the per-entry admission. Returns bytes written.
pub fn unpack_admitted(archive: &Path, dest: &Path, inflated_cap: u64) -> Result<u64, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("could not open the helper archive: {e}"))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut ar = tar::Archive::new(gz);
    ar.set_preserve_permissions(false);
    ar.set_unpack_xattrs(false);
    ar.set_overwrite(false);
    std::fs::create_dir_all(dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    let mut written: u64 = 0;
    let mut count: usize = 0;
    let entries = ar.entries().map_err(|e| format!("helper archive is not a tar stream: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("helper archive entry unreadable: {e}"))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(format!("helper archive has more than {MAX_ENTRIES} entries — refused"));
        }
        let path = entry.path().map_err(|e| format!("helper archive entry path unreadable: {e}"))?.into_owned();
        admit_entry(entry.header().entry_type(), &path)?;
        let size = entry.header().size().map_err(|e| format!("bad entry size: {e}"))?;
        written = written.saturating_add(size);
        if written > inflated_cap {
            return Err(format!("helper archive inflates past the {inflated_cap}-byte cap — refused"));
        }
        // `unpack_in` refuses `..` and absolute targets a second time, and never follows
        // symlinks created earlier (there are none — admitted above).
        let ok = entry.unpack_in(dest).map_err(|e| format!("could not unpack {}: {e}", path.display()))?;
        if !ok {
            return Err(format!("archive entry {} was refused by the unpacker", path.display()));
        }
    }
    Ok(written)
}

/// The shape a helper tree must have to be spawned (§7 post-validation).
pub fn validate_tree(dir: &Path) -> Result<(), String> {
    if !dir.join("index.js").is_file() {
        return Err("unpacked helper has no index.js".into());
    }
    let node = dir.join("bin").join("node");
    if !node.is_file() {
        return Err("unpacked helper has no bin/node".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&node).map_err(|e| format!("bin/node unreadable: {e}"))?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&node, perms).map_err(|e| format!("could not mark bin/node executable: {e}"))?;
    }
    Ok(())
}

// ---- verification -------------------------------------------------------------------

/// The updater pubkey, read from tauri.conf.json at compile time — ONE trust root (§5).
pub fn updater_pubkey_b64() -> Result<String, String> {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).map_err(|e| format!("tauri.conf.json unreadable: {e}"))?;
    conf.pointer("/plugins/updater/pubkey")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "tauri.conf.json has no plugins.updater.pubkey".to_string())
}

/// minisign-verify the archive bytes against `pubkey_b64` (base64 of the whole .pub file,
/// exactly the shape tauri.conf.json stores) using the `.sig` file's text.
pub fn verify_signature(bytes: &[u8], sig_text: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let pub_txt = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("updater pubkey is not base64: {e}"))?;
    let pub_txt = String::from_utf8(pub_txt).map_err(|_| "updater pubkey is not text".to_string())?;
    let key = minisign_verify::PublicKey::decode(&pub_txt).map_err(|e| format!("updater pubkey unreadable: {e}"))?;
    // `tauri signer sign` writes the .sig as base64 of the minisign text (the updater's own
    // convention); accept both that and raw minisign text.
    let sig_txt = match base64::engine::general_purpose::STANDARD.decode(sig_text.trim()) {
        Ok(raw) => String::from_utf8(raw).unwrap_or_else(|_| sig_text.to_string()),
        Err(_) => sig_text.to_string(),
    };
    let sig = minisign_verify::Signature::decode(&sig_txt).map_err(|e| format!("helper signature unreadable: {e}"))?;
    key.verify(bytes, &sig, false).map_err(|e| format!("helper signature does not verify: {e}"))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = sha2::Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Both checks, in the order that matters: signature first (cheap to refuse junk), then the
/// CONTENT pin — a valid signature over the wrong artifact is exactly the substitution §5 names.
pub fn verify_archive(bytes: &[u8], sig_text: &str, pubkey_b64: &str, pinned_sha256: &str) -> Result<(), String> {
    verify_signature(bytes, sig_text, pubkey_b64)?;
    let actual = sha256_hex(bytes);
    if actual != pinned_sha256 {
        return Err(format!("helper archive is not the pinned build (sha256 {actual}, pinned {pinned_sha256}) — refused"));
    }
    Ok(())
}

// ---- the swap -----------------------------------------------------------------------

/// Two renames (§7): `<dir>` → `<dir>.old-<nonce>`, `<partial>` → `<dir>`, then remove the old.
pub fn swap_in(partial: &Path, dir: &Path, nonce: &str) -> Result<(), String> {
    let old = dir.with_file_name(format!("{}.old-{nonce}", dir.file_name().and_then(|n| n.to_str()).unwrap_or("helper")));
    if dir.exists() {
        std::fs::rename(dir, &old).map_err(|e| format!("could not set the previous helper aside: {e}"))?;
    }
    if let Err(e) = std::fs::rename(partial, dir) {
        // Put the old one back rather than leave nothing.
        if old.exists() {
            let _ = std::fs::rename(&old, dir);
        }
        return Err(format!("could not move the new helper into place: {e}"));
    }
    if old.exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

// ---- download -----------------------------------------------------------------------

fn build_download_client() -> Result<reqwest::Client, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("could not build the download transport: {e}"))
}

/// GET with MANUAL redirects under `policy`, streaming the body to `sink` with a byte cap.
/// `progress` sees (received, total-if-known).
pub async fn fetch_capped(
    client: &reqwest::Client,
    url: &str,
    policy: &RedirectPolicy,
    cap: u64,
    sink: &mut (dyn Write + Send),
    mut progress: impl FnMut(u64, Option<u64>) + Send,
) -> Result<u64, String> {
    use futures_util::StreamExt;
    let mut current = admit_url(url, policy)?;
    for _hop in 0..=MAX_REDIRECTS {
        let res = client.get(current.clone()).send().await.map_err(|e| format!("helper download failed: {e}"))?;
        let status = res.status();
        if status.is_redirection() {
            let loc = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "helper download redirect carried no Location".to_string())?;
            current = admit_redirect(&current, loc, policy)?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("helper download failed: HTTP {status} from {}", current.host_str().unwrap_or("?")));
        }
        let total = res.content_length();
        if let Some(t) = total {
            if t > cap {
                return Err(format!("helper download is {t} bytes, over the {cap}-byte cap — refused"));
            }
        }
        let mut received: u64 = 0;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("helper download interrupted: {e}"))?;
            received += chunk.len() as u64;
            if received > cap {
                return Err(format!("helper download exceeded the {cap}-byte cap — refused"));
            }
            sink.write_all(&chunk).map_err(|e| format!("could not write the helper download: {e}"))?;
            progress(received, total);
        }
        return Ok(received);
    }
    Err(format!("helper download followed more than {MAX_REDIRECTS} redirects — refused"))
}

// ---- the command --------------------------------------------------------------------

/// One install per helper name in flight (review finding 14).
#[derive(Default)]
pub struct HelperInstallState {
    in_flight: std::sync::Mutex<std::collections::HashSet<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperInstallProgress {
    pub name: String,
    /// `downloading` | `verifying` | `installing` | `starting` | `done`
    pub phase: String,
    pub received: u64,
    pub total: u64,
}

pub const PROGRESS_EVENT: &str = "snug:helper-install";

#[tauri::command]
pub async fn helper_status(name: String) -> Result<HelperStatus, String> {
    let helper = required(&name).ok_or_else(|| format!("'{name}' is not a helper this build knows"))?;
    let dir = helper_dir(&crate::userfile::snug_dir()?, helper.name);
    Ok(status_for(helper, &dir, current_arch()))
}

/// Download → verify → unpack → swap → stamp → start. Explicit-click only (§6): nothing in
/// the shell calls this unasked.
#[tauri::command]
pub async fn helper_install(
    name: String,
    app: tauri::AppHandle,
    install_state: tauri::State<'_, HelperInstallState>,
    sidecar_state: tauri::State<'_, crate::sidecar::SidecarState>,
) -> Result<HelperStatus, String> {
    let helper = required(&name).ok_or_else(|| format!("'{name}' is not a helper this build knows"))?;
    let arch = current_arch();
    let asset = asset_for(helper, arch).ok_or_else(|| format!("no {} build of the helper for {arch}", helper.name))?;
    if asset.size == 0 || asset.sha256.chars().all(|c| c == '0') {
        return Err(format!("this build carries no published pin for the {} helper — it cannot be downloaded yet", helper.name));
    }
    {
        let mut guard = install_state.in_flight.lock().map_err(|_| "helper install state is poisoned".to_string())?;
        if !guard.insert(helper.name.to_string()) {
            return Err(format!("the {} helper is already being installed", helper.name));
        }
    }
    let result = install_inner(helper, asset, arch, &app, &sidecar_state).await;
    if let Ok(mut guard) = install_state.in_flight.lock() {
        guard.remove(helper.name);
    }
    result
}

async fn install_inner(
    helper: &RequiredHelper,
    asset: HelperAsset,
    arch: &str,
    app: &tauri::AppHandle,
    sidecar_state: &crate::sidecar::SidecarState,
) -> Result<HelperStatus, String> {
    let snug_dir = crate::userfile::snug_dir()?;
    let dir = helper_dir(&snug_dir, helper.name);
    let status_now = status_for(helper, &dir, arch);
    if status_now.installed && status_now.kind == "dev" {
        return Err(format!("a developer install of the {} helper is present at {} — not overwriting it", helper.name, dir.display()));
    }
    std::fs::create_dir_all(dir.parent().unwrap_or(&snug_dir)).map_err(|e| format!("could not create ~/Snug/helpers: {e}"))?;
    reap_litter(&dir);

    let emit = |phase: &str, received: u64, total: u64| {
        let _ = app.emit(
            PROGRESS_EVENT,
            HelperInstallProgress { name: helper.name.to_string(), phase: phase.to_string(), received, total },
        );
    };

    // 1. download to a temp file beside the target (same filesystem for the rename later).
    let nonce = crate::sidecar::mint_nonce_pub();
    let tmp_archive = dir.with_file_name(format!("{}.download-{nonce}.tar.gz", helper.name));
    let client = build_download_client()?;
    let compressed_cap = (asset.size.saturating_mul(2)).min(HARD_COMPRESSED_CAP);
    {
        let mut file = std::fs::File::create(&tmp_archive).map_err(|e| format!("could not create the download file: {e}"))?;
        let url = download_url(helper, arch);
        emit("downloading", 0, asset.size);
        let outcome = fetch_capped(&client, &url, &RedirectPolicy::production(), compressed_cap, &mut file, |r, _| {
            emit("downloading", r, asset.size)
        })
        .await;
        if let Err(e) = outcome {
            let _ = std::fs::remove_file(&tmp_archive);
            return Err(e);
        }
    }

    // 2. verify: signature (updater key) then the content pin.
    emit("verifying", asset.size, asset.size);
    let verified = async {
        let bytes = std::fs::read(&tmp_archive).map_err(|e| format!("could not read the download: {e}"))?;
        let sig_url = format!("{}.sig", download_url(helper, arch));
        let mut sig = Vec::new();
        fetch_capped(&client, &sig_url, &RedirectPolicy::production(), 16 * 1024, &mut sig, |_, _| {}).await?;
        let sig_text = String::from_utf8(sig).map_err(|_| "helper signature is not text".to_string())?;
        verify_archive(&bytes, &sig_text, &updater_pubkey_b64()?, asset.sha256)
    }
    .await;
    if let Err(e) = verified {
        let _ = std::fs::remove_file(&tmp_archive);
        return Err(e);
    }

    // 3. unpack into a partial dir under admission + inflated cap; validate the shape.
    emit("installing", asset.size, asset.size);
    let partial = dir.with_file_name(format!("{}.partial-{nonce}", helper.name));
    let inflated_cap = (asset.unpacked_size.saturating_mul(4)).min(HARD_INFLATED_CAP).max(asset.unpacked_size);
    let unpacked = unpack_admitted(&tmp_archive, &partial, inflated_cap).and_then(|_| validate_tree(&partial));
    let _ = std::fs::remove_file(&tmp_archive);
    if let Err(e) = unpacked {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(e);
    }
    let stamp = HelperStamp {
        kind: "downloaded".into(),
        name: helper.name.into(),
        version: helper.version.into(),
        tag: Some(helper.tag.into()),
        arch: Some(arch.into()),
    };
    std::fs::write(partial.join("helper.json"), serde_json::to_string_pretty(&stamp).unwrap_or_default())
        .map_err(|e| format!("could not write the helper stamp: {e}"))?;

    // 4. stop the running helper (it may be the tree being replaced), swap, start.
    let guard_result = {
        let mut guard = sidecar_state.inner.lock().map_err(|_| "sidecar state is poisoned".to_string())?;
        crate::sidecar::stop_locked(&mut guard);
        swap_in(&partial, &dir, &nonce)?;
        emit("starting", asset.size, asset.size);
        crate::sidecar::start_helper(&mut guard)
    };
    match guard_result {
        Ok(_) => {
            emit("done", asset.size, asset.size);
            Ok(status_for(helper, &dir, arch))
        }
        Err(e) => Err(format!("the helper installed but did not start: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &[u8] = include_bytes!("../fixtures/helper/good.tar.gz");
    const GOOD_SIG: &str = include_str!("../fixtures/helper/good.tar.gz.sig");
    const PUB_B64: &str = include_str!("../fixtures/helper/throwaway.pub.b64");

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    // ---- AC6(a)(b): verification ------------------------------------------------------

    #[test]
    fn a_fixture_signed_by_the_fixture_key_verifies_and_pins() {
        let sha = sha256_hex(GOOD);
        verify_archive(GOOD, GOOD_SIG, PUB_B64, &sha).expect("good fixture verifies");
    }

    #[test]
    fn a_tampered_archive_fails_the_signature() {
        let mut bytes = GOOD.to_vec();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let err = verify_signature(&bytes, GOOD_SIG, PUB_B64).unwrap_err();
        assert!(err.contains("does not verify"), "{err}");
    }

    #[test]
    fn a_valid_signature_over_the_wrong_artifact_is_refused_by_the_content_pin() {
        // ADR-0060 §5: the signature binds bytes, not identity. Same key, same bytes, but the
        // shell pinned a DIFFERENT sha — this is the "substitute any signed artifact" attack.
        let err = verify_archive(GOOD, GOOD_SIG, PUB_B64, &"a".repeat(64)).unwrap_err();
        assert!(err.contains("not the pinned build"), "{err}");
    }

    #[test]
    fn the_production_pubkey_is_the_updater_pubkey_and_refuses_the_fixture_key() {
        let prod = updater_pubkey_b64().expect("tauri.conf.json carries the updater pubkey");
        assert_ne!(prod.trim(), PUB_B64.trim());
        let err = verify_signature(GOOD, GOOD_SIG, &prod).unwrap_err();
        assert!(err.contains("does not verify"), "{err}");
    }

    #[test]
    fn a_missing_or_junk_signature_is_refused() {
        assert!(verify_signature(GOOD, "", PUB_B64).is_err());
        assert!(verify_signature(GOOD, "not a signature", PUB_B64).is_err());
    }

    // ---- AC6(c)(d): admission + inflated cap -------------------------------------------

    #[test]
    fn symlink_and_dotdot_archives_are_refused_and_leave_no_partial() {
        for (fixture, needle) in [
            (&include_bytes!("../fixtures/helper/symlink.tar.gz")[..], "is a link"),
            (&include_bytes!("../fixtures/helper/dotdot.tar.gz")[..], "escapes the tree"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let archive = tmp.path().join("a.tar.gz");
            write(&archive, fixture);
            let partial = tmp.path().join("h.partial-x");
            let err = unpack_admitted(&archive, &partial, HARD_INFLATED_CAP).unwrap_err();
            assert!(err.contains(needle), "{err}");
            let _ = std::fs::remove_dir_all(&partial);
            assert!(!partial.join("link").exists());
        }
    }

    #[test]
    fn admit_entry_refuses_every_non_file_type_and_every_escape() {
        use tar::EntryType;
        assert!(admit_entry(EntryType::Regular, Path::new("./index.js")).is_ok());
        assert!(admit_entry(EntryType::Directory, Path::new("node_modules")).is_ok());
        assert!(admit_entry(EntryType::Symlink, Path::new("x")).is_err());
        assert!(admit_entry(EntryType::Link, Path::new("x")).is_err());
        assert!(admit_entry(EntryType::Char, Path::new("x")).is_err());
        assert!(admit_entry(EntryType::Fifo, Path::new("x")).is_err());
        assert!(admit_entry(EntryType::Regular, Path::new("/etc/passwd")).is_err());
        assert!(admit_entry(EntryType::Regular, Path::new("a/../../b")).is_err());
        assert!(admit_entry(EntryType::Regular, Path::new("helper.json")).is_err(), "the stamp is ours to write");
    }

    #[test]
    fn the_inflated_cap_refuses_a_bomb_before_it_lands() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        write(&archive, GOOD);
        let partial = tmp.path().join("h.partial-y");
        let err = unpack_admitted(&archive, &partial, 4).unwrap_err();
        assert!(err.contains("inflates past"), "{err}");
    }

    #[test]
    fn the_good_fixture_unpacks_validates_and_marks_node_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        write(&archive, GOOD);
        let partial = tmp.path().join("h.partial-z");
        unpack_admitted(&archive, &partial, HARD_INFLATED_CAP).unwrap();
        validate_tree(&partial).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(partial.join("bin/node")).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "bin/node must be executable");
        }
    }

    // ---- AC6(e): redirects -------------------------------------------------------------

    #[test]
    fn redirects_must_stay_https_and_on_release_hosts() {
        let policy = RedirectPolicy::production();
        let start = admit_url("https://github.com/snugprotocol/snug/releases/download/t/f.tar.gz", &policy).unwrap();
        assert!(admit_redirect(&start, "https://objects.githubusercontent.com/x", &policy).is_ok());
        assert!(admit_redirect(&start, "https://release-assets.githubusercontent.com/x", &policy).is_ok());
        assert!(admit_redirect(&start, "http://objects.githubusercontent.com/x", &policy).unwrap_err().contains("not https"));
        assert!(admit_redirect(&start, "https://evil.example/x", &policy).unwrap_err().contains("not a release host"));
        assert!(admit_url("https://github.com.evil.example/x", &policy).is_err());
        // relative Location resolves against the current URL and stays admitted
        assert!(admit_redirect(&start, "/other/path", &policy).is_ok());
    }

    #[test]
    fn download_urls_are_single_homed_under_the_pinned_tag() {
        let h = &REQUIRED_HELPERS[0];
        let url = download_url(h, "aarch64");
        assert!(url.starts_with(HELPER_RELEASE_BASE));
        assert!(url.contains(&format!("/{}/", h.tag)));
        assert!(url.ends_with("whatsapp-sidecar-darwin-aarch64.tar.gz"));
        assert!(!url.contains("latest"), "never from releases/latest — that is the desktop's endpoint");
    }

    // ---- AC5: status + stamps -----------------------------------------------------------

    #[test]
    fn status_absent_dev_downloaded_and_mismatch_by_exact_equality() {
        let tmp = tempfile::tempdir().unwrap();
        let h = &REQUIRED_HELPERS[0];
        let dir = tmp.path().join("helpers").join(h.name);
        let absent = status_for(h, &dir, "aarch64");
        assert!(!absent.installed && absent.kind == "absent" && !absent.mismatch);

        // stamp-less tree = legacy dev install: never "outdated"-blocked, but reported
        write(&dir.join("index.js"), b"");
        let dev = status_for(h, &dir, "aarch64");
        assert!(dev.installed && dev.kind == "dev");
        assert!(dev.mismatch, "no stamp means no version — reported, never blocking");

        write(&dir.join("helper.json"), format!(r#"{{"kind":"dev","name":"{}","version":"{}"}}"#, h.name, h.version).as_bytes());
        assert_eq!(status_for(h, &dir, "aarch64").mismatch, false);

        write(&dir.join("helper.json"), format!(r#"{{"kind":"downloaded","name":"{}","version":"{}"}}"#, h.name, h.version).as_bytes());
        let dl = status_for(h, &dir, "aarch64");
        assert!(dl.kind == "downloaded" && !dl.mismatch);

        // a NEWER helper than the pin is still a mismatch (exact equality, not ordering)
        write(&dir.join("helper.json"), format!(r#"{{"kind":"downloaded","name":"{}","version":"99.0.0"}}"#, h.name).as_bytes());
        assert!(status_for(h, &dir, "aarch64").mismatch);
    }

    // ---- AC6(f)(g): the swap ------------------------------------------------------------

    #[test]
    fn swap_replaces_the_old_tree_and_a_crash_between_renames_is_restored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("helpers").join("h");
        write(&dir.join("index.js"), b"old");
        let partial = tmp.path().join("helpers").join("h.partial-n1");
        write(&partial.join("index.js"), b"new");
        swap_in(&partial, &dir, "n1").unwrap();
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"new");
        assert!(!partial.exists());
        assert!(std::fs::read_dir(tmp.path().join("helpers")).unwrap().count() == 1, "no .old litter");

        // simulate a crash after rename 1: <dir> missing, <dir>.old-* present
        std::fs::rename(&dir, tmp.path().join("helpers").join("h.old-n2")).unwrap();
        assert!(!dir.exists());
        restore_old_if_needed(&dir);
        assert_eq!(std::fs::read(dir.join("index.js")).unwrap(), b"new");
    }

    #[test]
    fn reap_litter_removes_partials_and_olds_but_never_the_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("helpers").join("h");
        write(&dir.join("index.js"), b"keep");
        write(&tmp.path().join("helpers").join("h.partial-a").join("x"), b"");
        write(&tmp.path().join("helpers").join("h.old-b").join("x"), b"");
        reap_litter(&dir);
        assert!(dir.join("index.js").exists());
        assert_eq!(std::fs::read_dir(tmp.path().join("helpers")).unwrap().count(), 1);
    }

    // ---- registration + gate pins -------------------------------------------------------

    #[test]
    fn helper_commands_and_state_are_registered() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("helper_install::helper_install"), "helper_install must be in BOTH handler lists");
        assert!(lib.contains("helper_install::helper_status"));
        assert!(lib.contains(".manage(helper_install::HelperInstallState::default())"), "unmanaged State fails the invoke before the body runs (sidecar.rs state_registration_tests)");
    }

    /// Run by hand after staging (`cargo test -- --ignored staged_archive`): the REAL archive
    /// in apps/whatsapp-sidecar/release-out must verify against the PRODUCTION updater key
    /// and the pin above — the exact check a user's shell performs.
    #[test]
    #[ignore]
    fn staged_archive_verifies_against_the_production_key_and_pin() {
        let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../whatsapp-sidecar/release-out");
        let h = &REQUIRED_HELPERS[0];
        for (arch, asset) in [("aarch64", h.aarch64), ("x86_64", h.x86_64)] {
            let file = out.join(archive_file_name(h.name, arch));
            let bytes = std::fs::read(&file).expect("staged archive present");
            let sig = std::fs::read_to_string(format!("{}.sig", file.display())).expect("staged .sig present");
            verify_archive(&bytes, &sig, &updater_pubkey_b64().unwrap(), asset.sha256).expect(arch);
            assert_eq!(bytes.len() as u64, asset.size, "{arch} size pin");
        }
    }

    #[test]
    fn the_pin_version_matches_the_helper_package_version() {
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../../whatsapp-sidecar/package.json")).unwrap();
        assert_eq!(pkg["version"].as_str().unwrap(), REQUIRED_HELPERS[0].version, "bump the pin with the helper (check-helper-pin)");
    }
}
