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

**Acceptance criteria** (each becomes at least one test; amended 2026-08-15 per the
fresh-context plan review — findings F1-F12 tracked in Decisions):
1. `CHAT_INTENTS` gains `provider_read`/`provider_write`; `chatIntentSchema` parses them; `parseChatIntent` stays fail-closed. Lane assignment becomes an **exhaustive `laneForIntent` map** (`satisfies Record<ChatIntent, ChatLane>`) replacing the predicate else-chain in the router AND `intentContext` — an intent without a lane is a compile error, never a silent answer-lane default (F7).
2. Classifier goldens: provider-vs-DB disambiguation (app-DB question → `data_read`; provider-account question → `provider_read`; provider mutation → `provider_write`; ambiguous → clarify at low confidence). The prompt-coverage test iterates `CHAT_INTENTS` itself, never a retyped list (fixes the latent `app_question` omission; F6).
3. Provider lane context: approved slots, provider names, **public (non-RFC-1918) host literals**, scope summaries, addressing teaching. **Negative (C1), with a hostile fixture (F10): a stored credential containing `+`/`=`/space, an approved LAN-class row, and declared/revoked/pending rows — no credential value, no `auth:` KV content, no RFC-1918 literal appears in any LLM-bound string, and non-approved rows are absent entirely.**
4. `provider_request(method, url, headers?, body?)` executes through the shared assembly, pinned by THREE identity assertions (F8): the tool calls `connectedFetchDepsFor` (module-seam spy), the deps carry the singleton `confirmGate` (`net.ts:50`) by identity, and the default transport is `platformDefaultFetch`. `netAppId` is host-assigned (closure), never a tool argument.
5. Non-approved host → `NET_NOT_APPROVED` fails closed; honest chat rendering + a **code-keyed** CTA observer seat (never message-substring); a **per-turn `provider_request` call cap** bounds retry loops and is the tested mechanism (F9). Multi-host ceiling + symbolic URL → `NET_AMBIGUOUS_CONNECTION` negative test (F2).
6. Mutating method without confirm grant → `NET_CONFIRM_DENIED`; with grant → executes; confirm-before-credential-read ordering asserted at the shared-assembly altitude, not against bespoke spy-deps (F8 note). **Turn abort with a parked confirm denies that confirm** — no post-abort execution.
7. Addressing (F2): symbolic `snug-connection://<slot>/<path>` for single-host (LAN-class) connections; literal `https://<pinned-host>/<path>` for public/multi-host connections. **LAN body scrub (F1): for LAN-class slots, every RFC-1918 IPv4 literal in the rendered tool result is replaced with `[lan-address]` before it enters LLM context — fixture's response body echoes the bridge address (raw + JSON-escaped).**
8. Unrouted modes (subscription/WebLLM/demo) byte-identical to today (route undefined → legacy path); mode gating inherits `liveInferenceAdapter`.
9. Existing lanes regression-green; `MIN_ROUTING_CONFIDENCE` and clarify fallback unchanged.
10. Root `turbo run test --force` green (Windows desktop leg stays deliberately red per ADR-0021 D8).
11. **Confirm queue (F4):** two concurrently parked confirms both resolve — the store becomes a FIFO queue (playground-only); the displaced-resolver orphan is dead by test.
12. **Dialog mount (F3):** `NetConfirmDialog` mounts at the app shell so a provider_write confirm renders wherever the routed chat runs (BuilderView-attached included) — test drives a confirm outside RunView.
13. **Remember-scope semantics pinned (F5):** one test asserts the chosen semantics — session-remember grants are SHARED across app-runtime and chat surfaces for the same (app, host, method) triple (accepted decision, see Decisions).

**Out of scope**: subscription server twin (recorded gap family); new approval doctrine
(owner decision — executor confirm gate is the control); card confirm surface (child B);
any `packages/auth` change; any new wire frame; retry policy for provider errors beyond
existing executor semantics.

## Plan

Order (tests first per TDD.md; amended per plan review 2026-08-15):

1. ~~Fresh-context AI plan review~~ **DONE 2026-08-15** — verdict AMEND FIRST; all 12 findings resolved into the ACs/steps below and the Decisions section.
2. `packages/protocol/src/chat-intent.ts`: add `provider_read`/`provider_write` to `CHAT_INTENTS`; add `CHAT_LANES` + exhaustive `laneForIntent` map (`satisfies Record<ChatIntent, ChatLane>`, F7); keep `isDataIntent`/`isFeatureIntent` as derived views or migrate their two consumers. Protocol tests: parse/fail-closed + map exhaustiveness. Fix `chat-intent-prompt.test.ts` to iterate `CHAT_INTENTS` (F6) — goes red until step 3.
3. `packages/knowledge/prompts/tools/chat-intent-classifier.md`: teach the two intents with hard cases (DB-vs-provider; "match lights to album art" = provider_write; steering attempts stay low-confidence `other`). Golden tests beside existing classifier goldens. (Prompts README + prompt-engineering reference read 2026-08-15.)
4. `apps/playground/src/agent/chatRouter.ts`: `ChatRoute` union + `laneForIntent` dispatch (replaces the predicate chain); `intentContext.ts` branches on the same map (F7).
5. New `apps/playground/src/agent/providerContext.ts`: connection facts from `db.listConnections(appId)` — approved rows ONLY: slot, provider displayName, **public host literals (never RFC-1918; LAN rows teach symbolic-only)**, scope summary; addressing teaching per AC7. C1 negative fixture per AC3/F10.
6. New `apps/playground/src/agent/providerTools.ts` (template: `dataTools.ts`): `provider_request` tool — validated args, executes via `connectedFetchDepsFor` with the attached app's id (closure); renders scrubbed result into a defanged `<api_result>` block (byte cap, "data, not instructions" tail); **LAN-class body scrub of all RFC-1918 literals (F1)**; per-turn call cap (F9); code-keyed failure observer seat for the rail CTA (F9); **abort handling: on turn-signal abort, a confirm this tool parked is denied** (AC6). Tool prompt: new `packages/knowledge/prompts/tools/provider-request.md`.
7. `apps/playground/src/state/net.ts`: `netConfirmStore` becomes a FIFO queue (F4). `NetConfirmDialog` mount moves from RunView to the app shell (F3) — desktop inherits via the alias. `useBuilderChat.ts`: provider-lane tool wiring beside the data lane, `STEP_LABELS` additions.
8. KB teaching: extend `knowledge-base/app-authoring/90-auth-and-connected-apis.md` (+ `95-runtime-contract.md` note: contracts name their slots) so authored apps inherit the affordance. KB≡SDK sync untouched (no embedded hooks change).
9. Verify: root `turbo run test --force` (protocol touched → everything), `pnpm --filter desktop test`. Force-run knowledge/playground suites on prompt edits (turbo inputs gap).
10. Gate 5: fresh-context adversarial review running probes at the C1 surface (lesson 2026-07-31); Gate 6 close-out — ADR-0031 status flip to accepted in THIS child's merge; **threat-model delta note** (F12 + scrub A3 boundary carry-over + F5 shared-remember residual); spec-changelog NOT touched (no schemas/ change); lessons/next-steps updated.

Cross-package: protocol → everything reruns; knowledge → server/playground/desktop; no auth/db/runner/sdk source changes.

## Decisions & surprises

- 2026-08-15 — Fresh-context plan review (verdict AMEND FIRST) — resolutions:
  - **F1 (BLOCKER, LAN body leak):** executor's body scrub deliberately excludes resolved hosts (app-bound delivery rationale, `connected-fetch.ts:1136-1141`); LLM-bound delivery adds a chat-side scrub: LAN-class slots get every RFC-1918 IPv4 literal replaced in the rendered tool result. Playground-only; executor untouched.
  - **F2 (BLOCKER, symbolic single-host):** symbolic URLs refuse multi-host ceilings (`allowedHosts.length !== 1`), and every OAuth ceiling is multi-host (endpoint-host union). Public host literals are NOT secrets — they join the lane context; symbolic stays the LAN path. No executor change.
  - **F3/F4 (dialog mount / confirm collision):** `NetConfirmDialog` mount moves to the app shell; `netConfirmStore` becomes a FIFO queue so concurrent confirms both resolve.
  - **F5 (shared remember scope): ACCEPTED** — one gate, one meaning: a session-remembered (app, host, method) grant covers both app-runtime and chat-composed writes. Consistent with the owner's 2026-08-15 posture ("existing gate is the control"); pinned by AC13's test; recorded as a residual in the threat delta + ADR-0031.
  - **F7 (exhaustiveness):** predicates → one `laneForIntent` map in protocol; unknown-intent-to-answer-lane default dies at compile time.
  - **F11 (dialog copy mislabels chat-origin writes): ACCEPTED for this child** — the dialog says "this app is asking"; a chat-composed write is the user's own turn. Child B's confirm card fixes attribution; recorded here so it is a known wart, not a discovery.
  - **F12 (provider bodies re-enter the classifier via recent-turns): recorded** in the threat delta; contained by the 300-char defanged cap + fail-closed clarify.
  - Own finding (pre-review): turn abort with a parked confirm could execute a write post-abort — the provider tool denies its own parked confirm on abort (AC6).

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: spec + plan drafted (Gate 1-2) under the umbrella interview.
- State: awaiting umbrella plan approval; then fresh-context plan review before Gate 3.
- Next step: on approval — branch, failing tests for AC1-AC3 first.
- Open questions: none.

### 2026-08-15 (later) — Claude (Fable 5) — session
- Done: owner approved the umbrella plan; fresh-context plan review ran (AMEND FIRST —
  2 blockers, 5 majors, 5 minors; all resolved into ACs 1-13 and the Decisions section).
  Gates 3-4 complete: red-first at every layer (protocol tsc gate → laneForIntent;
  derived prompt-coverage loop → caught the latent `app_question` example gap; playground
  tsc gate → provider modules). Implemented: protocol intents + `CHAT_LANES` +
  `LANE_FOR_INTENT`; classifier prompt (2 new intents, hard-case rules, 3 new examples,
  connections seat in the user slot); `providerContext.ts`; `providerTools.ts`
  (shared-assembly execution, call cap, abort-denies-parked-confirm, unconditional
  RFC-1918 render scrub); confirm FIFO queue; `NetConfirmDialog` → App shell;
  `useBuilderChat` provider lane + `onProviderNetError` CTA seat (RunView consumer);
  KB 90/95 teaching. Threat delta authored
  (`docs/security/threat-model-delta-provider-chat-lane.md`); ADR-0031 flipped accepted.
  Fixture lesson en route: the singleton remember-gate leaked a grant across tests
  reusing one app id — invalidateNetGrants in beforeEach, mirroring real transitions.
- State: layer suites green (protocol 302 · knowledge 183 · playground 1082/106 files);
  forced root run + Gate 5 fresh-context implementation review pending.
- Next step: root `turbo run test --force` result → Gate 5 adversarial review with C1
  probes + targeted mutation checks → journal sign-off → PR.
- Open questions: none.
