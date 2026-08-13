# WebView2 injects Tauri's invoke key into sandboxed subframes — ADR-0021 D8 trigger met

- **Date:** 2026-08-13
- **Found by:** the desktop in-shell hard gate, on its **first ever Windows run** (PR #42, run 31699269600, job 94444243959)
- **Status:** CONFIRMED structural. Windows desktop is BLOCKED. macOS is unaffected and remains green at 40/40.
- **Related:** ADR-0021 Decision 8 (the pre-committed fallback trigger), `docs/security/threat-model-delta-desktop-shell.md`, `docs/security/threat-model-delta-desktop-auth.md` R-5

## What the gate said

Three of forty checks failed, all inside a `sandbox="allow-scripts"` srcdoc iframe — the
exact posture of a Snug app iframe:

```
FAIL ipc-tauri-internals-absent   window.__TAURI_INTERNALS__ present — invoke key may be reachable
FAIL ipc-chrome-webview-absent    window.chrome.webview present
FAIL ipc-lan-fetch-refused        the invoke key is reachable from the sandboxed subframe, so a
                                  silent lan_fetch cannot be ruled out
PASS ipc-invoke-refused           keyless write_user_file through chrome.webview left NO sentinel
```

macOS passes all four. The asymmetry is real, not a flaky check.

## Root cause (every link verified against the pinned crate sources on disk)

1. **Tauri asks for main-frame-only injection.** The key-bearing bootstrap is wrapped in
   `main_frame_script`, which hard-codes `for_main_frame_only: true`
   (`tauri-2.11.5/src/manager/webview.rs:159-164`, pushed at `:182` for
   `invoke_initialization_script`, i.e. `ipc-protocol.js`).
2. **The invoke key is a plaintext literal inside that script**, not fetched over a
   channel a subframe cannot use: `tauri-2.11.5/scripts/ipc-protocol.js:12` —
   `const __TAURI_INVOKE_KEY__ = __TEMPLATE_invoke_key__`, used at `:35` and embedded in
   the postMessage body at `:81`. Any frame the script RUNS IN holds the key in a closure.
   Tauri's own comment (`:9-11`) says the `const` exists to stop `.toString()` leaking the
   key — a reflection defense, not a cross-frame one.
3. **WebView2 ignores the request.** `wry-0.55.1/src/webview2/mod.rs:492-494` iterates
   `attributes.initialization_scripts` and **never reads `for_main_frame_only`** (its own
   comment: "Initialize main and subframe scripts"). wry documents this in the field's
   doc-comment (`wry-0.55.1/src/lib.rs:2494-2496`): *"**Windows**: scripts are always
   injected into subframes regardless of this option. This will be the case until Webview2
   implements a proper API to inject a script only on the main frame."* The macOS path DOES
   honor it — `wry-0.55.1/src/wkwebview/mod.rs:643-644` passes the flag to
   `WKUserScript::initWithSource_injectionTime_forMainFrameOnly`. **That one line is the
   entire platform divergence.**

So `__TAURI_INTERNALS__` in a Windows subframe is not a hollow shell: the seed object and
the key-bearing script ride the identical code path, so a frame that got one got both.

## Why `ipc-invoke-refused` passing is not reassurance

That probe posts a **keyless** body; `tauri-2.11.5/src/webview/mod.rs` compares
`request.invoke_key` to the manager's and bare-returns on mismatch. The PASS proves the
lock works — which was never in doubt. It says nothing about a frame that can simply READ
the key and send a valid one. `decideLanFetchRefused` is the only check that reasoned about
key reachability, which is why it fired.

## No off-switch at any layer (the condition D8 names)

- **wry**: `for_main_frame_only` is consumed only in the wkwebview and webkitgtk backends;
  the webview2 backend never reads it. No flag, attribute, or feature gate.
- **tauri**: `initialization_script_for_all_frames` lets you opt *into* all frames; there is
  no opt-out on Windows, because the option is already set correctly and ignored downstream.
- **WebView2 SDK**: no frame-scoped injection API exists (per wry's own comment).

`AddScriptToExecuteOnDocumentCreated` is webview-wide by design.

## One link not verifiable from macOS

Whether Rust-side origin checks would independently refuse a KEYED invoke from an
opaque-origin srcdoc frame depends on what `args.Source()` reports for such a frame
(`wry-0.55.1/src/webview2/mod.rs:895-899` → `tauri/src/ipc/protocol.rs:305`). If it reports
the parent document URL, `is_local_url` passes and the frame is Rust-indistinguishable from
the main frame. This is the difference between "proven exploitable" and "structurally
reachable" — **D8's trigger is written against reachability, which is established**, so the
verdict does not depend on it. The security posture must not rest on this link.

## Disposition

1. **The gate stays failing on Windows.** It is telling the truth. Softening the
   `keyReachable` derivation would make the gate lie on the one platform where the
   transport/key distinction has collapsed.
2. **Windows desktop is BLOCKED**, upgraded from "unverified" to "known structurally
   broken". No Windows build has ever been distributed; none may ship in this configuration.
3. **macOS is unaffected** and its 40/40 pass remains trustworthy.
4. **ADR-0021 D8 is now a live decision** (owner's call): Electron fallback, ship
   macOS-only, or upstream a `for_main_frame_only` fix to wry/WebView2.

## Optional confirmatory probe (does not change the verdict)

Have the subframe report BOOLEANS only — never the key or its value — e.g. whether
`Object.getOwnPropertyNames(window.__TAURI_INTERNALS__)` includes `metadata`
(pushed immediately after the key script), or attempt a real KEYED
`write_user_file` against the existing sentinel and check it from the main frame. That
upgrades "structurally reachable" to "demonstrated exploitable".
