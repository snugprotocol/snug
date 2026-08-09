# HANDOFF #6 — Alpha umbrella / connection-reachability — resume point

**Written:** 2026-08-08, at the 60%-context rule. **Purpose:** a fresh session picks up with zero loss. Read this, then `docs/tasks/active/TASK-20260807-connection-reachability.md` (**plan v2 is the plan of record**), then act on "IMMEDIATE NEXT ACTION". **Supersedes `HANDOFF-alpha-umbrella-5.md`** — its "everything is HELD, await the owner" state is spent: the owner green-lit this task and resolved its one fork.

## One-paragraph situation

The owner green-lit **connection-reachability** (the High-tier child born when AL-09 hit the "a chat-less app can never become a connected app" gap) and ratified its trust posture. **Gate 2 is COMPLETE and Gate 3 is IN PROGRESS.** Plan v1 → 3-lens fresh-context design review (**REVISE: 15 confirmed, 8 MAJOR + 7 MINOR, 2 refuted, no BLOCKER**) → plan v2 folding all 15 → an **independent fidelity verification** that caught one of my own folds resting on a false claim → an owner fork, which the owner resolved as **option (i): extend the validate rule narrowly**. Both halves of that widening are now **landed, test-first, mutation-evidenced, and green**. What remains is the walking skeleton itself — **no feature production code exists yet**, by design.

## ⚠️ Scope discipline — unchanged

**AL-10, AL-11, AL-12, AL-15 remain HELD** pending the owner's manual tests. **AL-09 stays PARKED** and resumes after this task lands (or earlier if the owner elects its option B). This task is the ONLY thing running. Do not start anything else.

## Git state (all safe on origin — nothing lives only in chat)

- `origin/main` @ **`85ecd3b`** (docs-only AL-09 park landing, PR #28). Untouched this session.
- **`feat/TASK-20260807-connection-reachability` — THIS task's branch, PUSHED, 7 commits, cut off current `main`.** Local == origin. The diff vs main is exactly **two files** (the task file + `examples/validate.test.mjs`), every commit explained by the journal — no lost context.
- **`feat/TASK-20260807-starters-auth-spectrum` — AL-09's parked branch, UNTOUCHED at `7b45f90`, local == origin, still based on the older `d6ced02`.** Verified this session: all four banked deliverables present (AC10 registry walkthrough, AC12 `bearer_token` proof, the validate-rule repair, `STARTER_LOOKS`/Hue rows) and its **deliberate red state intact** (two lists gate five unwritten starter folders). **Do NOT check it out unless resuming AL-09; it needs a rebase onto current main when that happens.**
- `backup-pre-scrub-20260731` — NEVER push/delete casually (LAUNCH_OPS item-0).

## Test status (verified at handoff time)

**Full root `pnpm test` — 19/19 packages green.** `examples` 75 tests (was 73). No other suite moved, because nothing else was touched.

## What landed this session

| Commit | What |
|---|---|
| `ff00478` | Gate-2 **plan v1** (direction C) + ownership + posture journal |
| `114eb99` | **Security review verdict** (REVISE, 15 confirmed) + **plan v2** fold |
| `4c3d730` | **Independent fidelity verification** (10/15 folded; caught a false claim) + the owner fork |
| `465586a` | Owner decision **(i)** recorded; **V2-4 rewritten**; **V2-7** folds the verifier's corrections |
| `bc97848` | **No-network-APIs rule repaired** (mutation-evidenced) |
| `b6d27a2` | **CDN allowlist scoped to declared hosts** (mutation-evidenced) |
| `5dfdefb` | Journal |

## The two decisions a fresh session must not re-litigate

1. **POSTURE (owner, 2026-08-08): an app may NEVER propose a connection at runtime.** Proposals come only from the user (Settings), the reviewed builder LLM (directive), or **the install act's declaration** — which gets the SAME strong field-by-field review as inference. **Direction C ratified**; A/B/D rejected with reasons in the task journal.
2. **THE FORK (owner, 2026-08-08): option (i) — extend the validate rule narrowly.** Landed. Do not revisit; the alternatives (call-less demo / exemption / defer) are closed.

## Two corrections this session made to its OWN earlier claims — carry them, don't re-derive

- **"The old no-network rule missed `window.fetch(` entirely" was FALSE.** `\b` matches at the dot, so it caught it incidentally. **Consequence that matters:** the new bare-call regex `(?<![.\w])` deliberately no longer matches `window.fetch(`, so **assertion 2 (`QUALIFIED_NETWORK_API`) is load-bearing, not a bonus** — shipping assertion 1 alone WOULD open a hole. The two are a pair; the code comment and a 12-case test now enforce it.
- **Plan v1's V2-4 claim that a demo could put its call "inside the hooks block region" was FALSE** (caught by the fidelity verifier, re-verified at source). That region is ABOVE the app-authored banner and byte-locked to `packages/sdk/embedded/snug-hooks.js`. This is why option (i) existed at all.

## IMMEDIATE NEXT ACTION — build the walking skeleton, in this order

Plan v2 §V2-1..V2-7 has the full mechanism with anchors. The order matters (skeleton before breadth — the AL-09 lesson, which has now paid twice):

1. **`examples/connection-demo/connection.json`** + **async resolver** in `apps/playground/src/starter/starterApps.ts`: `import.meta.glob('../../../../examples/*/connection.json', { query: '?raw', import: 'default' })` (raw ⇒ a malformed manifest can never break the build), `JSON.parse` in try/catch, then `llmProposalSchema.safeParse` ⇒ invalid returns `null` + one `console.warn`. **Install-act proof requires BOTH** `install_source` resolving to a bundled manifest **AND** the stored HTML matching the bundled starter HTML — compared **NORMALIZED** (`validate.test.mjs:55–60` precedent) against **pinned factory version 1** via `db.getAppHtml(appId, 1)` (`userdb.ts:1275–1285`), never `current_version`. Mismatch must **log a reason and surface a Settings state**, never withdraw silently (that reproduces the very bug this task kills). Tests T2, T2b–T2f.
2. **Wizard** (`apps/playground/src/state/wizard.ts`): add `declaration?: LlmProposal` to `WizardSession` (playground-local — **`packages/protocol` is NOT touched**, so no SPEC_SYNC, no spec-changelog). `resolveDeclaredIntent` never consults the registry. **`openWizardForNetError` becomes `async`** and its call site is reworked in the SAME commit: `void openWizardForNetError(...).then((opened) => { if (opened) setNetAuthError(null) })` (`RunView.tsx:499–503`) — a naive async conversion makes the Promise always truthy and dismisses the CTA on a parked refusal. **`wizardStore.test.ts:210/225` assert a sync boolean and move with it.** Tests T4, T4b.
3. **Sheet** (`apps/playground/src/connections/AuthWizardSheet.tsx`): `specConfirm` gains `session.declaration !== undefined` (`:187`) so **no mid-session action can reach the light path** — the "infer from docs" button overwrites `provenance`, which is why provenance alone was not enough. **Also fix `draftFromProposal`** to fall back to `session.declaration`'s hosts when the inferrer returns none (`:189–193` re-seeds the draft and would otherwise wipe declared hosts). Tests T3, T3b, T3c, T5.
4. **`examples/connection-demo/app.html`** (declares `api.example.com`, calls the governed seam) + **T8 e2e**: install → the app's own call → `NET_NOT_APPROVED` → **CTA banner** → click → **PREFILLED strong review** → approve → frozen row → revoke → declared-not-connected. T8b is the cheaper Settings path.

**If the skeleton stalls on a structural surprise, STOP and re-plan before breadth.**

## Then breadth (only after the skeleton is green)

Settings "declared — not connected" surface + empty-state copy · install disclosure on `RunView.tsx:560–570` · the post-revoke rule (**V2-5 is UX friction, NOT a security boundary — it dies on page reload; say so, don't claim otherwise**) · the KB amendment (**larger than one sentence**: the emission rules assume a directive-closing reply a chat-less starter cannot produce; generated snapshot + KB suite move with it) · shelf folds (`connection-demo` into the starter arrays, extend the look-coverage loop, `STARTER_LOOKS` row, code-map counts) · `examples`→protocol workspace dep **with a named turbo build-ordering guarantee** or fresh clones go red.

## Known collision to record before AL-09 resumes

Adding a ninth example folder makes AL-09's pinned literals stale (its `APPS` 8→13 and 13 shelf ids become 9→14 and 14 ids). **Write this into AL-09's task file when the shelf fold lands**, so its rebase is not a surprise.

## Standing process (unchanged)

Branch off fresh main → TDD, never weaken a failing test → full root suites + Playwright + live agent-browser sweep (FRESH servers; kill stale first) + fresh-context adversarial review before merge → fold → merge serialized → branch deleted → task file to `done/`. Mutation-check every guard; commit before mutating. C4/C5: codenames OProject/IProject only; key in `internal/.env.local`. **Session ops:** umbrella + non-trivial children on **Fable, extra-high thinking**; mechanical child work may run on **Opus 5**; dynamic **workflows** for fan-out reviews; at **>60% context** → HANDOFF, stop, fresh session + `/pickup`. Never compact mid-session.

**Workflow gotchas (carried + one reinforced):** the 0-lens hard-fail guard stays in every review workflow; `run_in_background` is NOT a Workflow parameter; `.filter(Boolean)` applies to VERIFY stages too, not just attack stages; read `journal.jsonl` before assuming a crashed workflow lost findings. **Reinforced this session: the workflow result arrives truncated in the notification — parse the JSON from the output file (`json.load(...)['result']`), never diagnose from the truncated text.**

## Lessons this session (fold into `docs/lessons.md` at Gate 6)

- **Reviewing a DESIGN costs a fraction of reviewing an implementation — now five times running.** Eight MAJORs died with zero production code written.
- **NEW, and the sharpest: the fold needs its own independent verifier.** I folded 15 review findings and my own fold contained a false load-bearing claim (the hooks-block exemption). A fresh-context fidelity check caught it; I re-verified at source and it was right. **A self-authored fold is not evidence that the findings were addressed.**
- **NEW: a guard that only ever sees compliant inputs proves nothing.** The validate suite was green on eight compliant apps while its rule both flagged the governed seam and would have opened a hole under the obvious "simplification". The fix was a rule-behavior test with the discriminating cases in one table — and mutation-checking the pair, not just each pattern.
