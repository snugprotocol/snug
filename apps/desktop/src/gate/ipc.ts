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

  for (var k = 0; k < transports.length; k++) {
    try { transports[k].handler.postMessage(keylessInvokeBody()); } catch (e3) { /* transport rejected the shape */ }
    try { transports[k].handler.postMessage(keylessLanFetchBody()); } catch (e4) { /* transport rejected the shape */ }
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
        lanCallbackFired: lanCallbackFired
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

  // EVERY id must be present — a missing verdict is a FAIL (AC7).
  return IPC_CHECK_IDS.map((id) => byId.get(id) ?? { id, pass: false, detail: 'no-verdict' });
}
