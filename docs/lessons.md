# Lessons ledger (append-only)

Short, forward-looking rules learned the hard way. **The agent reads this when planning (Gate 2).** Newest at top, ≤10 lines each. Entry shape: `## YYYY-MM-DD — <one-line rule>` then **Context**, **What happened**, **Rule**.

---

## 2026-07-31 — Every child merge gets an independent adversarial review with runnable probes
**Context:** TASK-20260731-build-hub, six child tasks. **What happened:** fresh-context reviewers with permission to run probe scripts found, pre-merge: a C1 credential leak via the envelope's `responseSchema` field, exported JSON Schemas that contradicted the protocol's own forward-compat rule, KB hook code reading db fields at the wrong nesting level (would have broken persistence in every generated app), and a meta-CSP injection bypass. None were caught by the authors' own green suites. **Rule:** High/Medium merges require a reviewer that did not write the code, prompted to attack specific constraint surfaces and to RUN its probes — "tests pass" is not review.

## 2026-07-31 — When one contract lives in two artifacts, add a byte-compare sync test
**Context:** the KB teaches copy-exactly hook code that `packages/sdk` also ships; prompt files carry wire literals. **What happened:** the KB≡SDK sync test caught a data-loss bug (usePersistedState key-change) and the placeholder-injection tests caught retyped constants; the ancestors' 4-way duplicated envelope tag was exactly this failure mode at scale. **Rule:** never let the same contract exist twice by convention — inject from one source or lock the copies with a byte-compare test in CI.

## 2026-07-31 — Browser security APIs lie in their return values; assert the enforcement signal
**Context:** the real-browser CSP gate. **What happened:** modern Chromium returns `true` from `navigator.sendBeacon` even when `connect-src` blocks the send — the check read the boolean and reported a hole that wasn't there. **Rule:** CSP/sandbox tests must assert the enforcement signal (`securitypolicyviolation` events, absence of network effects), not API return values.

## 2026-07-31 — Never trust availability by memory; verify names before proposing them
**Context:** TASK-20260731-bootstrap (naming rounds). **What happened:** ~20 candidate names (Whim, Carve, Knit, Gizmo, Nook, Yurt, Birdhouse, AXP…) all died on verification against GitHub orgs and web search — every "obviously free" name was taken by an active AI product. **Rule:** any public-facing name (package, command, protocol message) gets a GitHub/npm/web check *before* it is proposed, in the same session.

## 2026-07-31 — Port the hardening, not the bugs
**Context:** audits of the prior production systems this work extracts from. **What happened:** those systems contain a broken two-layer OAuth callback (`userLayer` never unwrapped) and an off-by-default strict-host-injection flag (prompt-injection exfiltration path). **Rule:** when extracting, carry forward the DB invariants + host-freeze from the hardened port and the PKCE/refresh/scrubbing from the original — and never reintroduce configurable security (strictness is not a flag).

## 2026-08-02 — `??` fallbacks make empty env vars a silent foot-gun
**Context:** apps/server config + .env.example authoring. **What happened:** `SNUG_MODEL=` (present but empty) defeats a `?? 'default'` fallback — empty string is not `undefined` — so the "default" silently becomes `''`. **Rule:** env templates comment optional vars out rather than leaving them empty, and config readers treat `''` as unset (`value || fallback` or explicit trim-check) for any var with a fallback.
