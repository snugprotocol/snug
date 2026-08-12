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
// REAL `read_user_file` invoke message through every reachable raw transport
// (webkit.messageHandlers.ipc, chrome.webview) WITHOUT a valid key — because
// the subframe has none — and passes only if NO callback ever fires (absence
// of effect, the CSP suite's discipline per lessons.md 2026-07-31). A callback
// that DOES fire = the command executed = FAIL and the Electron-fallback
// trigger. Silence within the window = refused = PASS.
//
// The probe page is hand-built and deliberately CSP-FREE: these checks are
// about what the SHELL injects into subframes, which a CSP could only mask.

import type { CheckResult } from './types.js';

export const IPC_CHECK_IDS = [
  'ipc-tauri-internals-absent',
  'ipc-tauri-global-absent',
  'ipc-chrome-webview-absent',
  'ipc-invoke-refused',
] as const;

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

  var executed = false;
  // A callback name a keyed invoke WOULD call back into. If the command runs,
  // Tauri resolves through window[callback] — so we install one and watch it.
  var CB = 987654321;
  window['_' + CB] = function () { executed = true; };

  function keylessInvokeBody(name) {
    // The main-frame invoke shape (scripts/core.js) MINUS a valid Tauri-Invoke-Key.
    return JSON.stringify({
      cmd: 'read_user_file',
      callback: CB,
      error: CB + 1,
      payload: { name: 'user.sqlite' },
      options: {}
    });
  }

  for (var k = 0; k < transports.length; k++) {
    try { transports[k].handler.postMessage(keylessInvokeBody(transports[k].kind)); } catch (e3) { /* transport rejected the shape */ }
  }

  function finishInvoke() {
    if (executed) {
      add('ipc-invoke-refused', false, 'read_user_file EXECUTED via a reachable transport (' + reachableNames.join(', ') + ') — structural breakage');
    } else if (transports.length === 0) {
      add('ipc-invoke-refused', true, 'no raw IPC transport reachable — invoke not deliverable');
    } else {
      add('ipc-invoke-refused', true, 'keyless invoke through ' + reachableNames.join(', ') + ' did not execute (no callback within 2500ms) — key-gated as expected');
    }
    parent.postMessage({ type: '${REPORT_TYPE}', checks: out }, '*');
  }
  // Give any dispatch a generous window to (fail to) call back.
  setTimeout(finishInvoke, 2500);
})();
${scEnd}</body></html>`;

export function runIpcChecks(): Promise<CheckResult[]> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    const finish = (byId: Map<string, CheckResult>): void => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
      // EVERY id must be present — a missing verdict is a FAIL (AC7).
      resolve(
        IPC_CHECK_IDS.map((id) => byId.get(id) ?? { id, pass: false, detail: 'no-verdict' }),
      );
    };
    const timer = setTimeout(() => finish(new Map()), TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const d = event.data as { type?: string; checks?: unknown } | null;
      if (d == null || d.type !== REPORT_TYPE || !Array.isArray(d.checks)) return;
      clearTimeout(timer);
      const byId = new Map<string, CheckResult>();
      for (const raw of d.checks as Array<{ id?: unknown; pass?: unknown; detail?: unknown }>) {
        if (typeof raw.id === 'string') {
          byId.set(raw.id, { id: raw.id, pass: raw.pass === true, detail: String(raw.detail ?? '') });
        }
      }
      finish(byId);
    };
    window.addEventListener('message', onMessage);
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.width = '320px';
    iframe.style.height = '200px';
    iframe.srcdoc = PROBE_HTML;
    document.body.appendChild(iframe);
  });
}
