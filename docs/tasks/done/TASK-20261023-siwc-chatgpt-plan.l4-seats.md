# TASK-20261023-siwc-chatgpt-plan — L4 seat inventory (working note; Opus 5.5 read-only sweep, 2026-10-23)

Parked beside the task file for the L4 lanes; folded into the journal / removed at Gate 6. All paths under `apps/playground/src/`. Line numbers as of `022e5bc`. `providerEffort` does not exist anywhere in `src` yet; the only trace of the new field is `TurnAdapterConfig.effort` (agent/adapter.ts:41-46).

**Root finding:** `DirectMode = Exclude<PlaygroundMode, 'subscription'> | 'webllm' | 'host'` (agent/adapter.ts:32). Adding `'chatgpt'` to `PlaygroundMode` adds it to `DirectMode` automatically. `adapterKindFor` (adapter.ts:146-155) has no chatgpt arm, so a `mode: 'chatgpt'` route goes on to the provider checks: it answers `'anthropic'` or `'openai'` when a BYOK key is in the file, and `'demo'` otherwise. Every seat below that calls `adapterKindFor`, or reads a key unless the mode is `local`/`webllm`/`host`, inherits this.

## state/mode.ts
- :30 `PlaygroundMode = 'subscription' | 'byok' | 'local'` — needs `'chatgpt'`.
- :31/:53 `ByokProvider`, `KeyedProvider = 'anthropic'|'openai'`, `KEYED_PROVIDERS` (:54) — chatgpt has no BYOK provider; keep it out of `KeyedProvider`; no key row.
- :56 `modeStore` default `'byok'`. :63 `modeCoercedStore`.
- :87 `isMode` — a stored `'chatgpt'` fails today, is silently ignored (modeStore stays `'byok'`, no note). Needs recognising.
- :94-96 `availableModes()` keys only on `capabilities.subscriptionMode`. Needs `'chatgpt'` only when `getPlatform().chatgptPlan !== undefined`.
- :123-138 `hydrateSettings` W2b coercion (`modeStore.set`, never `setMode`; `modeCoercedStore.set(true)`). Needs the same for a stored `'chatgpt'` on a platform without the seat (the seat is static, so a failed boot read never triggers it).
- :140-143 key presence from `byok:anthropic|openai`. :159-184 legacy `model` row adoption only when `storedMode === 'byok' || undefined` (:175) — chatgpt excluded, correct.
- :49-50 `providerModelSettingKey` typed to `KeyedProvider` — `providerEffort:<mode>` / a chatgpt model row is a new key family.
- :205-208 `setMode`. :248-267 `setByokKey`/`getByokKey` — must never be called in chatgpt mode (callers below). :279-281 `endpointsNeedConfirm()` — the F15 reader.

## state/appModel.ts
- :29 `appProviderStore` (`appProvider:<appId>` rows); :34 `appModelStore` (`appModel:<appId>`).
- :53-70 `setAppPin(appId, {provider: ByokProvider, model})` writes both rows — a pin carries no mode today. :76-83 `setAppModel` = the LOCAL pin (model only, no provider row). :89-92 `appProviderPinFor` accepts only `'anthropic'|'openai'|'mock'`.
- :111-126 `resolveModelForApp` — THE CROSS-PIN: `pinned` returned mode-blind (:113-114); `mode === 'byok'` → `providerModelsStore` (:116); else the global `model` row (:125). A byok `gpt-4o` pin reaches Ollama; in chatgpt mode any byok/local pin or the global `model` row (`llama3.2`) would be sent.
- :139-143 `appPinMissingKey` reads the byok presence store.

## state/builderModel.ts
- :16-19 `BuilderPick { provider: ByokProvider; model }` session-only. :36-41 `applyBuilderPickToApp` → `setAppPin` (called from useBuilderChat.ts:603); applied only under `mode === 'byok' && provider !== 'mock'` (useBuilderChat.ts:671/674, activeBrain.ts:66).

## state/activeBrain.ts
- :43 `ActiveBrainKind = AdapterKind | 'subscription'` (widens with `ADAPTER_KINDS`).
- :56-71 `resolveActiveBrainFrom`: host → webllm → demo → `subscription` (:61) → builderPick under the byok guard (:65-68) → `adapterKindFor` (:70). Chatgpt answers anthropic/openai/demo today. Needs an explicit arm before :62.
- Label map: views/BrainChip.tsx:70 `BRAINS: Record<ActiveBrainKind,…>` (compiler-forced entry); `copyFor` :118; `brainChipLabel` :135.
- Tests: ADR-0059 AC1 matrix `__tests__/adapterKind.test.ts:51-66` (loops `['byok','local','webllm']`); AC2 `activeBrain.test.ts`; chip `brainChip.test.tsx`.

## state/webllm.ts
- :88-102 `resolveBrain` mode-blind. :149 `TurnMode = PlaygroundMode | 'webllm' | 'host'` widens. :151-156 `resolveTurnMode` passes `'chatgpt'` through — consumers must handle it.

## agent/adapter.ts
- :32 `DirectMode`; :34-53 `TurnAdapterConfig` (+ `effort`); :101 `ADAPTER_KINDS` needs `'chatgpt'` (single-homed → `metaToBrainKind` follows); :110-114 `AdapterRoute`; :142-144 `routeOf`; :146-155 `adapterKindFor` needs `mode === 'chatgpt'` → `'chatgpt'` before the provider checks.
- :163-210 `createTurnAdapter` arms: host (:171-182, `hostBrainGone` named result :132-139), webllm (:183), local (:188), anthropic/openai (:194-206, throw without key), demo (:207). Needs a chatgpt arm: the page's keeper adapted to `BearerSource`, never `config.key`, named results, honours `config.effort`.

## agent/transport.ts
- :115-117 `readKey = options.getKey ?? getByokKey`. :135 F15 gate `mode !== 'host'` (chatgpt inside it). :156-159 the key exclusion list (`local|webllm|host`) — chatgpt CALLS `getByokKey` today → needs `'chatgpt'`. :160-169 config has no `effort`. :260-319 `resolveAppTransport`: `model = resolveModelForApp(appId)` (:308) → subscription (:309) → `pinnedProvider` under byok (:310) → `createDirectAppTransport({mode,…})` (:311).

## agent/builder.ts
- :233 `readKey`; :273 F15; :286-289 provider pin under byok; :292 key exclusion list — needs `'chatgpt'`; :296 `model = options.model ?? resolveModelForApp(appId)`; :300-308 one `adapterConfig` → `onBrain(adapterKindFor(routeOf(…)))` (:307) + `createTurnAdapter(…, 'chat')` (:308) — needs `effort`. :240-243 `knowledgeDeliveryFor` sees chatgpt as `{kind:'settings'}`. :134 `createServerBuilder` subscription only.

## agent/useBuilderChat.ts
- :362-367 `metaToBrainKind` (follows `ADAPTER_KINDS`). :633 `serverTurn`. :635-677 agent memo: webllm (:646), demo (:647), host (:651-659), `freshPick` (:664), subscription (:665-668), else `createDirectBuilder({ mode, provider: mode === 'byok' && … ? freshPick.provider : provider })` (:669-676). :603 `applyBuilderPickToApp`. :902-905/:1312-1317 `liveInferenceAdapter` (inherits the inferrer leak). :915/:986 data lane gated by `chatDoorOpen(chatBrainRoute(db, appId))`. :1190-1193 `onBrain` stamps `brainKind`.

## agent/inferrerAdapter.ts
- :43-52 `WireDecision` = webllm | host | local | byok{provider, viaSubscription} | unavailable.
- :54-73 `decideWire`: `direct = mode === 'subscription' ? 'byok' : mode` (:67) → local (:68) → mock → unavailable (:69) → **`getByokKey(provider)` (:70)** → byok (:72). THE WARNED LEAK: chatgpt mode with a BYOK key in the file answers a byok wire. Needs a chatgpt arm before :70.
- :81-97 `inferenceWireCopy` exhaustive switch. :114-144 `liveInferenceAdapter`: :135 `getByokKey`, :140 `createTurnAdapter({ mode:'byok' })` — second key read; no F15 check. External caller: agent/connectionInferrerAdapter.ts:205.

## access/egress.ts
- :77 `ReaderBrainKind = AdapterKind | 'subscription'`. :103-120 `readerBrainRoute`: host/webllm/demo → subscription (:113) → pinned under byok (:114) → keyed (:117) → `adapterKindFor` (:119) — chatgpt answers `'demo'` with `keyMissing:false` today. :131-133 `chatBrainRoute` ≡. :136-138 `chatDoorOpen = anthropic|openai|local`. :149-173 `brainLine` exhaustive (`never` :166-169) → forces `EGRESS.chatgpt`; `EGRESS` access/copy.ts:396-422, `BRAIN_NAMES` :425-428, `EGRESS.keyMissing` :398.

## schedule/appThink.ts
- :133 `KEYLESS_BRAIN_REFUSAL`; :136 `brainBlockedOutcome` → `{status:'refused', blockedBy:'brain'}`; :144-146 `keylessBrainGate(db, appId, route = chatBrainRoute(db, appId))` → `route.kind === 'demo' ? brainBlockedOutcome() : undefined` — chatgpt would be refused with the KEYLESS sentence today.
- :202-205 `defaultTransportFor`: demo → undefined, else `createAppTransport(modeStore.get(), providerStore.get(), undefined, appId)`.
- :448-454 error-code policy: NO retry, `retryable` ignored; `CONSENT_REQUIRED` → refused (0 AI calls; schedule/scrub.ts:46-48 `countsAsAiCall`); `CANCELLED` → failed 'cancelled'; else failed with `reply.message`, 1 AI call.

## schedule/appAgent.ts
- :96-102 `configFrom`: local → local config; else `db.getSecret('byok:'+provider)` (:100, a DIRECT secret read) → byok config (:101). :110-121 `directBrain`: keylessBrainGate (:112) → `!chatDoorOpen` → `NO_DIRECT_BRAIN` (:114) → F15 (:116) → `configFrom` → `built !== route.kind` → throw (:118-119). Chatgpt admitted by the door would build byok, read the secret, then throw.

## schedule/editorModel.ts
- :689-697 `appBrainKind` — A SECOND COPY of the derivation (mode-blind pin at :694, unlike transport.ts:310) → `adapterKindFor`. Used by schedule/ScheduleEditor.tsx:152 (`brainChipLabel(appBrainKind(…))`), rendered :405 beside `honesty`. Neither is referenced by any test.

## run/LlmInspectorPanel.tsx
- :180-222 `emptyCopy(mode: TurnMode)` switch (no default; declared return type → compiler forces a chatgpt case). Callers: run/ThinkPanel.tsx:46 (RunView.tsx:178/:853); views/BuilderView.tsx:176 passes raw `useMode()`, not `useTurnMode()`.

## App.tsx
- :76-115 boot: `bootUserDb()` (:77) → `refreshOllama().then(initSettings)` (:83-84) → `initScheduler()` (:90-92) → `initDesktopFirstRun` (:93) → latches (:100) → `hydrateSharedInbox` (:103); `initWebllm()` parallel (:105). The keeper's first read goes between :84 and :90. :174-181 recover-fresh chain also ends in `initScheduler()`. Other callers: state/userdb.ts:248 (restore), schedule/scheduler.ts:530. Import/pull re-hydration: state/sync.ts:96-101 (`markEndpointsNeedConfirm(); hydrateSettings(db); markEndpointsNeedConfirm();`).

## platform/openFile.ts
- No mode/provider logic: gates → confirm → `importUserFile` (:97). F15 armed in state/sync.ts:96/:101; consumed at transport.ts:135, builder.ts:273, appAgent.ts:116 via `endpointsNeedConfirm()`. `liveInferenceAdapter` does NOT check it.

## Seats the plan's L4 list does not mention
| file:line | today |
|---|---|
| views/BrainChip.tsx:70 | `BRAINS` record (compiler-forced chatgpt entry) |
| views/BrainChip.tsx:244-251 | demo menu shortcut `setMode('local')` |
| views/DemoBrainCallout.tsx:26-28 | shown iff active brain is `'demo'` (would show in chatgpt mode today) |
| views/ChatLog.tsx:182 | `brainKind === 'demo'` tag |
| views/SettingsView.tsx:92-96 | `MODE_LABELS: Record<PlaygroundMode,string>` (compiler-forced) |
| views/SettingsView.tsx:164-176 | mode buttons from `availableModes()`; hint ternary's else = hub copy |
| views/SettingsView.tsx:181/:183/:255 | per-mode panels; :479 `getByokKey` for the key fields |
| run/ModelSelect.tsx:79-123/:153-206 | byok+mock → null, local, subscription; OTHERWISE the BYOK arm (chatgpt would render keyed groups and write anthropic/openai pins) |
| run/BuilderModelSelect.tsx:50 | `mode !== 'byok'` → null |
| run/DocsPanel.tsx:44-73 | `emptyCopy` if-chain (generic fallback, not compiler-enforced) |
| run/RunView.tsx:174-178/:411-429/:1345 | transport memo + frame key on mode/provider |
| run/appRuntime.ts:102/:142 | `composeAppRuntime` → `createAppTransport(mode, provider…)` |
| schedule/appRun.ts:262 | hidden-frame runtime from `modeStore`/`providerStore` |
| schedule/executors.ts:229-233/:241-246/:313 | `answerAsk` (`!chatDoorOpen` → degrade), `executeAsk` (keylessBrainGate first), `brainRouteFor: chatBrainRoute` |
| schedule/askBrain.ts:26-30 | `askBrainFor`: keylessBrainGate → `'blocked'`; `chatDoorOpen` → tools/no-tools |
| run/ChatFetchToggle.tsx:66 | `chatDoorOpen(chatBrainRoute(…))` |
| agent/connectionInferrerAdapter.ts:205 | `liveInferenceAdapter()` (inherits the leak) |
| agent/chatRouter.ts:85-93 | `classifierApplies` (chatgpt counts as `'settings'`) |
| desktop/DesktopWelcome.tsx:28/:33 | first-run `setMode('local'/'byok')` |
| feedback/environment.ts:27 | prints `modeStore.get()` (cosmetic) |
| state/sync.ts:96-101 | F15 arming + re-hydration on import/pull |

(vault/UnlockScreen.tsx:52 `setMode` is a local state, not a seat.)

## Existing tests to extend (`__tests__/`)
- Mode/hydrate/coercion: `mode.test.ts` (:27 write-through/hydrate, :56 F15, :69-97 keys), `modeCoercion.test.tsx` (:61-123 W2b), `providerDefaults.test.ts`, `chatgptPlanContracts.test.ts` (L0).
- Adapter matrix: `adapterKind.test.ts` (AC1 matrix :51-66, host :108-113, `ADAPTER_KINDS` :103), `hostBrain.test.ts` (also `resolveTurnMode`).
- Brain chip/active brain: `activeBrain.test.ts`, `brainChip.test.tsx`, `demoCallout.test.tsx`, `demoTurnProvenance.test.tsx`, `brainFollowsRevision.test.tsx`.
- Transport/builder: `byokTransport.test.ts` (F15 :43), `appTransportRoundTrips.test.ts`, `runtimeContractTransport.test.ts`, `useBuilderChat.test.tsx`, `useBuilderChatLanes.test.tsx`, `builderObservability.test.tsx`.
- Pins: `appModel.test.ts` (:63 local inherits global model), `appProviderPin.test.ts`, `appModelRouting.test.ts` (AC6a–AC10; :273 subscription), `appModelSelector.test.tsx`, `builderModelSelect.test.tsx`.
- Inferrer: `inferenceAdapterLadder.test.ts` (:155-178).
- Egress: `accessEgress.test.ts` (:144 `readerAdapterKind`, :564 `chatBrainRoute`, :583 `chatDoorOpen`); `railChatFetch.test.tsx`, `chatSharedRouting.test.tsx`, `chatCrossAppTurn.test.tsx`.
- Scheduler: `scheduleAppThink.test.ts` (:440, :855-), `scheduleExecutors.test.ts` (:464-484, :593), `appAgent.test.ts` (:394 F15, :570 J3), `scheduleEditor.test.tsx`, `enableConsent.test.tsx`, `schedulerBoot.test.tsx` (:138-148 boot order, :169-209 restore).
- Inspector: `llmInspectorPanel.test.tsx` (:389 host-kit `emptyCopy` only).
- F15/openFile: `openFile.test.tsx` (:115 armed, :100 declined), `openFileRecovery.test.ts`, `syncState.test.ts`.

No direct test today: `appBrainKind`, `brainChipLabel`, `availableModes`, `metaToBrainKind`, `configFrom`, `askBrainFor`, `resolveActiveBrainFrom` (only the wrapper), `appProviderPinFor`, `ENDPOINTS_UNCONFIRMED`.
