# TASK-20260906-tool-free-kb-inlining: the tool-free builder must CARRY the authoring rules, not cite a tool it cannot call

- **Status**: in-review — **plan approved 2026-09-06; Gates 3–4 DONE (AC1–AC6 green: knowledge 220, playground 1899, host 165 + e2e 15, root `pnpm test` exit 0); Gate 5 AI diff review running; OWED: the owner's re-walk (AC7) on the SAME artifact, then Gate 6 + PR (stacked on T4)**
- **Owner**: Jeetu (via Claude Code)
- **Risk tier**: **Medium** — `packages/knowledge` is widely depended on and this changes what every tool-free brain (host AND webllm) is told; no protocol schema, no sandbox/CSP, no auth (so no auto-escalation to High). Escalate to High if the interview moves the selection into `packages/protocol`.
- **Branch**: `fix/TASK-20260906-tool-free-kb-inlining` — off the T4 tip `4d3b8ab` (`feat/TASK-20260905-binding-a-artifacts`), NOT `main`: the host brains, the budget ruler and the artifact e2e live only there (interview finding 2). PR stacks on T4 or lands after it.
- **Packages touched**: `packages/knowledge` (the assembly), `apps/playground/src/agent/builder.ts` (the tool-free arm), `apps/host` (tests over the built page); possibly `apps/playground/src/agent/promptBudget.ts`
- **Spec impact**: none (no `packages/protocol` schema change; the app-authoring contract itself is unchanged — this is about DELIVERING it)
- **Related**: [TASK-20260905-binding-a-artifacts](TASK-20260905-binding-a-artifacts.md) (T4 — found by its AC13 hosted walk; the journal entry of 2026-09-06 has the evidence), [TASK-20260904-skill-only-snug](TASK-20260904-skill-only-snug.md) (the parent program), ADR-0065 §2 (the host brains), ADR-0018 D3 (the system-slot authority downgrade), `docs/lessons.md`

## Spec (what & why)

The hosted walk of T4 (2026-09-06, on a real Claude artifact) proved the kit boots and the brain is wired — and then found the BUILD path broken. `buildHostSystemPrompt({ appBuilder: true, artifacts: false })` instructs the model, verbatim: *"Before writing ANY Snug app … call the `snug_app_builder` tool to retrieve the authoring knowledge base: the mandatory HTML template, the copy-exactly bridge hooks, the reply contract, and the pinned CDN table. … Never write an app from memory."* But a pinned host brain is **tool-free** (`sample` cannot call tools; `builder.ts:227`). The model is therefore told to fetch the rules, has no way to fetch them, and is forbidden to proceed without them.

Observed on the live artifact: the model reported *"I wasn't able to pull the Snug knowledge-base template in this session"* — **a literally true statement** — and built a `localStorage`-persisted, self-contained app with no bridge hooks, which then ran as a white page (no `snug:app-announce`, so the frame renders nothing). One root cause, both symptoms.

This is not host-specific. The **webllm** arm has the same tool-free constraint and the same prompt, so the same defect is latent there; `WEBLLM_BUILD_SUFFIX` replaces the *artifact-write* mechanism, never the *knowledge-base consult*. The fix belongs in the assembly, not in the host kit.

The fix cannot be "inline the KB": it is **84,237 B across 10 files** against the host's **65,536 B** cap. It must SELECT — and that selection is the decision this task exists to make and record.

| file | bytes | carries |
|---|---:|---|
| `10-overview-and-contract.md` | 5,117 | announce · app-message · timer rule · cdn |
| `20-html-template.md` | 15,626 | the mandatory template · announce · app-message · cdn |
| `30-bridge-protocol.md` | 5,609 | announce · app-message |
| `40-persistence-and-db.md` | 5,476 | the db — the layer whose absence produced `localStorage` |
| `80-cdn-compatibility.md` | 5,609 | app-message · timer rule · cdn (incl. T4's two artifact rules) |
| **essential core** | **37,437** | leaves ~28 KB for the request, the app context and history |
| `50-app-catalog.md` · `60-design-quality.md` · `70-defensive-coding.md` · `95-runtime-contract.md` | 19,136 | optional — candidates for a second tier |
| `90-auth-and-connected-apis.md` | 21,446 | **out** — connected apps do not exist under Binding A (D4) |

**Acceptance criteria** (each becomes at least one test):
1. **The tool-free assembly is SELF-SUFFICIENT.** `buildHostSystemPrompt` on a tool-free arm contains the mandatory template, the copy-exactly bridge hooks (`snug:app-announce`, `snug:app-message`), the reply contract and the pinned CDN table — asserted by CONTENT (the literal hook strings), not by byte count.
2. **It never cites a tool it cannot call.** The tool-free assembly contains no instruction to call `snug_app_builder` / `schema_apply` / `app_doc_write` / the artifact write tool (assert on `APP_BUILDER_TOOL_NAME` et al. from the knowledge package, so a rename cannot rot the test). The negative twin: the TOOLED assembly still cites them, byte-identically to today.
3. **It fits the host cap with headroom.** The tool-free assembly measured by `measurePrompt` (the same ruler the wire uses — lesson 2026-08-05) is ≤ a pinned budget that leaves a stated minimum for the request + app context + history; a layer growing past it fails the test rather than silently truncating a build turn.
4. **The webllm arm gets the same fix** (same defect, same assembly) with its existing fenced-HTML suffix preserved.
5. **An app built under the tool-free host brain announces.** The strongest available proof short of the owner's walk: a host e2e where the `sample` fake replies with the template from the assembled prompt, and the built app posts `snug:app-announce` and renders — i.e. NOT a white page.
6. **`localStorage` is refused by name.** The persistence layer's rule (apps persist through the Snug db) is present in the tool-free assembly — this is the specific sentence whose absence produced the observed app.
7. **The T4 walk resumes green**: the owner rebuilds, republishes to the SAME artifact URL, and a build produces an app that announces and runs (journaled in T4's AC13 with the artifact URL + version id).

**Out of scope**: changing the app-authoring contract itself (the KB's content is right; its DELIVERY is the bug); the `snug_app_builder` tool on tooled brains (unchanged); progressive/­retrieval-based selection driven by the request (a possible interview answer, but the DEFAULT must be static and provable); the T4 walk's remaining legs (save/export/hand-in/Safari — they belong to T4); `90-auth-and-connected-apis.md` under Binding A.

## Plan

**To be written after the Gate-1 interview and approved before any implementation code** (PROCESS.md gates; tests FIRST per TDD.md). The interview must settle at least:

1. **Which layers inline by default** — the 37,437 B essential core as measured, or a tighter set? (Bearing on AC3's headroom.)
2. **Static or request-shaped selection** — one fixed tool-free assembly, or layers chosen from the request (e.g. a connected-API ask pulling `90-…`)? A static default is the safer floor; request-shaping is an optimisation with a real failure mode (choosing wrong, silently).
3. **Where the selection LIVES** — `packages/knowledge` (one home, both tool-free callers inherit it) vs the callers. Single-homing says the knowledge package.
4. **The over-budget behaviour** — refuse the turn with a named error (consistent with T4's budget-or-refuse, AC3) or drop the optional tier first?
5. **Whether `20-html-template.md` (15,626 B — 42% of the core) can be trimmed** for the tool-free path without losing the copy-exactly guarantee, or whether copy-exactly means it rides whole.

**Recommended answers (pickup session 2026-09-06, from the code + measurements below — NOT yet approved):**

1. **The essential core as measured, all five files, nothing from the optional tier.** Every one of the five is named by an AC (10 = the loop + hard rules; 20 = template, AC1; 30 = reply contract, AC1; 40 = the db rule, AC6; 80 = the CDN table + the artifact rules, AC1). The optional tier (19,136 B) would leave ~5 KB for everything else — out by arithmetic, not taste.
2. **Static.** One fixed tool-free assembly, byte-stable per platform (ADR-0012's cached-prefix discipline still holds). Request-shaping is out of scope by the spec's own words.
3. **`packages/knowledge`.** A new `knowledge: 'tool' | 'inline' | 'none'` seat on `HostSystemPromptOptions` (default `'tool'` = today's bytes, so every existing caller and the golden snapshots stay byte-identical): `'inline'` swaps `30-app-builder-summary + 00-summary` for a NEW tool-free 30-layer (no tool citations; schema via the app's own `CREATE TABLE IF NOT EXISTS`, which `40-persistence` already teaches) followed by the five KB files through the same separator; `'none'` is a short honest layer for a brain that can carry neither. A typed accessor `getInlineKnowledgeCore()` pins the five-file list in `layers.ts`. The `WEBLLM_BUILD_SUFFIX` stays in the playground — it is the artifact-write mechanism, not knowledge.
4. **Refuse by name** — the existing `fitHostTurn` ladder (history oldest-first, html never cut, `HOST_BRAIN_PROMPT_TOO_LARGE`) already does this; no optional tier means nothing to drop first. The `promptBudget.ts` comment ("builder layers ≈ 4.7 KB") and possibly `HOST_CONTEXT_CAPS` get retuned — see the edit-turn arithmetic below.
5. **Rides whole.** The only trimmable copy-exactly section is 5 (`useConnectedFetch`, ~1 KB, out under Binding A), and a second template variant would need its own SDK sync-lock for a 1 KB gain. Not worth a fork.

### The plan (approved 2026-09-06 — the seven points above are the decisions; this is their shape in files)

**D1 — one seat, three deliveries.** `HostSystemPromptOptions.knowledge?: 'tool' | 'inline' | 'none'`, default `'tool'`, honoured on the BUILDER branch only (the runtime branch returns first, unchanged):

| `knowledge` | the 30-slot carries | who |
|---|---|---|
| `'tool'` (default) | `30-app-builder-summary` + `00-summary` — TODAY'S BYTES, every golden untouched | every tooled brain (byok/local/server) |
| `'inline'` | NEW `35-app-builder-inline` (tool-free wording) + the five core KB files, each through the layer separator | the pinned host brain (`sample` / `complete`) |
| `'none'` | NEW `36-app-builder-unaided` (honest: no knowledge base, no tools in this mode) | webllm (4,096-token window; ADR-0015 blast radius) |

Then `40-app-response-format`, then `95-platform-desktop` on desktop — unchanged order, so a web assembly stays a strict prefix of its desktop sibling. `35`/`36` are mutually exclusive with `30` exactly as `45` is: one slot, one occupant.

**D2 — the core is pinned by name in `layers.ts`.** `INLINE_KNOWLEDGE_CORE_FILES` (the five posix paths, in order) + `getInlineKnowledgeCore(): string[]` (rendered texts; a missing file throws like every other accessor). Exported, so the AC1/AC6 tests assert against the accessor's own texts rather than retyped sentences, and so the selection has ONE home (point 3).

**D3 — the callers.** `builder.ts`: `knowledge: isWebllm ? 'none' : 'inline'` on the tool-free arm, `WEBLLM_BUILD_SUFFIX` still appended (it is the artifact-write mechanism — AC4's "suffix preserved"). The tooled arm passes nothing (default `'tool'`). `promptBudget.ts`: `HOST_BUILDER_SYSTEM_MAX_BYTES = 45_056` (44 KiB) — the pinned ceiling for the tool-free builder system text, leaving ≥ 20,480 B under the 65,536 cap for the request + app context + history (AC3's "stated minimum"); the `HOST_CONTEXT_CAPS` comment retold with the new arithmetic (values unchanged — the ladder already drops history first, and html was always whole-or-refused).

**D4 — the e2e proof (AC5).** `installHostedFake` gains `reply: { templateFromPrompt: true }`: the fake `sample` finds `## Full Template` in the prompt it RECEIVED, lifts the first ```html fence after it, and answers with that document fenced — no fixture template, so a prompt that stopped carrying the template fails the test. The spec drives `#/build`, types a request, clicks build, follows the artifact card's "run it", and asserts the frame renders `<main>` (the template renders `Connecting…` until the host's ready frame arrives — so `<main>` visible ⇔ announce → host-ready completed ⇔ not a white page).

**Files.** `packages/knowledge/prompts/system/{35-app-builder-inline,36-app-builder-unaided}.md` (new) · `packages/knowledge/prompts/README.md` (tree + assembly order) · `packages/knowledge/src/{layers,assemble}.ts` + `index.ts` exports · `packages/knowledge/src/__tests__/assembly.test.ts` (+ goldens) + a new `tool-free-assembly.test.ts` · `apps/playground/src/agent/{builder,promptBudget}.ts` · `apps/playground/src/__tests__/{hostBrain,webllmWiring}.test.ts` (+ a new `toolFreeBuilderPrompt.test.ts`) · `apps/host/src/__tests__/brains.test.ts` (AC3 with the real ruler) · `apps/host/e2e/{artifact-helpers.ts,artifact.spec.ts}` · docs: ADR-0066, `lessons.md`, `code-map.md`, `next-steps.md` (webllm window item), T4's task file (AC13 pointer), the program task.

**Test plan (one per AC, tests FIRST):**
- AC1 → knowledge `tool-free-assembly.test.ts`: `'inline'` contains every text of `getInlineKnowledgeCore()`, and the literal `snug:app-announce` / `snug:app-message` (via `FRAME_TYPES`), the JSON-only reply rule heading, and the pinned CDN table heading.
- AC2 → same file: `'inline'` and `'none'` contain none of `APP_BUILDER_TOOL_NAME`, `SCHEMA_APPLY_TOOL_NAME`, `APP_DOC_WRITE_TOOL_NAME`, `ARTIFACT_EDIT_TOOL_NAME`, `RUNTIME_CONTRACT_WRITE_TOOL_NAME`, `artifact_write`, "artifact write tool"; the negative twin: `'tool'` and the option-less call are byte-identical and still cite them. Goldens for the two new combos.
- AC3 → host `brains.test.ts`: `measurePrompt(inlineSystem + suffix, [user])` ≤ `HOST_BUILDER_SYSTEM_MAX_BYTES`, and `65_536 − HOST_BUILDER_SYSTEM_MAX_BYTES ≥ 20_480`.
- AC4 → playground `toolFreeBuilderPrompt.test.ts`: the webllm arm's system carries the unaided layer + the suffix and no tool name; the host arm's system carries the template and the suffix; the tooled arm is byte-identical to `buildHostSystemPrompt({appBuilder:true, artifacts:true, platform})`.
- AC5 → host e2e as D4.
- AC6 → knowledge: `'inline'` contains the `40-persistence` text (from the accessor) and the literal `localStorage`; `'none'` names browser storage as unavailable too.
- AC7 → the owner's walk (rebuild + republish to the same URL; journaled in T4).

**Out of the plan:** retuning `HOST_CONTEXT_CAPS` values (noted as an option), `complex` tier for builder turns (its own measurement), the webllm context-window bump (next-steps).

Two findings that change the shape of the plan (journal 2026-09-06 has the numbers):

- **AC4 as written cannot hold for webllm.** The pinned model `Llama-3.2-3B-Instruct-q4f16_1-MLC` has `context_window_size: 4096` (from `prebuiltAppConfig`, no override in `engine.ts`); the core is ~37 KB ≈ 9–10K tokens. Proposal: webllm gets **AC2 only** via `knowledge: 'none'` (stops citing a tool it cannot call — the same honesty fix), and AC1/AC5/AC6 are host-only; a webllm context-window bump is its own next-steps item under ADR-0015, not this task.
- **The branch base.** The host brains, `promptBudget.ts` (the ruler for AC3) and the artifact e2e (AC5) exist ONLY on `feat/TASK-20260905-binding-a-artifacts` (T4, unmerged); the assembly and the webllm arm are on `main`. Proposal: branch off T4's tip (`4d3b8ab`) and open the PR stacked on T4, or after T4 merges. Off `main`, AC3 and AC5 have nothing to test against.

## Decisions & surprises

- **The defect was invisible to every unit test by construction.** The host tests assert which adapter a purpose routes to; none asks whether the assembled prompt is self-sufficient. **"Which adapter" and "what did it actually say" are different questions** — a prompt built for a tool-free brain needs a test that reads it as the model would. Candidate for `docs/lessons.md` on completion.
- **The model's honesty is what made this findable.** It said plainly that it could not pull the template rather than silently improvising a plausible-looking app. A quieter model would have shipped the same broken app with no explanation, and the white page would have looked like a rendering bug.
- The parallel with **webllm** means this is a pre-existing latent defect that T4 merely surfaced first — worth stating in the eventual PR so it does not read as a T4 regression.

## Session journal (append-only, newest last)

### 2026-09-06 — Jeetu (via Claude Code) — task opened from the T4 hosted walk
- Done: task file drafted from TEMPLATE with the evidence, the measured layer sizes and 7 ACs; risk tier set Medium with the escalation condition named.
- State: **Gate 1 — draft, NOT interviewed, NOT planned, NO branch.** Nothing implemented. The defect is live on the published artifact and in `main`'s webllm arm.
- Next step: the Gate-1 interview (the five questions under Plan), then the plan, then branch `fix/TASK-20260906-tool-free-kb-inlining` off `main`, then STOP for approval.
- Open questions: the five above.

### 2026-09-06 — Jeetu (via Claude Code) — /pickup: state verified, sizes re-measured with the real renderer, two plan-shaping findings
- Done: read the task + T4's walk evidence + the code (assemble.ts, layers.ts, builder.ts, promptBudget.ts, host brains/prompt.ts, the five core KB files); ran the touched suites on the T4 tip `4d3b8ab` — knowledge 202/202, host 163/163, playground 1893/1893, all green; working tree clean. Wrote recommended answers to the five interview questions under Plan (NOT approved).
- Measured with `getKnowledgeBase()` (rendered, header stripped — the bytes the model sees): the five-file core = **37,437 B** (matches the walk's table); joined through the separator 37,465; today's tool-free host assembly 4,101 (10 = 742 · 30 = 1,449 · 00-summary = 866 · 40 = 1,029); the whole KB rendered = 78,019 (still over the cap). **Proposed tool-free assembly ≈ 41,306 B → 24,230 B headroom**; after the edit-turn context caps (schema 4,000 + docs 6,000 + history 4,000) **≈ 10,230 B for the app's html + the message** — a host-side EDIT of an app above ~10 KB with saturated context will be refused by name. That is T4's budget-or-refuse doctrine working as designed, but the plan must say it out loud and retune `HOST_CONTEXT_CAPS`/its comment.
- Confirmed the KB BODIES cite no tool (only `00-summary.md` ×2 and the `30-app-builder-summary` layer do; `40-persistence` already says "apply it with the host's schema-apply tool WHEN IT IS AVAILABLE") — so inlining needs no KB edits, only a tool-free 30-layer.
- 🔴 **Finding 1 — webllm cannot take the inline core**: `Llama-3.2-3B-Instruct-q4f16_1-MLC` ships with `context_window_size: 4096` and `engine.ts` passes no override; the core alone is ~10K tokens. ADR-0015 already records "no KB-consult round trip" as accepted webllm blast radius. AC4 must narrow to the honesty half (AC2) for webllm.
- 🔴 **Finding 2 — the branch base**: this task file, the host brains, `promptBudget.ts` and the artifact e2e live only on the T4 branch; the assembly + webllm arm are on `main`. A branch off `main` cannot test AC3 or AC5. Recommend branching off T4's tip and stacking the PR.
- Lost-context check: `git diff main...HEAD` is T4's work, all explained by T4's journal; this task has no diff of its own. Nothing unexplained.
- State: **still Gate 1 — draft; interview questions now carry recommendations; NO branch, nothing implemented.** This journal edit is UNCOMMITTED on the T4 branch (no commit asked for).
- Next step: the owner answers/approves the five recommendations + the two findings → write the plan (files, test plan per AC, the retuned caps) → branch `fix/TASK-20260906-tool-free-kb-inlining` off `4d3b8ab` → STOP for plan approval → Gate 3 tests first.

### 2026-09-06 — Jeetu (via Claude Code) — plan approved → branch → tests first → green → docs (Gates 2–4 + docs; Gate 5 review in flight)
- Done, in commit order on `fix/TASK-20260906-tool-free-kb-inlining` (off T4's tip `4d3b8ab`): `338baba` plan + interview answers; `fce9b6a` RED tests for AC1/2/3/4/6 + the AC5 e2e; `345f36c` GREEN implementation; `360e1b6` docs (ADR-0066, prompts README, lessons ×2, code-map, next-steps, T4 + program pointers).
- **What shipped:** `HostSystemPromptOptions.knowledge: 'tool' | 'inline' | 'none'` (default byte-identical — every existing golden untouched); `35-app-builder-inline.md` + the five-file core as blocks (`INLINE_KNOWLEDGE_CORE_FILES` / `getInlineKnowledgeCore()` in `layers.ts`); `36-app-builder-unaided.md` for webllm; `builder.ts` picks `inline` (host) / `none` (webllm), suffix kept; `HOST_BUILDER_SYSTEM_MAX_BYTES = 45,056` pinned by `apps/host` on `measurePrompt`; the hosted e2e fake lifts the template out of the prompt (section 5 omitted per the template's own rule) and the built app renders `<main>` with the connecting copy gone — two `sample` calls pinned (build + contract synthesis).
- **Found by the e2e, not by any unit test — the USER slot cited the tool too** (`ui/build-app-prompt.md`: "Use the `snug_app_builder` knowledge base first"). Fixed at the same altitude: a `## User Message Template (tool-free)` twin in the prompt store, `parseBuildPrompt().templateToolFree`, `buildUserMessage(idea, prompt, toolFree)`, and `buildsToolFree(brain)` in `state/webllm.ts` beside `resolveTurnMode` as THE derivation the view uses. Lesson recorded.
- **Found by the e2e — the recovery inferrer fired on the verbatim template.** Section 5's `useConnectedFetch` DEFINITION made `finalizeConnectionDeclaration` treat the build as connected, guess the CDN host, and spend a third `sample` call. The 35 layer now says to omit the section unless the app calls an API; the fake follows that rule; the pipeline-side skip under Binding A is a next-steps item (out of scope here). Lesson recorded.
- **`<main>` is attached, not visible:** the template's `<main>` is an empty shell with no box, so Playwright reads it as hidden; the proof is attachment + `Connecting…` gone (announce → host-ready completed).
- **T4's budget fixtures retuned** to the inline arithmetic (18 KB fits under the ceiling; 51 KB — S11's whole-app case — is now the refused example; a 20 KB oldest history message makes the ladder drop exactly one). `HOST_CONTEXT_CAPS` values unchanged, comment carries the numbers.
- Measured on the wire (fake `sample`, first build turn): **41,752 bytes** of input including the user message.
- State: **Gates 2–4 + docs done; Gate 5 (AI review of the diff, ten finder angles) running; AC7 = the owner's re-walk.** Nothing pushed, no PR, nothing published.
- Next step: fold the review → `/close-session` → the owner rebuilds (`pnpm --filter host build`), republishes `dist/snug-host.html` to the SAME artifact and builds an app from the hub (AC7; journal in T4's AC13) → PR stacked on T4 (or after T4 merges).
