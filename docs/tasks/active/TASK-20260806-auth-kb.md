# TASK-20260806-auth-kb: AL-05 — teach the builder LLM auth declaration + connected-API design (roadmap A5)

- **Status**: in-progress (child of TASK-20260805-alpha-umbrella; Phase-0 approval pre-approves child plans)
- **Owner**: Jeetu (autonomous overnight run; Claude orchestrates)
- **Risk tier**: **Medium** (LLM-prompt/KB work + UI copy; no schema wire changes; TDD mandatory, plan review run by orchestrator's call per the AL-04 precedent — LLM-prompt work benefits)
- **Branch**: `feat/TASK-20260806-auth-kb` (cut off `main` @ `caaeb97`, post-AL-04)
- **Packages touched**: `packages/knowledge` (the work), `apps/playground` (emission-sync test + disclosure copy + demoAuth seam formalization), `packages/protocol` (**constant-only refactor** — named export for the existing `'auth_wizard'` literal; zero wire-shape change)
- **Spec impact**: none (no schema change; the directive contract shipped in AL-04). The constant refactor is a no-op re-export — spec-changelog only if SPEC_SYNC demands it (checked at implementation).
- **Related**: umbrella TASK-20260805 row AL-05 · `docs/decisions/0004-central-layered-prompt-store.md` (store rules) · `packages/protocol/src/render-directive.ts` (shipped contract) · `apps/playground/src/agent/renderDirective.ts` (scanner) · `docs/code-map.md:26` (the open row this closes) · Anthropic prompt-engineering reference (read 2026-08-06, per standing memory) · next-steps rows dated 2026-08-06 (lines 52, 56, 59, 62)

## Spec (what & why)

The Dynamic Auth port (AL-02→AL-04) shipped the machinery: `useConnectedFetch` in the app template, the `net` frame, the auth wizard, and the `auth_wizard` render directive with parse-don't-trust scanning. But the **builder LLM has never been taught any of it** (code-map row 26 ⭕): grep confirms zero KB mentions of `auth_required` or directive emission. Today only the `?demoauth` scripted seam exercises the flow. AL-05 closes the knowledge gap: the builder learns to **declare** that an app requires auth (roadmap A5's `auth_required` — realized by the shipped directive mechanism, see Decisions), to **design** app code against `useConnectedFetch` with a graceful pre-connection state, and to **never** place credentials in app code.

### Acceptance criteria

1. **AC1 — Connected-API design teaching.** New KB file `packages/knowledge/prompts/knowledge-base/app-authoring/90-auth-and-connected-apis.md` (ADR-0004 header, layer `knowledge-base`) teaching: (a) apps that need external APIs call them ONLY through `useConnectedFetch` (already copy-exactly in `20-html-template.md` §5); (b) credentials-live-with-the-host stated **positively** (the host injects saved credentials; app code and app storage contain zero secrets, zero key-entry UI); (c) design a working degraded state before the connection is approved (`{ok:false}` handling); (d) net traffic is visible in the frames timeline as **structure only** (next-steps line 52, AL-05 half).
2. **AC2 — Declaration teaching.** Same file teaches emission: after writing the app, emit **exactly one** `auth_wizard` render directive as a fenced ```json block in the chat reply. Shape locked to the shipped contract **via placeholders** — `{{protocolVersion}}`, directive kind + auth kinds injected from protocol (ADR-0004: never retype wire literals). Famous providers: `providerName` (+ `kindHint` when confident) — **names, not endpoint values** (the host's registry/ladder resolves the rest; the directive is a DOORBELL). `declaredApiHosts` only when the user themselves named the host. Omit `confidence`/`provenance` (host recomputes; display-only).
3. **AC3 — Omit-set never taught.** The rendered KB auth teaching contains none of the five `llmProposalSchema`-omitted field names (`fields`, `userLayerFields`, `headerTemplate`, `registrationConsoleUrl`, `registrationInstructions`) as taught JSON keys — asserted by a negative test (JSON-key/backtick context match, not bare-word).
4. **AC4 — Emission format round-trips the real parser.** The KB's example directive (rendered) parses via `renderDirectiveSchema` (knowledge-side sync test, same pattern as the inferrer few-shot contract test) **and** is found by the playground's real `scanForRenderDirective` when embedded in a realistic builder reply (playground-side test importing the rendered KB text).
5. **AC5 — Always-on awareness.** The app-builder summary layer (`00-summary.md` and/or `system/30-app-builder-summary.md`) gains ≤2 sentences: apps can use approved external APIs through the host with user-approved credentials — full contract behind the `{{appBuilderToolName}}` tool. Golden snapshots updated as a reviewed, intentional diff.
6. **AC6 — D8 primary-host bias** (next-steps line 59). `tools/auth-spec-inferrer.md` gains a rule + few-shot example: documentation naming several base hosts (production/sandbox/telemetry) → `declaredApiHosts` lists **only the host the app's runtime calls need** (typically production); secondary hosts stay in `evidence` for reviewer visibility, user opts in via wizard edit. Prompt-side ONLY — schemas untouched; all few-shot outputs still pass the `inferrerProposalSchema` contract test.
7. **AC7 — Keyed-subscription disclosure** (next-steps line 62, seat decided here). Honest-copy fix in AL-05: when a subscription-mode user with a stored BYOK key reaches the docs-paste step, the copy names the actual wire (browser-direct to their configured provider), not the generic "your configured model". Test-first UI copy change. The server-twin alternative is journaled to next-steps as an AL-10 candidate — NOT built here.
8. **AC8 — demoAuth seam FORMALIZED** (next-steps line 56, decision made here: keep, don't retire — the wizard e2e needs a deterministic brain; a live-LLM e2e would be flaky by construction). Header comment updated to point at the shipped KB teaching instead of "AL-05 owns…"; `?demoauth` e2e stays green and the seam's directives remain schema-locked by existing tests.
9. **AC9 — Roll-up.** Root suites + playground vitest + full Playwright green; live sweep includes a REAL byok builder run where a prompt like "build me a weather app using OpenWeather" yields a valid directive → connect card → wizard open (D8 multi-host docs re-probe included); `docs/code-map.md:26` flipped to ✅ with test refs; next-steps rows 52 (AL-05 half), 56, 59, 62 (keyed half) date-closed; prompts/README tree updated; ADR-0004 lint + headers + goldens all green.

## Plan (test-first; umbrella mutation numbering continues from M47)

| Step | Work | Test first (mutation) |
|---|---|---|
| 1 | Protocol constant-only refactor: export the `'auth_wizard'` kind literal (e.g. `AUTH_WIZARD_DIRECTIVE_KIND`) and use it in `authWizardDirectiveSchema`'s `z.literal`; add to `render.ts` substitutions with the auth-kind values already injected | **M48**: change the constant's value → schema test + placeholder test both RED (proves single-home) |
| 2 | Author `90-auth-and-connected-apis.md` (AC1+AC2 content; prompt-eng guide: positive framing, one canonical example, format contract stated once) + typed accessor/gen-content/goldens | **M49**: corrupt the KB example's `kind` → AC4 sync test RED. **M50**: drop the placeholder, retype the literal → placeholder-integrity/centralization lint RED |
| 3 | AC3 negative test over rendered KB auth teaching (five omitted field names) | **M51**: add `headerTemplate` as a taught key in the KB → test RED |
| 4 | Playground emission-sync test: rendered KB example embedded in a realistic reply → `scanForRenderDirective` returns the validated directive | **M52**: wrap example in a non-json fence tag the scanner skips… (verify scanner accepts; if scanner accepts all fences, mutate the example JSON instead) → RED |
| 5 | AC5 awareness clause + golden updates | **M53**: remove the clause → golden RED (intentional-diff discipline) |
| 6 | AC6 D8 rule + example; goldens + contract test | **M54**: make the new example output all three hosts → the new assertion (production-only) RED |
| 7 | AC7 disclosure copy + test in the wizard paste step | **M55**: revert copy to "your configured model" with key present → test RED |
| 8 | AC8 seam header + e2e re-run; code-map/next-steps/README docs pass | covered by existing e2e + lint |
| 9 | Full gates: root suites, Playwright, live sweep (fresh servers; kill stale first), fresh-context adversarial review, fold, merge | — |

## Forward constraints inherited from AL-04 (binding, copied at creation per handoff #3)

- Teach `auth_required` declaration + the directive contract as SHIPPED (`renderDirectiveSchema`) — builder copy never retypes the literals.
- The directive is a DOORBELL, not an authority (B2): hints are advisory; the host re-runs the ladder at wizard open and computes provenance itself. Emit **provider names, not endpoint values**, for famous providers.
- Read the Anthropic prompt-engineering reference BEFORE authoring any prompt/KB text (standing memory — done 2026-08-06 this session).
- LLM-facing proposal shapes exclude `fields[]`/registration/`headerTemplate` (`llmProposalSchema` omit-set) — KB copy must not teach the builder to emit them.
- D8 host-breadth non-blocker folds here: prompt-side bias toward the primary host, never a schema change.
- The `?demoauth` seam is a TEST seam — AL-05 owns the real builder teaching and may retire or formalize it (decision: formalize, AC8).
- Keyed-subscription inference disclosure: server twin or honest copy — decide during Gate 2 (decision: honest copy here, server twin queued to AL-10, AC7).

## Decisions & surprises

- **`auth_required` = the shipped directive mechanism.** Roadmap A5's "builder declares `auth_required`" is realized by teaching `auth_wizard` directive emission + connected-fetch design. The reserved `ERROR_CODES.AUTH_REQUIRED` + `authRequiredPayloadSchema` (protocol constants:32,43 — "auth broker is v1.1") stay **untaught**: teaching a reserved, unwired code would teach vapor. Stated here so reviewers don't read AC2 as under-scoped.
- **Seam formalized, not retired** (AC8 rationale above). **Disclosure = honest copy** in AL-05; server twin to AL-10 (AC7).
- Minimal-hints doctrine (AC2): the less the builder is taught to emit, the smaller the poisoning surface — providerName+kindHint is the taught default; hosts only when user-named; endpoints never taught (inference/registry own them).

## Session journal (append-only, newest last)

### 2026-08-06 — Claude (Fable 5, orchestrator) — Gate 2
- Resumed umbrella per /pickup from HANDOFF #3 (baseline verified: diff journal-explained, root 19/19 cached-green, stale 5173 Vite server killed per session-start lesson).
- Gate-2 reads: prompt-eng reference (WebFetch, standing memory), knowledge-pkg map (subagent report: assembly pipeline, 13 test files, ADR-0004 store rules), `render-directive.ts` contract + scanner, D8 prompt, next-steps rows 52/56/59/62, AL-04 §Forward constraints (copied above).
- Key confirmations: KB has ZERO auth-declaration teaching (code-map row 26 ⭕); scanner contract = fenced json / bare balanced object, first-valid-wins, malformed-claim → visible drop note; placeholder renderer is strict (unknown placeholder = build error).
- This task file authored; plan review next (orchestrator's call: run it — LLM-prompt-heavy child, AL-04 precedent).
