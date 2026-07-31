# 0006 — Runner CSP allows 'unsafe-eval' + a fixed CDN allowlist

- **Status:** accepted
- **Date:** 2026-07-31
- **Task:** TASK-20260731-runner-sandbox

## Context

Snug apps are single-file HTML artifacts authored by an LLM at conversation time: React 18, ReactDOM, and Babel-standalone load as UMD scripts from CDNs, and the app's JSX is compiled **in the browser** by Babel-standalone — which requires `eval`/`new Function`. A CSP without `'unsafe-eval'` (or with no CDN script sources) would break the entire app-authoring model shipped in `packages/knowledge` (the mandatory HTML template). At the same time, hard constraint C2 demands that the sandbox never becomes an exfiltration or persistence surface.

## Decision

`RUNNER_CSP` (frozen constant in `packages/runner/src/csp.ts`) is: `default-src 'none'` with `script-src 'unsafe-inline' 'unsafe-eval' {CDN_ALLOWLIST}`, `style-src 'unsafe-inline' {CDN_ALLOWLIST}`, `font-src {CDN_ALLOWLIST} data:`, `img-src data: blob:`, and `'none'` for connect/worker/child/frame/object/base-uri/form-action. The allowlist is the protocol's `CDN_ALLOWLIST` (jsdelivr, cdnjs, unpkg) and is never widened at runtime; no API parameterizes the policy (source-guard test enforced).

The **load-bearing** security controls are NOT the script-source restrictions:

- `connect-src 'none'` — no fetch/XHR/WS/beacon exfiltration path at all;
- the opaque origin from `sandbox="allow-scripts"` (never `allow-same-origin`) — no cookies, no storage, no origin authority;
- `worker-src 'none'; child-src 'none'; frame-src 'none'` — no worker or nested browsing context as a side-channel (plan review F3);
- navigation cutoff in the host (F2) — a self-navigating app is permanently cut off.

The CDN allowlist is a **supply-availability** control, not an integrity control: anything on those CDNs can run in the sandbox, and that is accepted because the sandbox has nothing to steal and nowhere to send it. Meta-tag delivery is defense-in-depth; serving the same policy via HTTP headers is a recorded obligation of `apps/server`/Playground, and srcdoc CSP inheritance from the embedder page is a recorded Playground (child 6) constraint.

## Alternatives considered

- **No `'unsafe-eval'` (precompiled apps):** would require a build/compile step for LLM output — kills the copy-one-file authoring model for v1. Revisit trigger: if apps ever ship precompiled (no Babel-standalone), drop `'unsafe-eval'` immediately.
- **Nonces/hashes instead of `'unsafe-inline'`:** meaningless when the document author is the (untrusted) LLM — it would nonce its own scripts.
- **Subresource Integrity on CDN scripts:** the LLM writes the tags; SRI enforced by templates is advisory only, and CDN ≠ integrity control was accepted explicitly (above).
- **Self-hosting the libraries instead of CDNs:** stronger supply control, but couples every embedder to asset hosting; deferred — the allowlist lives in one protocol constant and can shrink without a protocol change.

## Consequences

Apps can `eval` freely; the sandbox is treated as fully attacker-controlled and everything security-relevant happens at its boundary (host frame validation, C1 token boundary, size limits, budget). Real-browser enforcement of this policy is verified by `browser-csp.spec.template.ts` executed in the Playground Playwright harness (F11) — jsdom tests only pin the policy text and injection mechanics.
