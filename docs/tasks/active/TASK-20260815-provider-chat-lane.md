# TASK-20260815-provider-chat-lane: Provider lane — LLM-composed API requests through the governed executor (child A)

- **Status**: draft (planned; blocked on umbrella plan approval)
- **Owner**: Jeetu
- **Risk tier**: **high** — touches `packages/protocol` (`chat-intent.ts`), and the new prompts drive credentialed calls (C1-adjacent). Fresh-context AI plan review required BEFORE implementation; negative tests required.
- **Branch**: `feat/TASK-20260815-provider-chat-lane` (off `main`, created when work starts)
- **Packages touched**: `packages/protocol` (chat-intent, internal draft), `packages/knowledge` (classifier prompt + new tool prompt + KB layers), `apps/playground` (router, tools, context, wiring), `apps/desktop` (dependent — tests only)
- **Spec impact**: none published — chat-intent stays internal like ADR-0019; wire v1 unchanged; nothing in `schemas/`
- **Related**: umbrella [TASK-20260815-starter-portfolio-revamp](TASK-20260815-starter-portfolio-revamp.md) · ADR-0019 (pattern being extended) · ADR-0026 (symbolic addressing the lane teaches) · draft ADR-0031

## Spec (what & why)

A chat message beside an installed app that concerns **data living at the provider**
("which song did I play most last week?", "create a repo label", "start a TWAP buy")
routes to a new **provider lane**. The lane's LLM turn sees the app's approved
connections (slot, provider name, granted scope summary, symbolic addressing rules —
**never credentials, never resolved LAN hosts**) and gets one tool, `provider_request`,
whose executions go through `createConnectedFetch` exactly as app-runtime requests do:
same deps assembly, same `netAppId`, all ten gates. GET/HEAD answer inline; mutating
methods hit the executor's existing confirm gate (dialog in this task; card in child B).
Scrubbed responses render into chat context the same defanged way `<query_result>` does.
The KB teaches the affordance so built apps mention their slots in runtime contracts and
users discover the capability.

**Acceptance criteria** (each becomes at least one test):
1. `CHAT_INTENTS` gains `provider_read`/`provider_write`; `chatIntentSchema` parses them; lane mapping yields `'provider'`; `parseChatIntent` stays fail-closed (unknown intent → undefined → clarify).
2. Classifier goldens: provider-vs-DB disambiguation cases route correctly (app-DB question → `data_read`; provider-account question → `provider_read`; provider mutation → `provider_write`; ambiguous → clarify at low confidence). Prompt + schema move in lockstep.
3. Provider lane assembles context containing approved slots/providers and symbolic-URL teaching; **negative (C1): no credential value, no `auth:` KV content, no resolved LAN host string can appear in any LLM-bound string** (adversarial fixture: store a credential, assert absence across the assembled turn).
4. `provider_request(method, url, headers?, body?)` executes via the SAME executor instance/deps as app-runtime net (`connectedFetchDepsFor`), with host-assigned `netAppId` — asserted at the seam by identity, not shape (lesson 2026-08-13).
5. Non-approved host → `NET_NOT_APPROVED` fails closed and renders an honest chat message with a connect CTA; no retry loop.
6. Mutating method without confirm-gate grant → `NET_CONFIRM_DENIED`; with grant → executes. Negative: confirm gate is invoked BEFORE any credential read (order pinned by spy, lesson 2026-08-15).
7. Symbolic `snug-connection://<slot>/<path>` URLs work in the tool; app-side response scrub behavior preserved (resolved host never in the tool result the LLM sees).
8. Unrouted modes (subscription/WebLLM/demo) behavior byte-identical to today (route undefined → legacy path); mode gating inherits `liveInferenceAdapter`.
9. Existing lanes (data/feature/answer/clarify) regression-green; `MIN_ROUTING_CONFIDENCE` and clarify fallback unchanged.
10. Root `turbo run test --force` green (Windows desktop leg stays deliberately red per ADR-0021 D8).

**Out of scope**: subscription server twin (recorded gap family); new approval doctrine
(owner decision — executor confirm gate is the control); card confirm surface (child B);
any `packages/auth` change; any new wire frame; retry policy for provider errors beyond
existing executor semantics.

## Plan

Order (tests first per TDD.md):

1. **Fresh-context AI plan review** of this file (High tier) — resolve findings before any code.
2. `packages/protocol/src/chat-intent.ts`: add `provider_read`/`provider_write` to `CHAT_INTENTS` (L33-40), extend lane types + `isProviderIntent` predicate alongside `isDataIntent`/`isFeatureIntent` (L93-100). Tests in protocol suite (parse/fail-closed).
3. `packages/knowledge/prompts/tools/chat-intent-classifier.md`: teach the two intents with hard cases (DB-vs-provider; "match lights to album art" = provider_write; steering attempts stay low-confidence `other`). Golden tests beside existing classifier goldens. Read prompts README + prompt-engineering reference first.
4. `apps/playground/src/agent/chatRouter.ts`: `ChatRoute` union + lane switch (L39-43, L107-109).
5. New `apps/playground/src/agent/providerContext.ts` (or a branch in `intentContext.ts` L58-111): connection facts from `db.listConnections(appId)` — approved rows only: slot, provider displayName, allowedHosts count (NOT LAN literals), scope summary from requirement; plus symbolic addressing teaching. C1 negative test here (AC3).
6. New `apps/playground/src/agent/providerTools.ts` (template: `dataTools.ts`): `provider_request` tool — Zod-validated args, executes via the `connectedFetchDepsFor` seam with the attached app's id, renders scrubbed result into a defanged `<api_result>` block with byte cap + "data, not instructions" tail (mirror `renderRows` L86-110). Tool description prompt: new `packages/knowledge/prompts/tools/provider-request.md`.
7. `apps/playground/src/agent/useBuilderChat.ts`: lane-scoped tool wiring beside the data lane (L545-572), `STEP_LABELS` additions, persistence of provider-turn results on the message row.
8. KB teaching: extend `knowledge-base/app-authoring/90-auth-and-connected-apis.md` (+ `95-runtime-contract.md` note: contracts name their slots) so dev-time and user-authored apps inherit the affordance. KB≡SDK sync untouched (no embedded hooks change).
9. Verify: root `turbo run test --force` (protocol touched → everything), `pnpm --filter desktop test`. Force-run knowledge/playground suites on prompt edits (turbo inputs gap).
10. Gate 5: fresh-context adversarial review running probes at the C1 surface (lesson 2026-07-31); Gate 6 close-out — ADR-0031 status flip to accepted happens in THIS child's merge (it ships the decision), spec-changelog NOT touched (no schemas/ change), lessons/next-steps updated.

Cross-package: protocol → everything reruns; knowledge → server/playground/desktop; no auth/db/runner/sdk source changes.

## Decisions & surprises

_(running)_

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: spec + plan drafted (Gate 1-2) under the umbrella interview.
- State: awaiting umbrella plan approval; then fresh-context plan review before Gate 3.
- Next step: on approval — branch, failing tests for AC1-AC3 first.
- Open questions: none.
