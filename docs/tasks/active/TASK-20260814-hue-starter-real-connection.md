# TASK-20260814-hue-starter-real-connection: apps address their connections — the Hue starter drives the real bridge

- **Status**: in-progress — plan approved by owner 2026-08-14; fresh-context AI plan review running (High-tier extra), then Gate 3 tests first
- **Owner**: Jeetu
- **Risk tier**: **High** — touches `packages/protocol` (addressing contract → C3 spec-sync) and `packages/auth` (connected-fetch executor); auto-escalate per PROCESS.md
- **Branch**: `feat/TASK-20260814-hue-starter-real-connection` (stacked on `fix/TASK-20260814-hue-pairing-e2e`, PR #46)
- **Packages touched**: `packages/protocol`, `packages/auth`, `packages/sdk` (embedded hooks doc/lockstep), `packages/knowledge` (authoring KB), `examples/hue-lights-party`, `apps/playground` (executor deps already wired; tests)
- **Spec impact**: **spec-sync required** (C3) — new connection-relative URL contract
- **Related**: ADR-0023 (LAN providers), ADR-0025 (verify-before-claim — owner hardware-CONFIRMED 2026-08-14: "paired and verified with the device at 192.168.1.x"), next-steps 2026-08-13 item 1 (the queued approved-host disclosure frame — this task is that item, commissioned), TASK-20260814-hue-pairing-e2e (predecessor — PR #46 open, hardware-verified)

## Spec (what & why)

Owner report (2026-08-14, post-ADR-0025 hardware test): pairing now verifies and says so
— but the freshly reinstalled starter app shows no acknowledgement of the connection and
still renders the mocked rooms/controls. Commission: **revamp the Hue starter to run on
the real connection — no dummy data.**

Root cause is the documented runtime gap (not a bug in the starter): an app's
`useConnectedFetch` takes a LITERAL url, the executor checks it against the frozen
ceiling, and **no mechanism lets an app address a connection whose host only the user
knows** (the bridge IP). The starter's greyed controls were the honest placeholder for
exactly this missing seat. Closing it needs:

1. a protocol-level way for an app to name its CONNECTION rather than a host,
2. the executor resolving that name to the connection's approved host and running every
   existing gate against the result,
3. the starter actually using it: real rooms/lights from CLIP v2, real scene writes,
   connected-state acknowledgement, honest fallbacks on web/unpaired.

**Interview decisions (owner, 2026-08-14):** symbolic connection-relative URLs (the app
never learns the IP) · fully real starter (mocked rooms deleted; rooms/lights from the
bridge; real scene writes) · probe-on-load as the status signal (no new frames at v1).

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — Protocol grammar.** `snug-connection://<slot><pathAndQuery>` owned by
   `packages/protocol`: scheme constant + one strict parser. Slot grammar REUSES
   `CONNECTION_SLOT_RULE` (`/^[a-z0-9][a-z0-9-]{0,39}$/` — review advisory: restating
   it would let a legit slot become unaddressable); remainder begins with a single `/`;
   typed failures. Unit tests include hostile shapes (`//`, `\`, `@`, empty slot,
   uppercase, scheme-in-path, 40+ char slot).
2. **AC2 — Executor resolution, gates intact, SAME row end to end (review issues 3-4).**
   Resolution sits AFTER gate 1 (shape/caps — the 4096 bound must precede any DB read)
   and BEFORE the URL-parse/scheme gates. One `listConnections` read is threaded
   through BOTH resolution and `resolveGrant` (no TOCTOU between the row that resolved
   and the row that injects). Refusals: unknown slot → `NET_INVALID_REQUEST`;
   unapproved → `NET_NOT_APPROVED`; ceiling ≠ exactly one host →
   `NET_AMBIGUOUS_CONNECTION`. Normalization guard compares via
   `normalizeAuthHost`/`isHostAllowed`, never raw string equality (`new URL()`
   lowercases + punycodes). `resolveGrant` RE-RUNS on the resolved host — the
   imported-row gate and the two-slot ambiguity gate are retained, and same-row
   injection is structural: the resolving slot's row must be among the host matches, so
   a unique match IS that row and a second match refuses. **Decided (ADR-0026 §2): two
   approved slots claiming the resolved host refuse with `NET_AMBIGUOUS_CONNECTION`
   even though the symbolic URL named one — fail-closed over clever.** Pinned test:
   slot A named symbolically while slot B claims the same host → refusal, slot B's
   credential never read. Literal URLs behave byte-identically (regression-pinned).
3. **AC3 — The resolved host never reaches the APP (review issue 1 — the scrub the
   draft relied on does not exist).** Mechanism, stated: for symbolic-origin requests
   the resolved host + href join the scrub candidate set, AND the host-bearing refusal
   messages on the symbolic path are genericized (gate 5's SSRF refusal at
   connected-fetch.ts:894 interpolates the host; the ambiguity message at :768
   likewise; `NET_FETCH_FAILED` embeds transport `err.message` which can carry the
   URL). **Decided: on web (no `transportPolicy`), a symbolic request resolving to a
   private host refuses at gate 5 as today — code `NET_SSRF_BLOCKED` — with a
   host-clean message; the starter maps it alongside `NET_FETCH_FAILED` as
   "unreachable from here". Pinned by a web-platform test.** A symbolic URL for an
   unapproved row refuses BEFORE any credential read; header stripping and response
   scrub unchanged; the sandbox gains no new capability — only a new spelling.
4. **AC4 — Authoring surfaces teach the scheme, cheaply.** The hooks comment change is
   a ONE-LINE pointer (the byte-compare lockstep sweeps all 14 example `app.html`
   copies + `20-html-template.md` + `sdk/types.ts` — review advisory: keep the churn
   minimal); the real teaching lives in `90-auth-and-connected-apis.md` (not
   byte-locked) + knowledge snapshots.
5. **AC5 — The starter is real (desktop).** `hue-lights-party`: mount probe
   `GET snug-connection://hue/clip/v2/resource/room` doubles as the data fetch.
   Connected → rooms rendered from the bridge (`metadata.name` + `services[]` rid where
   `rtype === 'grouped_light'`), scene apply = `PUT …/grouped_light/<rid>` with
   `{on, dimming, color:{xy}}` (hex→CIE-xy converter in-app, scene colors cycled across
   selected rooms), real brightness, partial failures surfaced per room. Not connected
   → the designer stays alive with code-keyed honest copy (`NET_NOT_APPROVED` →
   connect CTA; `NET_FETCH_FAILED`/`NET_SSRF_BLOCKED` → "unreachable from here";
   `NET_AMBIGUOUS_CONNECTION` → its own sentence, NEVER the connect CTA) + a re-check
   control. No mocked room/light data remains. **Web claims STRUCK (review issue 2):
   the Hue tile is web-locked by shipped e2e (starters-connect.spec.ts:145-192, a
   deliberate P3 decision) — unlocking it is the owner's queued UX call (next-steps
   2026-08-13 item 5), not this task's.** Single-file, CSP, no-storage and
   hooks-byte-identity rules hold.
6. **AC6 — Spec-sync (C3).** `docs/spec-changelog.md` entry follows the 2026-08-13
   INTERNAL-DRAFT posture (auth surface publishes no earlier than Beta exit); SPEC_SYNC
   followed; NO push to `snugprotocol/spec` without an explicit ask (recorded here).
7. **AC7 — Suites green across the full graph** (protocol touched → run everything):
   protocol, auth, sdk, knowledge, playground, desktop, examples — root green on the
   surfaces that CAN be green (the Windows desktop-shell gate stays deliberately RED,
   ADR-0021 D8 — review advisory).
8. **AC8 — The user sees the truth the app cannot (review advisory, adopted).** The
   confirm dialog for a symbolic request carries the RESOLVED host (the user-honesty
   half of the disclosure boundary; `NetConfirmDialog` renders `host`) — pinned by a
   test that the confirm request's host is the resolved one. Existing grant keying
   `(app, normalized host, method)` means the first scene PUT prompts once and
   session-remembers — verified by the review as already-correct behavior.
9. **AC9 — The ADR-0025 copy pin is REPLACED, not weakened (review issue 5).**
   `validate.test.mjs`'s "isn't available yet" assertion goes red against the rewrite
   BY DESIGN: it is replaced in the same commit by pins of the new code-keyed fallback
   copy; the other two assertions (no "waits for the desktop app", no "which a web
   page cannot reach") survive verbatim.

**Out of scope**: host→app live status events (probe chosen; hostEvent namespace stays
open); multi-host symbolic resolution (refused, not invented); scrubbing response
bodies for private-IP shapes (ADR-0026 §3 documents the boundary); other starters
adopting the scheme; Settings pill verified-awareness (already queued 2026-08-14).

## Plan

Order is tests-first per TDD.md; branch stacked on `fix/TASK-20260814-hue-pairing-e2e`
(PR #46, awaiting owner review) — rebase onto `main` after #46 merges.

1. **ADR-0026** (drafted with this plan): connection-relative addressing — symbolic
   URLs, executor resolution before intact gates, request-side disclosure boundary,
   probe-on-load at v1, single-host own-slot scope.
2. **`packages/protocol`** — scheme constant + `parseConnectionUrl` in
   `constants.ts`/new module + tests FIRST (AC1 hostile-shape table). Spec-changelog
   entry drafted in the same commit (AC6).
3. **`packages/auth` connected-fetch** — resolution step + tests FIRST (AC2/AC3):
   refusal triple, normalization guard, literal-URL regression, LAN-lane routing of a
   resolved URL (fixture reuses the pinned-transport test harness).
4. **`packages/sdk` + examples lockstep** — hook doc comment; byte-sync sweep across
   all example `app.html` hooks blocks + `sdk/types.ts` (one commit, kb-sync test
   enforces).
5. **`packages/knowledge`** — `90-auth-and-connected-apis.md` teaches the scheme +
   snapshots.
6. **`examples/hue-lights-party`** — the real rewrite (AC5) + examples validate-test
   updates pinning: no mocked rooms, probe present, code-keyed fallback copy.
7. **Threat-model delta** — `docs/security/threat-model-delta-connection-addressing.md`
   (review advisory: a new app-facing addressing primitive with a stated disclosure
   boundary follows the house pattern of prior net/auth surface changes).
8. **Verification** — root `pnpm test` (protocol is upstream of everything); e2e specs
   checked for pinned starter copy.
9. **High-tier extra** — fresh-context AI plan review BEFORE implementation: **DONE
   2026-08-14, approve-with-changes; all 5 confirmed issues folded into AC2/AC3/AC5/
   AC9 and ADR-0026 (see journal)**; self-sign-off at close.
10. **Owner retest script (after merge):** reinstall the Hue starter (installed apps
    carry a COPY of app.html — the old install will NOT update itself), open it on
    desktop with the paired connection: expect real rooms from your bridge; the first
    scene apply asks once for the write grant (the dialog names your bridge's IP —
    that's the user-honesty half of the boundary), then drives the lights.

## Decisions & surprises

- Recon (this session): `netRequestSchema.url` is a plain bounded string — a
  connection-relative scheme passes the frame layer untouched; the contract change is
  executor + protocol constants + runtime-contract docs (spec-sync still owed, C3).
  `hostEvent` is an open namespace ("consumers ignore unknown events") — additive
  status events need no schema change. Changing `sdk/embedded/snug-hooks.js` triggers
  the three-way byte-compare lockstep (all example `app.html` copies + `sdk/types.ts`).
  Installed apps carry a COPY of app.html — the owner must reinstall the starter after
  merge to see the revamp.
- Error-code mapping reuses the existing vocabulary (`NET_INVALID_REQUEST` /
  `NET_NOT_APPROVED` / `NET_AMBIGUOUS_CONNECTION`) with distinct messages — no new
  codes unless implementation finds a gap; if one is needed it is a protocol-constants
  addition inside the already-owed spec-sync.
- ADR-0025's owner hardware verification is CONFIRMED by this report ("paired and
  verified with the device at 192.168.1.x") — recorded against PR #46.

## Decisions & surprises

- Recon (this session): `netRequestSchema.url` is a plain bounded string — a
  connection-relative scheme passes the frame layer untouched; the contract change is
  executor + protocol constants + runtime-contract docs (spec-sync still owed, C3).
  `hostEvent` is an open namespace ("consumers ignore unknown events") — additive
  status events need no schema change. Changing `sdk/embedded/snug-hooks.js` triggers
  the three-way byte-compare lockstep (all example `app.html` copies + `sdk/types.ts`).
  Installed apps carry a COPY of app.html — the owner must reinstall the starter after
  merge to see the revamp.

## Session journal (append-only, newest last)

### 2026-08-14 — Claude (Fable) — session
- Done: recon of frames/hooks/executor seams; task file created.
- State: interviewing owner; ADR-0025's hardware verification implicitly CONFIRMED by
  this report (pairing verified against the real bridge).
- Next step: interview → plan → ADR-0026 draft → branch → stop for approval.

### 2026-08-14 — Claude (Fable) — session (continued, post-approval)
- Done: owner approved the plan (symbolic URLs · fully real starter · probe-on-load).
  PR #46 opened for the predecessor branch with the hardware verification recorded.
  High-tier fresh-context plan review ran: **approve-with-changes, 5 confirmed
  issues, all folded before Gate 3**: (1) the "existing URL scrub" the draft cited
  does not exist — mechanism now explicit (resolved host/href join scrub candidates;
  gate-5/ambiguity/transport messages genericized on the symbolic path; web yields
  `NET_SSRF_BLOCKED` host-clean, mapped as unreachable); (2) AC5's web claims struck —
  the Hue tile is web-locked by shipped e2e and unlocking it stays the owner's queued
  UX call; (3) resolution seat corrected to after-gate-1/before-URL-gates, canonical
  host comparison, one row read threaded through resolution + `resolveGrant`;
  (4) same-row pinning made structural and the double-ambiguity semantic DECIDED
  (fail-closed refusal even when the symbolic URL names one slot; pinned test: slot
  B's credential never read); (5) the ADR-0025 "isn't available yet" copy pin is
  REPLACED deliberately, not weakened. Advisories adopted: `CONNECTION_SLOT_RULE`
  reuse, `NET_AMBIGUOUS_CONNECTION` never renders the connect CTA, https-only
  carve-out in ADR §5, one-line hooks pointer (teaching in KB), threat-model delta
  doc, confirm-dialog resolved-host pin (new AC8), AC7 worded against the
  deliberately-red Windows gate.
- State: plan + ADR amended; Gate 3 next.
- Next step: failing tests — protocol parser → executor resolution/refusals/scrub →
  examples pins; then implement in plan order.

### 2026-08-14 — Claude (Fable) — session (continued, Gates 3-5)
- Done — Gate 3: red tests (protocol parser 19-case table incl. hostile shapes; 12
  executor resolution/disclosure tests; examples real-connection pins replacing the
  ADR-0025 copy pin per AC9). Gate 4: protocol `connection-url.ts` (slot rule imported,
  three-way result); executor resolution (post-gate-1, one rows read through
  `resolveGrant`, host-clean symbolic refusals, error-only scrub); hooks one-liner with
  the full 16-surface lockstep (kb-sync + examples byte-compares green); KB teaching
  section; the REAL starter (mount probe doubles as rooms fetch, per-room grouped_light
  scene writes, code-keyed fallbacks); spec-changelog INTERNAL-DRAFT entry;
  threat-model delta; code-map row; README rewrite.
- Done — Gate 5: /code-review high, EIGHT finder angles, all folded:
  - executor: imported rows keep `NET_IMPORTED_UNAPPROVED` on the symbolic path (the
    one live divergence); `new URL(path, base)` construction; whitespace-normalized
    scheme match (the WHATWG-stripping mismatch); delivery-seat backstop scrub so the
    disclosure boundary holds by construction; shared refusal helpers.
  - wizard (stacked-branch hardening): session-scoped error-store write AND durable
    writes (a stale failed attempt can no longer clobber a newer verified pairing —
    this supersedes the earlier keep-proof-on-close choice, deliberately); verify
    guard is the value-token template fact (the header NAME satisfied the substring
    form); 401/403 vs device-busy verify sentences; reapproval catch bumps; error
    store cleared on refresh + §5 downgrade; `slotCredentialStore` helper.
  - starter: table-driven notices with a "connected it — check again" exit from the
    connect phase (the frame cannot observe pairing finishing); first-write-then-
    parallel apply aborting on denial/unreachable; delivered 401/403 → connect CTA;
    results keyed by room id (Hue permits duplicate names); the RFC-1918 pin derives
    from the protocol classifier.
  - docs: restored the 2026-08-13 spec-changelog heading my entry had consumed; fixed
    the examples suite's stale "NO manifest" hue comment.
  - One self-inflicted defect caught by the suite mid-fold (the extracted store helper
    briefly recursed into itself) — fixed before commit; the 57-test failure wave was
    exactly the tsc-gated suite doing its job.
  - Deliberately deferred, queued in next-steps with reasons: flow-kind classification
    (five-guard scatter), shared auth test harness (tenth copy), scoped failed-pairing
    bump, dead `onPaired` prop. Gate 9a divergence and probe-in-playground remain
    ADR-recorded decisions.
- Verification: auth 729 · playground 1028 · protocol 299+19 · sdk 41 · examples
  149+34 · root 21/21 green after every fold.
- **High-tier self-sign-off**: plan fresh-context-reviewed before implementation (5
  issues folded pre-code); tests first (red commit precedes implementation); C1/C2
  negatives present (symbolic-path host-clean tests, credential-never-read test,
  response-body non-scrub pin); spec-sync satisfied at the INTERNAL-DRAFT posture with
  zero schema bytes changed and NO spec-repo push; no test deleted or weakened (the
  one replaced pin is AC9's documented replacement, stronger in the same commit).
  Signed: Claude (Fable), 2026-08-14.
- State: branch complete pending owner review; stacked on PR #46 (merge that first,
  then this rebases clean). Owner retest owed after merge — REINSTALL the starter
  (installed apps keep their HTML copy), then: open on desktop → real rooms appear →
  first apply prompts once (the dialog names the bridge IP) → lights change.
- Next step: owner review → merge #46 → rebase → PR → merge → move task file to done/
  → hardware retest.

### 2026-08-15 — Claude (Fable) — close-session (Gate 6)
- Done: PR #46 merged first (owner's explicit instruction); this branch rebased clean
  onto `main` (8 commits, no conflicts). Gate-6 batch in-branch: ADR-0025 + ADR-0026
  flipped to **accepted** (0025's §1 clause aligned to the final token-fact guard),
  three lessons added (mechanical extract-helper recursion; substring-over-template
  guards; anchored-Edit heading consumption), pairing task file moved to done/ with its
  close entry, decisions README de-proposed.
- State: about to verify (root suite on the rebase), push, open the PR, and merge on
  the owner's standing instruction; the task file moves to done/ in a follow-up commit
  after the merge (a file cannot record its own merge).
- Next step: owner hardware retest — REINSTALL the Hue starter (installed apps keep
  their HTML copy), open on desktop, expect real rooms, first apply prompts once, lights
  change. Open questions: none; deferred items are queued in next-steps 2026-08-14.
