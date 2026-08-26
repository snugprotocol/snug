# TASK-20260826-demo-brain-clarity: Make demo-brain mode unmistakable and invite BYOK/local honestly

- **Status**: in-progress (plan approved by owner 2026-08-26)
- **Owner**: Jeetu
- **Risk tier**: Medium (Playground logic — full TDD + AI review + human review; no protocol/runner/auth touch)
- **Branch**: `feat/TASK-20260826-demo-brain-clarity`
- **Packages touched**: `apps/playground` only (web + desktop shell share this SPA)
- **Spec impact**: none (PersistedMeta is playground-owned opaque JSON — no schema bump, no spec-sync)
- **Related**: TASK-20260821 (provider resolution AC9), TASK-20260812 P3 (DesktopWelcome), ADR-0015 (webllm brain override), ADR-0027, ADR-0059 (this task)

## Spec (what & why)

First-time visitors to the Playground (web) and the macOS desktop app land on the demo
brain (`byok` mode + `mock` provider) by default. The default is right — nobody should
paste an API key to try Snug — but today NOTHING ambient says the responses are mocked:
`BuilderModelSelect` hides itself when `provider === 'mock'`, and the only mentions of
"demo brain" live in Settings and the webllm fallback banner. Worse, `createTurnAdapter`
falls through to the mock adapter when a keyed provider has no key, so a user can
believe they configured a real provider and still get scripted output. A skeptical
technical first-time audience will either assume Snug calls a hosted LLM (false — bad
for trust) or judge the product on canned output without knowing it (bad for the demo).
Both are trust-killers.

Goal: at every moment the demo brain (or any brain) is what's thinking, the UI says so —
ambiently (a live status chip), per-output (a provenance tag on scripted turns), and
once at first contact (a dismissible callout) — and switching to BYOK/local is one
gesture away with honestly-scoped copy (keys are stored in the user's file on their
device and sent browser-direct to the chosen provider, **never to Snug's servers** — we
do not claim "never leaves your device", because the key does travel to the provider).

**Interview decisions (owner, 2026-08-26):**
1. Ambient indicator = **live brain chip** in the shell header — always names what's
   thinking; click opens a switch popover. Stays useful after switching (never nags).
2. **Per-turn provenance tag** on every demo-brain assistant turn.
3. Web first-visit = **light one-time inline callout** in the builder (not a modal).
4. **UI/UX only, Medium tier.** No changes to mode defaults, transports' routing,
   adapters package, DesktopWelcome flow, or server.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — one derivation, no drift.** A pure `adapterKindFor(config)` in
   `agent/adapter.ts` returns `'webllm' | 'local' | 'anthropic' | 'openai' | 'demo'`,
   and `createTurnAdapter` routes THROUGH it. Test: for the full config matrix
   (mode × provider × key-present/absent), the adapter actually constructed matches
   `adapterKindFor` — including the keyless-byok → demo fall-through.
2. **AC2 — the live resolution.** `resolveActiveBrain()` (new `state/activeBrain.ts`)
   combines the webllm brain override, mode, resolved provider, and synchronous key
   presence into `{kind, label}`: webllm flag wins (per `resolveTurnMode`); `mock` or
   keyless-keyed-provider ⇒ demo; local ⇒ local; subscription ⇒ subscription. Unit
   tests at this decision line (lesson 2026-08-05: test where the decision is made).
3. **AC3 — the chip never lies and never disappears.** `BrainChip` renders in the shell
   header on every route, labeled from AC2's store-reactive hook. Demo state reads
   "demo brain" with a visually distinct (attention-tinted) dot; adding a key flips the
   chip without a reload (existing `setByokKey` → `refreshResolvedProvider` path).
   Accessible name pinned (aria-label — lesson 2026-08-18: on-screen text is an API).
4. **AC4 — one-gesture honest switch.** Clicking the chip opens a popover (IdentityChip
   pattern, not a Sheet): one sentence of truth for the current brain (demo copy states
   "a tiny offline script — no AI model, no server"); "use your own AI key" → routes to
   Settings; "use a local model" → `setMode('local')` directly when the Ollama probe
   found models, otherwise routes to Settings local section. Esc/click-away close with
   focus restore (IdentityChip contract). The load-bearing honesty sentence — key goes
   in your file, sent only to the provider you pick, never to Snug — is byte-pinned.
5. **AC5 — per-turn provenance, stamped at the decision, persisted as provenance.**
   `createDirectBuilder.send` reports the resolved brain kind per turn (new optional
   handler seat); `useBuilderChat` records it on the assistant message and persists
   `brainKind` in `PersistedMeta`; ChatLog renders a "scripted demo — not an AI
   response" tag on `brainKind === 'demo'` turns, including after reload (rehydration
   path — lesson 2026-08-19: derive from row provenance, never session state). A keyed
   real-provider turn carries no tag (negative test).
6. **AC6 — first-contact callout, a note not a gate.** A dismissible inline callout in
   BuilderView when the active brain is demo AND the latch is unset; dismissal persists
   to the USER FILE (`demoCalloutDismissed` — own key, firstRun.ts pattern; file is the
   identity). It never blocks the composer/chat (lesson 2026-08-20: prominence that
   blocks is a modal with extra steps); hidden entirely once a real brain is active.
7. **AC7 — assembled-product proof.** Playwright: fresh profile → chip says demo +
   callout visible; build with the demo script → the assistant turn carries the tag;
   dismiss callout → reload → still dismissed; 375px: no horizontal scroll with the
   chip present (standing tripwire) and the chip keeps an accessible name in its
   compact form. Plus one real-browser screenshot pass before claiming done (lesson
   2026-08-20: run the product).

**Out of scope**: DesktopWelcome rework; mock-adapter/`packages/adapters` changes;
watermarking demo-built apps in the run view; subscription-mode server work; website
copy; any change to default mode/provider resolution; webllm banner behavior.

## Plan

**Order (tests first per TDD.md; each step = failing test → implement → green):**

1. **Branch** `feat/TASK-20260826-demo-brain-clarity` off `main`. Draft ADR-0059
   (`docs/decisions/0059-brain-disclosure.md`, status: proposed) — the doctrine: the
   active brain is always ambiently disclosed; scripted output is provenance-tagged at
   the turn that produced it; disclosure copy claims only what the code vouches for.
2. **AC1** — `apps/playground/src/agent/adapter.ts`: extract `adapterKindFor`;
   `createTurnAdapter` switches on it. New `__tests__` rows: full matrix equivalence
   (mutation check: skew the fall-through and watch exactly the matrix row red).
3. **AC2** — new `apps/playground/src/state/activeBrain.ts`: `resolveActiveBrain()` +
   `useActiveBrain()` over `webllmFlagStore/webgpuStore` (via `resolveTurnMode`),
   `modeStore`, `providerStore`, `byokKeyPresenceStore`, `ollamaStore`. Unit tests
   incl. the trap case: byok + anthropic chosen + no anthropic key ⇒ demo.
4. **AC3/AC4** — new `apps/playground/src/views/BrainChip.tsx`: chip + popover
   (IdentityChip open/close/focus contract). Mount in `App.tsx` header before
   `FeedbackMenu`. CSS in `theme/app.css` co-located base + responsive rules (lesson
   2026-08-23 cascade order): ≤760px the chip compacts (dot + short label, full
   aria-label). Rendered tests: label per brain state; live flip on key add; menu
   actions (ollama path spies `setMode`; settings path navigates); pinned honesty copy.
5. **AC5** — `agent/builder.ts`: compute `adapterKindFor(...)` beside the existing
   `createTurnAdapter` call and report via new optional `handlers.onBrain?(kind)`
   (decision altitude — the same config object, so it cannot skew). `useBuilderChat`:
   capture per turn, write `brainKind` into `PersistedMeta` at finalize, rehydrate in
   the meta→message mapping. `ChatLog.tsx`: tag render (`data-testid="demo-turn-tag"`).
   Tests: stamp+persist+rehydrate; negative (anthropic-with-key turn untagged);
   webllm/local turns untagged.
6. **AC6** — new `apps/playground/src/state/demoCallout.ts` (latch store, init in
   App.tsx boot chain after `initSettings()`) + `views/DemoBrainCallout.tsx`, mounted
   in BuilderView above the chat. Tests: show/dismiss/persist/hide-when-real-brain;
   composer remains interactable while shown.
7. **AC7** — `e2e/demo-brain-clarity.spec.ts` (chip + callout + tag + reload latch);
   extend the 375px overflow tripwire to assert the chip. Screenshot walk of web +
   desktop shell before review.
8. **Gate 5** — `pnpm test` at root (playground has no dependents, but root run per
   process), Playwright suite, AI review, then human review of diff + this file.

**Cross-package impact**: none — all changes in `apps/playground`. The `adapterKindFor`
refactor touches the file that constructs adapters but changes no routing behavior
(AC1's matrix is the proof). No C1/C2 surface: no credential value is read or moved;
key PRESENCE (already a store) is the only new consumer.

**Spec-sync**: not touched (`packages/protocol` untouched).

**Copy doctrine (for review):** no superlatives, no "never leaves your device". The
pinned sentence: *"your key is saved in your Snug file on this device and sent only to
the AI provider you choose — never to Snug's servers."* Demo copy names the mechanism:
*"a tiny offline script fakes the AI so you can try the flow — no model, no server."*

## Decisions & surprises

- **375px overflow, caught by the tripwire as planned:** "demo brain" in the header
  overflowed by exactly 7px at 375px (all five mobile e2e reds). Fix: below the 760px
  nav-compaction breakpoint the chip swaps to a short "demo" span (full state stays in
  the aria-label); mobile spec pins the swap via innerText + visibility.
- The demo-callout "survives reload" claim is COVERED IN TWO HALVES: unit (re-init
  after dismiss in demoCallout.test.tsx) + e2e SPA-navigation persistence — an
  ephemeral Playwright context's OPFS does not survive hard reloads (lessons
  2026-08-03), so a reload-based e2e would test the harness, not the latch.
- `createTurnAdapter` now THROWS on a keyed kind with no key (unreachable by
  construction — adapterKindFor guarantees the key): drift between the derivation and
  the dispatch becomes loud instead of silently re-routing a turn.
- brainKind is persisted for EVERY direct-mode turn (not just demo): provenance is
  cheap in opaque meta JSON, and a future "built with claude" surface reads it free.
- **connection-wizard journey 4 flake is PRE-EXISTING, measured as a rate** (lessons
  2026-08-22): `popup.waitForURL(/oauth/callback)` races the popup's self-close —
  "Target page has been closed" AFTER the log shows the callback URL was reached.
  Branch 2-in-6, main 2-in-6 — identical, so not this task's regression and per the
  2026-08-19 amendment not this task's fix either. Queued for next-steps.
- The full-suite e2e ✘ rows in starters-connect are the KNOWN test.fail() quarantine
  (2026-08-20) — expected-fail, counted as passing; only journey 4 was a real red.
- **C4 scrub (AI review, conventions angle):** earlier drafts of this file and
  ADR-0059 named the launch venue and used launch-positioning phrasing in a public
  repo. Reworded to audience-neutral language in the working tree; the branch's
  earlier commits retain the old wording in history, accepted under the ADR-0057
  doctrine (history is the archive; the working tree keeps what is currently true).
- ADR-0059 flipped proposed → accepted (its stated condition — owner plan approval —
  was met in-session) and indexed in decisions/README.md alongside the missing 0058
  row (pre-existing index drift, fixed in the same touch per ADR-0027).

### AI review (Gate 5) — 8/8 finder angles captured; consolidation never landed; triage below

The `/code-review high` fork's 8 finder angles all reported (raw outputs were only in
the session; the load-bearing content is HERE). The orchestrator's verify pass did not
complete before session close, but the items below were **independently re-verified by
the author against the code** — treat them as confirmed unless marked otherwise.

**MUST FIX before PR (the fix pass — next session's first move):**
1. **Fresh-thread pick divergence (worst finding, confirmed at `useBuilderChat.ts:427`):**
   explicit provider choice (e.g. anthropic) with its key DELETED + a fresh-thread
   builder pick for the OTHER keyed provider ⇒ `providerStore`='anthropic', presence
   false ⇒ chip/callout say "demo brain — no AI service is called" while the send
   routes `freshPick.provider`='openai' WITH a real key. Disclosure lies in the
   dangerous direction. Fix: `resolveActiveBrain` layers `builderPickStore` with the
   SAME guard the send path uses (`mode==='byok' && provider!=='mock' && pick`).
2. **Ollama shortcut inert under `?webllm=1` (confirmed):** brain override active ⇒
   menu's `setMode('local')` visibly does nothing yet persists a mode write. Fix:
   offer the shortcut only when `currentBrain().kind === 'settings'`.
3. **False comment in `activeBrain.ts` scope note** ("the global route is the only
   route that can land on the demo brain…") — falsified by the per-app-pin case
   (`builder.ts:262`: pinned provider + deleted key ⇒ demo turns under a chip naming
   a real provider; 4 angles confirmed independently). Fix the comment now; the
   full per-app chip context is QUEUED (below), the per-turn tag + ModelSelect's
   "(key missing)" are the interim disclosure.

**WORTH FIXING in the same pass (drift-proofing, all cheap, all verified):**
4. `activeBrain.ts` re-inlines `currentBrain()`/`useBrain()` (webllm.ts:84/88) —
   call them instead; also pass useStore values into the resolver (house pattern:
   `useTurnMode`) or derive a single store, so the subscribe-list and read-list
   cannot drift.
5. `ADAPTER_KINDS` in useBuilderChat hand-duplicates the `AdapterKind` union —
   single-home the list in adapter.ts (`const ADAPTER_KINDS = [...] as const;
   type AdapterKind = typeof ADAPTER_KINDS[number]`).
6. Sentinel `key: 'present'` → change `adapterKindFor` input to carry `hasKey`
   (or `key?: string` stays for the constructor while the derivation takes a
   discriminated input); deletes the sentinel and its guard test.
7. **BrainChip is the THIRD copy of the popover-dismiss effect** — FeedbackMenu.tsx:5
   explicitly queues `useDismissableMenu` "for whichever popover arrives third."
   That's this one: extract the hook, consume from BrainChip + IdentityChip +
   FeedbackMenu.
8. Boot chain: `initDemoCallout` sits last in an uncaught `.then` chain (a throw in
   `initProtectOffer` silently skips the latch) — at minimum `Promise.all` the two
   independent latch inits.

**QUEUED (recorded in next-steps, not this task):** per-app pin context for the chip
(header needs route/thread awareness — design work); chip disclosure of the F15
`needsEndpointConfirm` state (chip names a provider while every direct turn refuses
CONSENT_REQUIRED); demo-callout latch re-init on file replacement (recoverFresh /
import / sync pull — gap shared with the pre-existing `initProtectOffer` latch, fix
both together); `brainKind` stamp for subscription turns (absence currently means
pre-field OR hub row); test-harness consolidation (three new files copy the
createRoot/act scaffolding `wizardSheetHarness.tsx` exists to end; `settleUntil`
forked at 400×5ms); `.demo-brain-callout` as a `.connection-note` modifier; aria
prefix composed once in BrainChip instead of six data rows; efficiency micro-items
(menu-only ollama subscription, double `adapterKindFor` per send).

**Checked-and-clean (finder consensus):** C1/C2 untouched (presence only, no
credential values move); refactors behavior-identical for all `createTurnAdapter`
callers; `resolveActiveBrain` webllm arm matches the send path's demo-fallback arm;
`onBrain` ordering (after F15 refusal, before the wire) matches the tests' claims;
meta plumbing, CSS tokens, e2e selector contract all verified.

- Confirmed gap (2026-08-26 code read): `BuilderModelSelect` returns `null` when
  `provider === 'mock'`; only Settings + the webllm fallback banner ever say "demo
  brain". No ambient surface anywhere in the builder/hub/run shell.
- **Surprise:** `createTurnAdapter` silently hands back the mock adapter for a KEYED
  provider with no key (byok + anthropic, key deleted ⇒ demo brain, no signal). The
  chip must consume the adapter's own fall-through (hence AC1) or it would lie in
  exactly this state. `inferrerAdapter.ts:68` already guards this case for inference.
- ADR-0059 drafted (proposed) as part of this plan.

## Session journal (append-only, newest last)

### 2026-08-26 — Claude (Fable 5) — session
- Done: task file; code recon (mode/webllm/adapter/builder/useBuilderChat/ChatLog/App/
  BuilderView/firstRun/StatusLine/BuilderModelSelect); Gate-1 interview (4 decisions
  recorded above); Gate-2 plan written; lessons.md + code-map.md (relevant rows) read.
- State: plan awaiting owner approval. Branch + ADR draft next (no implementation).
- Next step: on approval — step 2 (AC1 failing test first).
- Open questions: none blocking; chip placement compaction at ≤760px to be verified
  against the 375px tripwire during implementation.

### 2026-08-26 (later) — Claude (Fable 5) — session (implementation, Gates 3–5)
- Done: all ACs test-first and green. AC1 adapterKindFor (matrix, mutation-verified,
  presence-only pin) · AC2 resolveActiveBrain/useActiveBrain · AC3/AC4 BrainChip +
  popover in the shell header (pinned honest copy; ollama one-gesture switch) ·
  AC5 onBrain stamp → PersistedMeta.brainKind → ChatLog demo tag (persist + rehydrate
  proven) · AC6 demoCallout latch + DemoBrainCallout in BuilderView · AC7
  demo-brain-clarity.spec.ts + mobile chip row + 375px compaction fix (short "demo"
  span under 760px after the tripwire caught a 7px overflow).
- Verification: playground gate (tsc + 1676/1676, exit 0, pipefail) ×2 · root
  `pnpm test` 25/25 exit 0 · full e2e all projects: only red = connection-wizard
  journey 4, measured 2-in-6 on branch AND main (pre-existing, journaled, queued) ·
  real-browser walk with 5 screenshots (desktop first-visit, chip menu, demo build
  with tag, settled tag, 375px) — all rendered as designed. Desktop shell shares this
  SPA byte-for-byte for these surfaces; no tauri-specific seam touched.
- State: AI review (code-review high) in flight; findings to be applied before PR.
- Next step: apply review findings if any → /close-session (Gate 6) → PR.
- Open questions: none.

### 2026-08-26 (close) — Claude (Fable 5) — session close (Gate 6)
- Done: doc-side review findings applied (ADR index rows 0058+0059; ADR-0059
  proposed→accepted; C4 scrub of launch-venue phrasing — old wording remains in
  branch history per the ADR-0057 doctrine, working tree is clean). All 8 review
  finder angles captured and TRIAGED into this file (section above) — the fork's
  consolidation pass did not land before close and dies with the session; the triage
  section is the durable record. Lessons + code-map + next-steps updated in-branch.
- State: implementation of AC1–AC7 complete and verified (playground gate 1676/1676
  ×2 exit 0 · root 25/25 exit 0 · full e2e green except the pre-existing journey-4
  flake, 2-in-6 on branch AND main · real-browser walk at 1280px + 375px). Branch
  `feat/TASK-20260826-demo-brain-clarity`, NOT yet merged — the review fix pass is
  owed first.
- Next step: **execute the "MUST FIX before PR" list (items 1–3) + the cheap
  drift-proofing (4–8) from the triage section, re-run the playground gate + the
  three disclosure suites + mobile e2e, then PR.** Item 1 (fresh-pick divergence) is
  the blocker — the chip can currently claim "demo brain" while a fresh-thread pick
  sends to a keyed provider.
- Open questions: none for the fix pass; the QUEUED block's design items (per-app
  chip context, F15 disclosure) are next-steps entries, owner-prioritized.
