# TASK-20260906-tool-free-kb-inlining: the tool-free builder must CARRY the authoring rules, not cite a tool it cannot call

- **Status**: draft — awaiting the Gate-1 interview + plan approval
- **Owner**: Jeetu (via Claude Code)
- **Risk tier**: **Medium** — `packages/knowledge` is widely depended on and this changes what every tool-free brain (host AND webllm) is told; no protocol schema, no sandbox/CSP, no auth (so no auto-escalation to High). Escalate to High if the interview moves the selection into `packages/protocol`.
- **Branch**: `fix/TASK-20260906-tool-free-kb-inlining` (off `main`; NOT yet created — Gate 2)
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
