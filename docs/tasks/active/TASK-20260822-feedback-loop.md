# TASK-20260822-feedback-loop: Anonymous in-product feedback loop (web + desktop) + SSO hide

- **Status**: planned — awaiting owner plan approval (Gate 2 stop)
- **Owner**: jeetu
- **Risk tier**: **Medium** (playground logic + a new `apps/*` service; NO changes to `packages/protocol`/`runner`/`auth` code, no C1/C2 weakening, no CI/release config — auto-escalation not triggered)
- **Branch**: `feat/TASK-20260822-feedback-loop` (created)
- **Packages touched**: `apps/playground` (+ `apps/desktop` via source reuse — its suite must run), **new** `apps/feedback` (Cloudflare Worker + D1). `packages/auth` is consumed (scrub helper), not changed.
- **Spec impact**: none — no envelope/frame/userdb change; feedback is host-page UI + an external origin. Sandbox guard suites must stay green as proof.
- **Related**: ADR-0052 (drafted this task — amends ADR-0013), ADR-0013 (static hub), ADR-0047 (`releaseChannel.ts` single-homed-URL precedent), threat-model R-24 (scanner misses keys in prose), internal roadmap B6 (superseded shape), `docs/next-steps.md` launch-readiness entry.

## Spec (what & why)

End users of the playground are anonymous by design — no SSO, no accounts — and today have
**no path to tell us anything** when an app breaks, a build fails, or the wizard can't
connect; GitHub serves contributors only. This task builds a non-intrusive, top-tier
in-product feedback loop on both web and desktop: inline "report this" affordances at
existing error surfaces (diagnostics pre-filled, user-reviewable before send), a quiet
general feedback / feature-request launcher, and one-tap 👍/👎 on installed/starter apps.
Submissions go anonymously (email optional) to a Snug-operated Cloudflare Worker + D1
receiver (`feedback.snugprotocol.org`). Owner interview (2026-08-22) fixed: receiver =
CF Worker + D1 (Firebase rejected — Google dependency + public-config spam surface;
`apps/server` rejected — no authz, contradicts ADR-0013); all four surfaces in scope;
consent posture = **review-before-send everywhere** (nothing ever auto-sends); Google SSO
login UI = **flag-gated hide, default off**. ADR-0052 records the narrow amendment to
ADR-0013 (the playground origin stays static; the receiver is a separate origin; nothing
automatic — the "no telemetry" claims stay true).

**Acceptance criteria** (each becomes at least one test):
1. **General feedback**: from the header entry point a user can pick a category
   (feedback / feature request / bug), type a comment, optionally add email, see the exact
   payload, and send; the bytes on the wire equal the previewed payload (mock-fetch byte
   compare).
2. **Inline error reporting**: the build-failure surface (`ChatLog`), the wizard
   connect-error, RunView's install/export errors, and the userdb-load-failed screen each
   render a quiet "report this" affordance that opens the sheet pre-filled with that
   surface's diagnostics context; **nothing sends without an explicit Send tap** (rendering
   an error surface produces zero fetches to the feedback origin).
3. **Scrub before preview AND wire**: a credential-shaped string planted in error text or
   comment is scrubbed in the previewed payload and in the transmitted bytes (negative
   test); diagnostics and comment fields are size-capped client-side.
4. **App rating**: 👍/👎 from the run header opens an in-place popover showing exactly what
   will be sent (app name, starter id+version if a starter, rating, optional one-liner);
   a bare tap never transmits.
5. **Email optional**: default empty; when empty the wire payload has no email key.
6. **Worker**: validates schema (zod), enforces caps + per-IP rate limit + honeypot,
   inserts a row in D1, answers CORS for the playground origin only, rejects
   wrong-method/oversize/junk with correct statuses.
7. **SSO hidden by default**: with `hubAuth` off (web default), no sign-in button renders
   in `IdentityChip` or Settings `AccountCard` **even when `/auth/me` answers 401**, and
   the auth probe is not fired; with the flag on, prior behavior byte-identical. Desktop:
   flag hard-off.
8. **No sandbox impact**: no new frame types; runner/CSP guard suites and
   `check-sandbox-guard` stay green (structural proof that app iframes gained nothing).
9. **Desktop path**: feedback send routes through the platform `fetchImpl` seam so desktop
   uses native fetch (CORS-free); desktop vitest suite green.

**Out of scope**: deploying the worker + DNS + CORS-origin verification (explicit owner
ask, like the website deploy); Turnstile (deferred per ADR-0052 §6); a triage
dashboard (wrangler/D1 console queries suffice at this volume); automatic crash capture
of any kind; GitHub Discussions mirroring; the deploy-time content pass adding the
"feedback exists" sentence beside the three "no telemetry" claim sites; touching
server-side OIDC code; the wizard's queued error-surfacing items (next-steps 2026-08-15).

## Plan

**Key scouting facts (verified 2026-08-22):** No feedback/telemetry/analytics code exists
anywhere. Sign-in is ALREADY invisible on the static deploy by construction (`/auth/me`
probe → `unavailable` → `IdentityChip` returns null) — the flag makes it structural
instead of probe-dependent. Desktop's `http:default` capability already allows
`https://**`, so no Tauri capability/IPC change is needed (no new Rust command → no new
IPC gate rows owed). Host page has no CSP, so no header work. `releaseChannel.ts` is the
single-homed-URL precedent to copy.

**UX doctrine (the "top 1%" bar, concretely):** restraint — no floating bubble, no badge,
no nag; the only persistent affordance is one small ghost "feedback" item in the header
overflow area + a Settings card. Context — report affordances appear ONLY where an error
is already rendering, as a quiet inline link in the existing `error-note`, never a second
banner. Honesty — the preview IS the transmitted bytes, shown in a collapsed
`<details>` ("what gets sent") that expands to the full scrubbed payload. Speed — two
interactions from affordance to sent (open → Send); category pre-selected by context.
Acknowledgment — inline "thanks — sent ✓" state that fades; no modal thank-you. Fully
keyboard-accessible, theme-aware, matches existing Sheet/Button idiom.

### Files to touch, in order (tests FIRST per TDD.md within each step)

**Step 1 — Worker (`apps/feedback`, new):**
- `apps/feedback/package.json`, `tsconfig.json`, `tsconfig.test.json`, `wrangler.jsonc`
  (D1 binding; NOT deployed this task), `migrations/0001_feedback.sql` (one `feedback`
  table: id, received_at, kind, rating, app_name, starter_id, starter_version, platform,
  client_version, comment, diagnostics, email, ip_hash).
- `src/schema.ts` — zod payload schema, caps (comment 2 KB, diagnostics 8 KB), kinds
  `error|feedback|feature|rating`.
- `src/index.ts` — fetch handler: POST `/v1/feedback` only; CORS allowlist; honeypot
  field (`website`) → 204 drop; per-IP rate limit (fixed window in D1 or KV); insert.
  Handler written DI-style (env + storage injected) so vitest covers it without miniflare.
- `src/__tests__/worker.test.ts` — AC6 rows.
- Root wiring: pnpm workspace already globs `apps/*`; verify turbo picks up `test`.

**Step 2 — Playground core (`apps/playground/src/feedback/`):**
- `feedbackChannel.ts` — `FEEDBACK_ENDPOINT_URL` single-homed (releaseChannel.ts
  pattern) + `sendFeedback(payload, fetchImpl)`.
- `payload.ts` — `buildFeedbackPayload(...)`: shape, caps, scrub via the
  `packages/auth` scrubber (reuse its exported helper; if the export surface doesn't fit
  prose-scrubbing, extract a thin wrapper HERE, not a change to `packages/auth`), client
  version + platform stamps. Tests: AC1 byte-equality, AC3 scrub/caps, AC5 email-absence.
- `apps/playground/src/state/feedback.ts` — sheet open/context/submission state store
  (existing store idiom).

**Step 3 — UI:**
- `FeedbackSheet.tsx` — category, comment, email, `<details>` payload preview, Send /
  sending / sent / failed states (send failure renders inline retry copy — never a throw).
- `ReportErrorLink.tsx` — the inline affordance (quiet link, `role` preserved).
- `RatingControl.tsx` — 👍/👎 popover with in-place review (AC4).
- Mounts: `App.tsx` (sheet at app level beside `ConnectionWizardNote`; header entry),
  `SettingsView.tsx` (feedback card), `ChatLog.tsx:92` (build failure),
  `RunView.tsx` (install/export error notes), `ConnectionWizardSheet.tsx:1383`
  (connect-error), `App.tsx:92` (userdb-load-failed), `RunHeaderActions.tsx` (rating).
  Tests: AC2 per-surface render + zero-fetch, AC4.

**Step 4 — SSO flag-gate:**
- `platform/platform.ts` — add `capabilities.hubAuth: boolean`; web default
  `import.meta.env.VITE_SNUG_HUB_AUTH === '1'`; `apps/desktop/src/platform-desktop.ts`
  → `false`.
- `state/auth.ts` — `refreshAuth()` short-circuits to `unavailable` when off (probe not
  fired); `App.tsx` boot call unchanged. `IdentityChip`/`AccountCard` need no edits
  (they already key on `unavailable`) — tests pin AC7 both flag states.
- `docs/runbooks/enable-google-sso.md` — add the build-flag step (and, riding this edit,
  the owed no-authz caveat from next-steps item 1 — one paragraph, in scope because we're
  already in the file).

**Step 5 — Docs (Gate 6 rider, in-branch):** finalize ADR-0052 status → accepted;
architecture.md (one paragraph: feedback channel + hubAuth capability), code-map rows,
glossary entry, `internal/07-roadmap.md` B6 note, next-steps entry for the deploy ask,
spec-changelog NOT touched (no protocol change).

### Cross-package impact & test plan
No `packages/*` source changes → run: `apps/feedback` (new), `pnpm --filter playground
test` (vitest + the sandbox-guard/e2e-affecting suites), `pnpm --filter desktop test`
(consumes playground source), root `pnpm run gate:local` (workspace+smoke) before review.
Website sync gate: untouched sources → no `/sync-website` owed (README/whitepaper/spec
not edited).

### Spec-sync impact
None. No `packages/protocol` bytes change. Negative proof rides AC8.

### Deployment (explicitly NOT this task)
`wrangler deploy` + D1 create + DNS for `feedback.snugprotocol.org` + CORS verification
against `playground.snugprotocol.org` — each an explicit owner ask, journaled when it
happens (PROCESS.md release rules; website precedent).

## Decisions & surprises

- **ADR-0052 drafted** (receiver choice, nothing-automatic doctrine, review-before-send,
  SSO flag-gate, B6 supersession). ADR-0013's "default answer is no" was surfaced to the
  owner and deliberately overridden — the amendment is narrow: the playground origin
  stays static; the receiver is a separate origin; zero automatic egress.
- Scout: sign-in already hidden on static deploys by construction; the flag converts a
  probe-dependent absence into a structural one.
- Desktop needs NO capability/IPC work — `https://**` already in `http:default` scope.
- Turnstile deferred (would load third-party script into a page that loads nothing).

## Session journal (append-only, newest last)

### 2026-08-22 — claude — session
- Done: Gate 1 (task file, owner interview: CF Worker+D1 · all four surfaces · review-before-send · flag-gated SSO hide) + Gate 2 (scout of login/error/deploy surfaces; ADR-0052 drafted; full plan written; branch `feat/TASK-20260822-feedback-loop` created).
- State: **STOPPED at the Gate-2 approval gate — no implementation code written.**
- Next step: owner approves/edits plan → Gate 3 (failing tests per AC, worker first).
- Open questions: (1) worker app name `apps/feedback` ok? (2) ADR-0052 wording pass; (3) whether the SSO-runbook no-authz caveat rider is welcome in this branch or should stay a separate task.
