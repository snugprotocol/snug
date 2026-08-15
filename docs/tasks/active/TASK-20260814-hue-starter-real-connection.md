# TASK-20260814-hue-starter-real-connection: apps address their connections — the Hue starter drives the real bridge

- **Status**: planned — awaiting owner plan approval (Gate 2 stop)
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
   `packages/protocol`: scheme constant + one strict parser (slot `[a-z0-9][a-z0-9-]*`,
   remainder begins with a single `/`; typed failures). Unit tests include hostile
   shapes (`//`, `\`, `@`, empty slot, uppercase, scheme-in-path).
2. **AC2 — Executor resolution, gates intact.** Connected-fetch resolves the calling
   app's OWN slot before gate 1: unknown slot → `NET_INVALID_REQUEST`; unapproved →
   `NET_NOT_APPROVED`; ceiling ≠ exactly one host → `NET_AMBIGUOUS_CONNECTION`.
   Resolved URL re-parsed; host must equal the ceiling host (normalization guard). ALL
   existing gates then run on the resolved URL — including the confirm gate, credential
   injection, gate 9a's pinned LAN lane, caps and scrub. Literal URLs behave
   byte-identically (regression-pinned).
3. **AC3 — C1/C2 negatives.** A symbolic URL for an unapproved row refuses BEFORE any
   credential read; credential-header stripping and response scrub unchanged; the
   resolved host never reaches the app in any error message (URL-scrub covers the
   resolved form). The sandbox gains no new capability — only a new spelling for one it
   had.
4. **AC4 — Authoring surfaces teach the scheme.** `useConnectedFetch`'s doc comment in
   `sdk/embedded/snug-hooks.js` + the app-authoring KB (`90-auth-and-connected-apis.md`)
   teach when to use symbolic addressing; kb-sync byte-compare enforced across ALL
   example `app.html` copies + `sdk/types.ts` in one commit; knowledge snapshots
   updated.
5. **AC5 — The starter is real.** `hue-lights-party`: mount probe
   `GET snug-connection://hue/clip/v2/resource/room` doubles as the data fetch.
   Connected → rooms rendered from the bridge (name + grouped_light rid), scene apply =
   `PUT …/grouped_light/<rid>` with `{on, dimming, color:{xy}}` (hex→CIE-xy converter
   in-app, scene colors cycled across selected rooms), real brightness, partial
   failures surfaced per room. Not connected → the designer stays alive with
   code-keyed honest copy (`NET_NOT_APPROVED` → connect CTA; transport-shaped →
   "unreachable from here", which is also the web answer) + a re-check control. No
   mocked room/light data remains anywhere in the file. Single-file, CSP, no-storage
   and hooks-byte-identity rules hold (examples validate suite).
6. **AC6 — Spec-sync (C3).** `docs/spec-changelog.md` entry; SPEC_SYNC.md followed for
   the contract addition. NO push to `snugprotocol/spec` without an explicit ask in
   that session (recorded here).
7. **AC7 — Suites green across the full graph** (protocol touched → run everything):
   protocol, auth, sdk, knowledge, playground, desktop, examples — root all-green.

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
7. **Verification** — root `pnpm test` (protocol is upstream of everything); e2e specs
   checked for pinned starter copy.
8. **High-tier extra** — fresh-context AI plan review BEFORE implementation (after
   owner approval), self-sign-off at close.
9. **Owner retest script (after merge):** reinstall the Hue starter (installed apps
   carry a COPY of app.html — the old install will NOT update itself), open it on
   desktop with the paired connection: expect real rooms from your bridge, scene apply
   asks once for the write grant then drives the lights; on web expect the designer +
   "unreachable from here" honesty.

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
