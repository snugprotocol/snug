// Shell IPC-unreachability checks (TASK-20260812 P0 amendment 1, AC7).
//
// The 14 CSP checks govern only CSP-governed channels; the shell's ONE new
// escape hatch is the Tauri IPC bridge, which CSP does not touch. These checks
// run INSIDE a `sandbox="allow-scripts"` srcdoc iframe — the exact posture of
// an app iframe — and prove the shell's COMMANDS are unreachable from there:
//
//   ipc-tauri-internals-absent    window.__TAURI_INTERNALS__ (the invoke API AND
//                                   the invoke KEY live here; absent = the
//                                   subframe never received the bootstrap
//                                   scripts that carry the key)
//   ipc-tauri-global-absent       window.__TAURI__ (withGlobalTauri, off here)
//   ipc-chrome-webview-absent     window.chrome.webview (WebView2 transport)
//   ipc-invoke-refused            THE ENFORCEMENT SIGNAL (see below)
//
// AC7 is satisfied when the handles are unreachable OR an invoke is refused.
// The distinction matters on WKWebView: wry registers
// `webkit.messageHandlers.ipc` at the WEBVIEW-PROCESS level, so a sandboxed
// subframe CAN see that raw transport object. Seeing the pipe is not reaching
// the commands. Tauri 2 gates every invoke on a runtime-generated
// `Tauri-Invoke-Key` (verified against tauri 2.11.5 ipc-protocol.js +
// webview/mod.rs `on_message`: a request whose `invoke_key` != the manager's
// expected key returns WITHOUT dispatching). That key lives only in the IPC
// scripts injected into the INITIALIZED main frame — which
// `ipc-tauri-internals-absent` proves never reached the subframe.
//
// So `ipc-invoke-refused` is enforcement, not API presence: the probe posts a
// REAL keyless invoke through every reachable raw transport
// (webkit.messageHandlers.ipc, chrome.webview) — the subframe has no key — and
// passes only on ABSENCE OF EFFECT, the CSP suite's discipline per lessons.md
// 2026-07-31.
//
// WHERE THE SENSOR LIVES (whole-surface review finding 2). It used to be a
// callback installed on the SUBFRAME's window, watched from the subframe. That
// sensor could not fire whether or not the command executed: Tauri's response
// path resolves into the frame that HOLDS the invoke bookkeeping — the
// initialized main frame — and never into an opaque sandboxed subframe. The
// check therefore passed unconditionally and could not fail for the reason its
// id claims.
//
// The sensor is now an EFFECT observed where effects are observable. The
// subframe posts a keyless `write_user_file` naming a sentinel file
// (`ipc-probe-canary.sqlite`); if that invoke executed, the file exists in
// `~/Snug`. The MAIN frame — which Tauri does answer — then asks Rust via the
// debug-only `gate_ipc_sentinel_exists` command. Sentinel present = the command
// ran from a sandboxed subframe = FAIL and the Electron-fallback trigger.
// Sentinel absent = refused = PASS. The subframe-side callback is kept as a
// second, weaker signal (it can only ever add a failure, never a pass).
//
// The probe page is hand-built and deliberately CSP-FREE: these checks are
// about what the SHELL injects into subframes, which a CSP could only mask.

import { invoke } from '@tauri-apps/api/core';

import type { CheckResult } from './types.js';

export const IPC_CHECK_IDS = [
  'ipc-tauri-internals-absent',
  'ipc-tauri-global-absent',
  'ipc-chrome-webview-absent',
  'ipc-invoke-refused',
  'ipc-lan-fetch-refused',
  'ipc-sidecar-fetch-refused',
  'ipc-sidecar-fetch-dispatchable',
  'ipc-updater-check-refused',
  'ipc-updater-install-refused',
  'ipc-process-relaunch-refused',
  'ipc-updater-check-dispatchable',
] as const;

/**
 * PER-COMMAND, not command-family (P0 amendment 16, the "mutate the call site"
 * discipline). `ipc-invoke-refused` proves the BRIDGE is key-gated by driving
 * `write_user_file`; a reader could reasonably conclude that settles every
 * command, and they would be wrong for the reason that discipline exists —
 * registration is per-command and a command added to the wrong handler list is
 * exactly the drift a family-level check cannot see.
 *
 * `lan_fetch` is the command that most needs its own row: it is the shell's
 * only outbound-network capability with a relaxed trust decision inside it, so
 * an app iframe that could reach it would get a transport that trusts a
 * certificate on the user's own network.
 *
 * THE SENSOR PROBLEM, and the honest answer. `write_user_file`'s effect is a
 * file the main frame can ask Rust about. `lan_fetch`'s effect is a REQUEST to
 * a private IP — and the Rust host-class check refuses everything a CI runner
 * can bind (loopback is not RFC-1918), so there is no address at which a
 * "did it fire?" listener could sit. Rather than fake an effect, this check
 * uses the property that IS observable and IS the one that matters: the
 * sandboxed subframe posts a real keyless `lan_fetch` through every reachable
 * raw transport, and the verdict requires that no callback resolved into the
 * subframe for it. A keyed invoke resolves its callback; a key-refused one is
 * dropped before dispatch (tauri 2.11.5 webview/mod.rs `on_message`). So a
 * fired callback is proof of REACH, and its absence — combined with
 * `ipc-tauri-internals-absent` proving the key never arrived — is the refusal.
 *
 * This is a WEAKER instrument than the sentinel and says so: it can prove
 * breakage, and it vouches for refusal only alongside the key-absence checks.
 * That is stated rather than hidden, per lessons.md 2026-07-31 — an
 * unanswerable sensor that reports "pass" is the defect.
 */
export const LAN_FETCH_COMMAND = 'lan_fetch';

/**
 * `sidecar_fetch` (ADR-0032) gets its OWN row for the same amendment-16 reason
 * `lan_fetch` does, and the reason is sharper here: an app iframe that reached
 * this command would be talking to the process holding the user's WhatsApp
 * LINKED-DEVICE SESSION — able to read every thread and send as the user.
 * Registration is per-command, so a family-level check cannot see a command
 * added to the wrong handler list.
 *
 * It shares `lan_fetch`'s SENSOR PROBLEM and the same honest answer. The effect
 * of a dispatched `sidecar_fetch` is a request to a unix socket that does not
 * exist on a CI runner, so no "did it fire?" listener can sit at the far end.
 * The observable property is REACH: a keyless call is dropped before dispatch,
 * while a dispatched one resolves a callback (success or error alike). So a
 * fired callback proves reach — breakage — and its absence vouches for refusal
 * only alongside the key-absence checks. Stated, not hidden: this is the weaker
 * instrument, exactly as the row above.
 */
export const SIDECAR_FETCH_COMMAND = 'sidecar_fetch';

/**
 * The update-channel commands (ADR-0047 §3, TASK-20260821) get their own rows for
 * the same amendment-16 reason as the two above, with the highest stakes yet: an
 * app iframe that reached `plugin:updater|download_and_install` would get
 * ARBITRARY BINARY INSTALLATION AS THE USER — it could hand the updater a
 * malicious manifest's artifact and replace the shell itself. `plugin:process|restart`
 * is its accomplice (install rides a relaunch). Capability placement cannot answer
 * this — capabilities are per-WINDOW, and the main-window capability necessarily
 * covers the webview holding the sandboxed iframes — so the refusal is proven the
 * only way it can be: a real keyless invoke from inside a sandboxed srcdoc frame.
 *
 * They share the SENSOR PROBLEM of the rows above and the same honest answer:
 * reach is the observable (a dispatched command resolves a callback, success or
 * error alike), and the pass means something only alongside the key-absence checks.
 *
 * One deliberate hazard, stated: if `plugin:process|restart` were ever DISPATCHED
 * from the probe frame, the shell would restart mid-gate and the harness would
 * report "exited before writing results". That reading IS the correct verdict —
 * a shell that lets a sandboxed iframe relaunch it has no business passing — and
 * the lessons.md 2026-08-19 entry tells the reader how to distinguish it from a
 * stale-lock environment failure.
 */
export const UPDATER_CHECK_COMMAND = 'plugin:updater|check';
export const UPDATER_INSTALL_COMMAND = 'plugin:updater|download_and_install';
export const PROCESS_RELAUNCH_COMMAND = 'plugin:process|restart';

/**
 * The sentinel filename the subframe's keyless write targets. Must match
 * `gate.rs::IPC_SENTINEL_NAME` — the Rust side answers for this name ONLY, so a
 * drift here turns the probe into an error rather than a silent pass.
 */
export const SENTINEL_NAME = 'ipc-probe-canary.sqlite';

const REPORT_TYPE = 'snug-gate-ipc-report';
const TIMEOUT_MS = 10_000;

const sc = '<' + 'script>';
const scEnd = '</' + 'script>';

const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ipc probe</title></head><body>${sc}
(function () {
  var out = [];
  function add(id, pass, detail) { out.push({ id: id, pass: !!pass, detail: String(detail || '') }); }

  // 1-3: the KEYED invoke APIs must be absent (the invoke key rides with them).
  try {
    if (typeof window.__TAURI_INTERNALS__ === 'undefined') add('ipc-tauri-internals-absent', true, '');
    else add('ipc-tauri-internals-absent', false, 'window.__TAURI_INTERNALS__ present — invoke key may be reachable');
  } catch (e) { add('ipc-tauri-internals-absent', true, 'access threw: ' + e); }

  try {
    if (typeof window.__TAURI__ === 'undefined') add('ipc-tauri-global-absent', true, '');
    else add('ipc-tauri-global-absent', false, 'window.__TAURI__ present');
  } catch (e) { add('ipc-tauri-global-absent', true, 'access threw: ' + e); }

  try {
    var cw = window.chrome && window.chrome.webview;
    if (!cw) add('ipc-chrome-webview-absent', true, '');
    else add('ipc-chrome-webview-absent', false, 'window.chrome.webview present');
  } catch (e) { add('ipc-chrome-webview-absent', true, 'access threw: ' + e); }

  // 4: ENFORCEMENT. Collect the raw transports the subframe can see, note them
  // for the detail, then post a REAL keyless invoke through each and require
  // that NONE of them cause read_user_file to execute (no callback fires).
  var transports = [];
  var reachableNames = [];
  try {
    var mh = window.webkit && window.webkit.messageHandlers;
    if (mh) {
      var names = ['ipc', 'tauri', 'invoke', '__TAURI_POST_MESSAGE__'];
      try {
        var own = Object.getOwnPropertyNames(mh);
        for (var i = 0; i < own.length; i++) if (names.indexOf(own[i]) === -1) names.push(own[i]);
      } catch (e1) { /* enumeration refused is fine */ }
      for (var j = 0; j < names.length; j++) {
        try {
          var h = mh[names[j]];
          if (h && typeof h.postMessage === 'function') {
            transports.push({ kind: 'webkit', handler: h });
            reachableNames.push('webkit.messageHandlers.' + names[j]);
          }
        } catch (e2) { /* per-name access refusal is fine */ }
      }
    }
  } catch (e) { /* no webkit bridge */ }
  try {
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
      transports.push({ kind: 'chrome', handler: window.chrome.webview });
      reachableNames.push('chrome.webview');
    }
  } catch (e) { /* no webview2 bridge */ }

  // The WEAK, subframe-local signal: a callback a keyed invoke would resolve
  // through. It cannot be trusted to fire (see the header) — it can only ever
  // ADD a failure, never grant a pass. The authoritative sensor is the sentinel
  // file, checked from the main frame after this report arrives.
  var callbackFired = false;
  var CB = 987654321;
  window['_' + CB] = function () { callbackFired = true; };

  // PER-COMMAND (amendment 16): lan_fetch gets its own callback slot, so a
  // reach proven for one command is never credited to the other.
  var lanCallbackFired = false;
  var LAN_CB = 987654331;
  window['_' + LAN_CB] = function () { lanCallbackFired = true; };
  window['_' + (LAN_CB + 1)] = function () { lanCallbackFired = true; };

  // Its own slot again: reach proven for one command is never credited to another.
  var sidecarCallbackFired = false;
  var SIDECAR_CB = 987654341;
  window['_' + SIDECAR_CB] = function () { sidecarCallbackFired = true; };
  window['_' + (SIDECAR_CB + 1)] = function () { sidecarCallbackFired = true; };

  // Update-channel commands (ADR-0047 §3): one slot pair per command, never shared.
  var updaterCheckCallbackFired = false;
  var UPD_CB = 987654351;
  window['_' + UPD_CB] = function () { updaterCheckCallbackFired = true; };
  window['_' + (UPD_CB + 1)] = function () { updaterCheckCallbackFired = true; };
  var updaterInstallCallbackFired = false;
  var INS_CB = 987654361;
  window['_' + INS_CB] = function () { updaterInstallCallbackFired = true; };
  window['_' + (INS_CB + 1)] = function () { updaterInstallCallbackFired = true; };
  var relaunchCallbackFired = false;
  var REL_CB = 987654371;
  window['_' + REL_CB] = function () { relaunchCallbackFired = true; };
  window['_' + (REL_CB + 1)] = function () { relaunchCallbackFired = true; };

  function keylessInvokeBody() {
    // The main-frame invoke shape (scripts/core.js) MINUS a valid
    // Tauri-Invoke-Key. A WRITE command with a sentinel name, so that an invoke
    // which DID execute leaves an artifact the main frame can observe.
    return JSON.stringify({
      cmd: 'write_user_file',
      callback: CB,
      error: CB + 1,
      payload: { name: '${SENTINEL_NAME}' },
      options: { headers: { name: '${SENTINEL_NAME}' } }
    });
  }

  function keylessLanFetchBody() {
    // A REAL, well-formed lan_fetch call: a private literal in pair mode, the
    // shape the wizard itself sends. It must be well-formed precisely so that a
    // refusal cannot be attributed to a bad payload — if this command were
    // reachable, this call would be dispatched. The address is RFC-1918 and
    // will simply fail to connect on a runner; reaching the DISPATCHER is the
    // breakage, not reaching a bridge.
    //
    // BOTH callback and error slots are watched: a dispatched command that
    // errors resolves the ERROR callback, which is reach just the same.
    return JSON.stringify({
      cmd: '${LAN_FETCH_COMMAND}',
      callback: LAN_CB,
      error: LAN_CB + 1,
      payload: { url: 'https://192.168.255.253/api', method: 'GET', mode: 'pair' }
    });
  }

  function keylessSidecarFetchBody() {
    // A REAL, well-formed sidecar_fetch call — the shape an installed app sends.
    // Well-formed on purpose: a refusal must not be attributable to a bad
    // payload. On a runner the socket is absent, so a DISPATCHED call would
    // resolve the error callback; reaching the dispatcher is the breakage.
    return JSON.stringify({
      cmd: '${SIDECAR_FETCH_COMMAND}',
      callback: SIDECAR_CB,
      error: SIDECAR_CB + 1,
      payload: { method: 'GET', pathAndQuery: '/chats' }
    });
  }

  function keylessUpdaterCheckBody() {
    // A REAL, well-formed updater check — the exact shape the main frame's
    // @tauri-apps/plugin-updater check() posts. Well-formed on purpose: a refusal
    // must not be attributable to a bad payload. A dispatched check on a gate
    // runner fails on network and resolves the ERROR callback — reach either way.
    return JSON.stringify({
      cmd: '${UPDATER_CHECK_COMMAND}',
      callback: UPD_CB,
      error: UPD_CB + 1,
      payload: {}
    });
  }

  function keylessUpdaterInstallBody() {
    // rid 0 is a nonexistent resource: a DISPATCHED call answers "resource not
    // found" through the error callback, which is reach; a healthy shell drops the
    // keyless invoke before dispatch and neither slot ever fires.
    return JSON.stringify({
      cmd: '${UPDATER_INSTALL_COMMAND}',
      callback: INS_CB,
      error: INS_CB + 1,
      payload: { rid: 0, onEvent: 0 }
    });
  }

  function keylessRelaunchBody() {
    // See PROCESS_RELAUNCH_COMMAND's header: if this ever DISPATCHES the shell
    // restarts mid-gate — a self-announcing catastrophic failure, not a flake.
    return JSON.stringify({
      cmd: '${PROCESS_RELAUNCH_COMMAND}',
      callback: REL_CB,
      error: REL_CB + 1,
      payload: {}
    });
  }

  for (var k = 0; k < transports.length; k++) {
    try { transports[k].handler.postMessage(keylessInvokeBody()); } catch (e3) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessLanFetchBody()); } catch (e4) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessSidecarFetchBody()); } catch (e5) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessUpdaterCheckBody()); } catch (e6) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessUpdaterInstallBody()); } catch (e7) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessRelaunchBody()); } catch (e8) { /* transport rejected the shape */ }
  }

  function finishInvoke() {
    // The subframe reports only what it can honestly see. The verdict for
    // 'ipc-invoke-refused' is decided by the MAIN frame from the sentinel.
    parent.postMessage({
      type: '${REPORT_TYPE}',
      checks: out,
      probe: {
        transports: reachableNames,
        callbackFired: callbackFired,
        lanCallbackFired: lanCallbackFired,
        sidecarCallbackFired: sidecarCallbackFired,
        updaterCheckCallbackFired: updaterCheckCallbackFired,
        updaterInstallCallbackFired: updaterInstallCallbackFired,
        relaunchCallbackFired: relaunchCallbackFired
      }
    }, '*');
  }
  // Give any dispatch a generous window to (fail to) take effect.
  setTimeout(finishInvoke, 2500);
})();
${scEnd}</body></html>`;

interface ProbeReport {
  transports: string[];
  callbackFired: boolean;
  /** Per-command (amendment 16): did a keyless `lan_fetch` resolve into the subframe? */
  lanCallbackFired: boolean;
  /** Per-command: did a keyless `sidecar_fetch` resolve into the subframe? */
  sidecarCallbackFired: boolean;
  /** Per-command (ADR-0047): did a keyless `plugin:updater|check` resolve into the subframe? */
  updaterCheckCallbackFired: boolean;
  /** Per-command: did a keyless `plugin:updater|download_and_install` resolve into the subframe? */
  updaterInstallCallbackFired: boolean;
  /** Per-command: did a keyless `plugin:process|restart` resolve into the subframe? */
  relaunchCallbackFired: boolean;
}

/**
 * THE ENFORCEMENT VERDICT, decided in the MAIN frame (finding 2).
 *
 * `sentinelExists` is a legitimate, keyed invoke from the frame Tauri answers —
 * the one boundary where "did the keyless subframe invoke take effect?" is
 * actually observable. A missing/failed probe is a FAIL, never a pass: an
 * unanswerable sensor is exactly the defect this rework exists to remove.
 */
export function decideInvokeRefused(
  report: ProbeReport | undefined,
  sentinel: { exists: boolean } | { error: string },
): CheckResult {
  const id = 'ipc-invoke-refused';
  if ('error' in sentinel) {
    return { id, pass: false, detail: `sentinel probe unavailable (${sentinel.error}) — cannot vouch for refusal` };
  }
  if (report === undefined) {
    return { id, pass: false, detail: 'the sandboxed probe never reported — no invoke was attempted' };
  }
  const where = report.transports.length > 0 ? report.transports.join(', ') : 'no raw transport reachable';
  if (sentinel.exists) {
    return {
      id,
      pass: false,
      detail: `write_user_file EXECUTED from a sandboxed subframe via ${where} — the sentinel ${SENTINEL_NAME} exists in ~/Snug. STRUCTURAL BREAKAGE (Electron-fallback trigger)`,
    };
  }
  if (report.callbackFired) {
    return {
      id,
      pass: false,
      detail: `a keyless invoke through ${where} resolved a callback into the subframe — the IPC response path reaches sandboxed frames`,
    };
  }
  return {
    id,
    pass: true,
    detail:
      report.transports.length === 0
        ? 'no raw IPC transport reachable from the sandboxed subframe; sentinel absent'
        : `keyless write_user_file through ${where} left NO sentinel in ~/Snug (and resolved no callback) — key-gated as expected`,
  };
}

/**
 * THE PER-COMMAND VERDICT for `lan_fetch` (amendment 16). See
 * `LAN_FETCH_COMMAND` for why this sensor is a callback rather than an effect,
 * and why it is honest about being the weaker of the two.
 *
 * `keyReachable` is the conjunction of the three key-absence checks. It is a
 * REQUIRED input, not a courtesy: the callback signal alone cannot distinguish
 * "the command refused" from "the command ran and its response went somewhere
 * this frame cannot see" — which is exactly the unanswerable-sensor defect that
 * forced `ipc-invoke-refused`'s rework. Pairing it with "the invoke key never
 * reached this frame" is what makes the pass mean something.
 */
export function decideLanFetchRefused(
  report: ProbeReport | undefined,
  keyReachable: boolean,
): CheckResult {
  const id = 'ipc-lan-fetch-refused';
  if (report === undefined) {
    return { id, pass: false, detail: `the sandboxed probe never reported — no ${LAN_FETCH_COMMAND} invoke was attempted` };
  }
  const where = report.transports.length > 0 ? report.transports.join(', ') : 'no raw transport reachable';
  if (report.lanCallbackFired) {
    return {
      id,
      pass: false,
      detail: `${LAN_FETCH_COMMAND} resolved a callback into a sandboxed subframe via ${where} — the shell's pinned-TLS LAN transport is reachable from app code. STRUCTURAL BREAKAGE (Electron-fallback trigger)`,
    };
  }
  if (keyReachable) {
    return {
      id,
      pass: false,
      detail: `the invoke key is reachable from the sandboxed subframe, so a silent ${LAN_FETCH_COMMAND} cannot be ruled out — this check cannot vouch for refusal`,
    };
  }
  return {
    id,
    pass: true,
    detail: `keyless ${LAN_FETCH_COMMAND} through ${where} resolved no callback, and the invoke key never reached the subframe (see ipc-tauri-internals-absent) — key-gated per command`,
  };
}

/**
 * THE PER-COMMAND VERDICT for `sidecar_fetch` (ADR-0032), mirroring the one above
 * because the sensor problem and its honest answer are identical — see
 * `SIDECAR_FETCH_COMMAND`.
 *
 * The stakes differ, which is why it is a separate row rather than a shared one:
 * reaching this command from app code means reaching the process that holds the
 * user's WhatsApp linked-device session, i.e. reading every thread and sending as
 * them. `keyReachable` is a REQUIRED input for the same reason as above — the
 * callback signal alone cannot tell "refused" from "ran, and the answer went
 * somewhere this frame cannot see".
 */
export function decideSidecarFetchRefused(
  report: ProbeReport | undefined,
  keyReachable: boolean,
): CheckResult {
  const id = 'ipc-sidecar-fetch-refused';
  if (report === undefined) {
    return {
      id,
      pass: false,
      detail: `the sandboxed probe never reported — no ${SIDECAR_FETCH_COMMAND} invoke was attempted`,
    };
  }
  const where = report.transports.length > 0 ? report.transports.join(', ') : 'no raw transport reachable';
  if (report.sidecarCallbackFired) {
    return {
      id,
      pass: false,
      detail: `${SIDECAR_FETCH_COMMAND} resolved a callback into a sandboxed subframe via ${where} — app code can reach the WhatsApp helper, and with it the user's linked-device session. STRUCTURAL BREAKAGE`,
    };
  }
  if (keyReachable) {
    return {
      id,
      pass: false,
      detail: `the invoke key is reachable from the sandboxed subframe, so a silent ${SIDECAR_FETCH_COMMAND} cannot be ruled out — this check cannot vouch for refusal`,
    };
  }
  return {
    id,
    pass: true,
    detail: `keyless ${SIDECAR_FETCH_COMMAND} through ${where} resolved no callback, and the invoke key never reached the subframe (see ipc-tauri-internals-absent) — key-gated per command`,
  };
}

/**
 * THE PER-COMMAND VERDICTS for the update channel (ADR-0047 §3, TASK-20260821) —
 * one shared decision because the sensor, its weakness, and the honest pairing
 * with `keyReachable` are identical to the two rows above; only the command and
 * the stakes sentence differ. `fired` is that command's OWN callback-slot pair,
 * so reach proven for one command is never credited to another (amendment 16).
 */
export function decideUpdateChannelCommandRefused(
  id: (typeof IPC_CHECK_IDS)[number],
  command: string,
  breakage: string,
  report: (ProbeReport & { fired: boolean }) | undefined,
  keyReachable: boolean,
): CheckResult {
  if (report === undefined) {
    return { id, pass: false, detail: `the sandboxed probe never reported — no ${command} invoke was attempted` };
  }
  const where = report.transports.length > 0 ? report.transports.join(', ') : 'no raw transport reachable';
  if (report.fired) {
    return {
      id,
      pass: false,
      detail: `${command} resolved a callback into a sandboxed subframe via ${where} — ${breakage}. STRUCTURAL BREAKAGE`,
    };
  }
  if (keyReachable) {
    return {
      id,
      pass: false,
      detail: `the invoke key is reachable from the sandboxed subframe, so a silent ${command} cannot be ruled out — this check cannot vouch for refusal`,
    };
  }
  return {
    id,
    pass: true,
    detail: `keyless ${command} through ${where} resolved no callback, and the invoke key never reached the subframe (see ipc-tauri-internals-absent) — key-gated per command`,
  };
}

/**
 * THE POSITIVE TWIN for the updater (the `ipc-sidecar-fetch-dispatchable` rule
 * applied to the new surface): a refusal check over an UNREGISTERED command
 * vouches for nothing, so the main window must be able to dispatch
 * `plugin:updater|check` at all. A body-level failure (no network on a runner, a
 * 404 from the private repo) is a PASS — the body ran, which is the question.
 * Only the unregistered/uncapable shapes fail.
 */
export function decideUpdaterCheckDispatchable(outcome: { resolved: boolean; detail: string }): CheckResult {
  const id = 'ipc-updater-check-dispatchable';
  if (outcome.resolved) {
    return { id, pass: true, detail: `${UPDATER_CHECK_COMMAND} dispatched from the main window and resolved` };
  }
  if (/not found|not allowed|unknown command/i.test(outcome.detail)) {
    return {
      id,
      pass: false,
      detail: `${UPDATER_CHECK_COMMAND} is NOT DISPATCHABLE from the main window (${outcome.detail}) — unregistered or uncapable, so the three refusal rows opposite are vouching for nothing`,
    };
  }
  return {
    id,
    pass: true,
    detail: `${UPDATER_CHECK_COMMAND} dispatched and the command body answered: ${outcome.detail}`,
  };
}

/**
 * THE POSITIVE TWIN (TASK-20260817-telepath, next-steps 2026-08-17 §1).
 *
 * `ipc-sidecar-fetch-refused` PASSED while the command was UNREGISTERED — eight-seam
 * defect #1: `SidecarState` was never `.manage()`d, every invoke died at the IPC boundary,
 * and an unreachable-from-everywhere command satisfies an unreachability check perfectly.
 * So the negative check gets a twin proving the MAIN window can dispatch the command at
 * all. Refusal from inside the command body ("helper not running", an admission refusal)
 * is a PASS — the body ran, which is the whole question. Only the unregistered/uncapable
 * shapes fail: those mean the dispatch never happened and the negative check opposite is
 * vouching for nothing.
 */
export function decideSidecarFetchDispatchable(outcome: { resolved: boolean; detail: string }): CheckResult {
  const id = 'ipc-sidecar-fetch-dispatchable';
  if (outcome.resolved) {
    return { id, pass: true, detail: `${SIDECAR_FETCH_COMMAND} dispatched from the main window and resolved` };
  }
  if (/not found|not allowed|unknown command/i.test(outcome.detail)) {
    return {
      id,
      pass: false,
      detail: `${SIDECAR_FETCH_COMMAND} is NOT DISPATCHABLE from the main window (${outcome.detail}) — unregistered or uncapable, so the refusal check opposite is vouching for nothing`,
    };
  }
  return {
    id,
    pass: true,
    detail: `${SIDECAR_FETCH_COMMAND} dispatched and the command body answered: ${outcome.detail}`,
  };
}

export async function runIpcChecks(): Promise<CheckResult[]> {
  const { byId, report } = await new Promise<{ byId: Map<string, CheckResult>; report?: ProbeReport }>((resolve) => {
    const iframe = document.createElement('iframe');
    const finish = (value: { byId: Map<string, CheckResult>; report?: ProbeReport }): void => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ byId: new Map() }), TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const d = event.data as { type?: string; checks?: unknown; probe?: unknown } | null;
      if (d == null || d.type !== REPORT_TYPE || !Array.isArray(d.checks)) return;
      clearTimeout(timer);
      const collected = new Map<string, CheckResult>();
      for (const raw of d.checks as Array<{ id?: unknown; pass?: unknown; detail?: unknown }>) {
        if (typeof raw.id === 'string') {
          collected.set(raw.id, { id: raw.id, pass: raw.pass === true, detail: String(raw.detail ?? '') });
        }
      }
      const p = d.probe as { transports?: unknown; callbackFired?: unknown } | undefined;
      finish({
        byId: collected,
        ...(p != null
          ? {
              report: {
                transports: Array.isArray(p.transports) ? p.transports.map(String) : [],
                callbackFired: p.callbackFired === true,
                lanCallbackFired: (p as { lanCallbackFired?: unknown }).lanCallbackFired === true,
                // `=== true` per slot, deliberately: the report comes from the SANDBOXED
                // subframe, so a missing or non-boolean field must read as "did not fire"
                // rather than as truthy. Absence here is the safe direction only because
                // the verdict also requires the key to be unreachable.
                sidecarCallbackFired: (p as { sidecarCallbackFired?: unknown }).sidecarCallbackFired === true,
                updaterCheckCallbackFired:
                  (p as { updaterCheckCallbackFired?: unknown }).updaterCheckCallbackFired === true,
                updaterInstallCallbackFired:
                  (p as { updaterInstallCallbackFired?: unknown }).updaterInstallCallbackFired === true,
                relaunchCallbackFired: (p as { relaunchCallbackFired?: unknown }).relaunchCallbackFired === true,
              },
            }
          : {}),
      });
    };
    window.addEventListener('message', onMessage);
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.width = '320px';
    iframe.style.height = '200px';
    iframe.srcdoc = PROBE_HTML;
    document.body.appendChild(iframe);
  });

  // Ask Rust — from the main frame — whether the keyless write took effect.
  let sentinel: { exists: boolean } | { error: string };
  try {
    sentinel = { exists: (await invoke<boolean>('gate_ipc_sentinel_exists', { name: SENTINEL_NAME })) === true };
  } catch (err) {
    sentinel = { error: String(err) };
  }
  byId.set('ipc-invoke-refused', decideInvokeRefused(report, sentinel));

  // The per-command lan_fetch verdict (amendment 16) reads the three key-absence
  // checks the subframe already reported. A MISSING one counts as reachable —
  // a check that never ran cannot vouch for absence.
  const keyReachable = (['ipc-tauri-internals-absent', 'ipc-tauri-global-absent', 'ipc-chrome-webview-absent'] as const).some(
    (id) => byId.get(id)?.pass !== true,
  );
  byId.set('ipc-lan-fetch-refused', decideLanFetchRefused(report, keyReachable));
  byId.set('ipc-sidecar-fetch-refused', decideSidecarFetchRefused(report, keyReachable));
  byId.set(
    'ipc-updater-check-refused',
    decideUpdateChannelCommandRefused(
      'ipc-updater-check-refused',
      UPDATER_CHECK_COMMAND,
      'app code can probe and steer the shell update channel',
      report === undefined ? undefined : { ...report, fired: report.updaterCheckCallbackFired },
      keyReachable,
    ),
  );
  byId.set(
    'ipc-updater-install-refused',
    decideUpdateChannelCommandRefused(
      'ipc-updater-install-refused',
      UPDATER_INSTALL_COMMAND,
      'app code can drive binary installation as the user',
      report === undefined ? undefined : { ...report, fired: report.updaterInstallCallbackFired },
      keyReachable,
    ),
  );
  byId.set(
    'ipc-process-relaunch-refused',
    decideUpdateChannelCommandRefused(
      'ipc-process-relaunch-refused',
      PROCESS_RELAUNCH_COMMAND,
      'app code can relaunch the shell (the install flow\'s second half)',
      report === undefined ? undefined : { ...report, fired: report.relaunchCallbackFired },
      keyReachable,
    ),
  );

  // The POSITIVE twin, driven from the main frame — a real, well-formed app-route call.
  // Any answer from the command BODY passes; only the unregistered shapes fail.
  let dispatch: { resolved: boolean; detail: string };
  try {
    await invoke(SIDECAR_FETCH_COMMAND, { method: 'GET', pathAndQuery: '/chats' });
    dispatch = { resolved: true, detail: 'resolved' };
  } catch (err) {
    dispatch = { resolved: false, detail: String(err) };
  }
  byId.set('ipc-sidecar-fetch-dispatchable', decideSidecarFetchDispatchable(dispatch));

  // The updater's own positive twin: the main window must reach plugin:updater|check.
  let updaterDispatch: { resolved: boolean; detail: string };
  try {
    await invoke(UPDATER_CHECK_COMMAND, {});
    updaterDispatch = { resolved: true, detail: 'resolved' };
  } catch (err) {
    updaterDispatch = { resolved: false, detail: String(err) };
  }
  byId.set('ipc-updater-check-dispatchable', decideUpdaterCheckDispatchable(updaterDispatch));

  // EVERY id must be present — a missing verdict is a FAIL (AC7).
  return IPC_CHECK_IDS.map((id) => byId.get(id) ?? { id, pass: false, detail: 'no-verdict' });
}
