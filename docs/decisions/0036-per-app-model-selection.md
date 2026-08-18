# 0036 — Per-app model selection

- **Status:** accepted (2026-08-18, ships with TASK-20260817-per-app-model-selector)
- **Date:** 2026-08-18
- **Task:** TASK-20260817-per-app-model-selector
- **Relates to:** ADR-0007 (single portable user DB) · ADR-0012 (prompt-caching scope) · ADR-0015 (webllm brain override) · ADR-0018 (runtime prompt contract — deliberately NOT the storage site). No existing ADR is amended.

## Context

The model was ONE global setting: `snug_settings.model`, read from `modelStore` and
applied identically to every app in every lane. Apps differ in what they need — a
data-heavy analysis app wants a frontier model, a small utility wants something cheap and
fast — and the user had no way to say so without changing the global default and
remembering to change it back.

Four host-side lanes read a model, all from that one store: the app's own runtime turns
(`agent/transport.ts`), the builder lane and the app-attached data chat (which share one
agent memo in `useBuilderChat`), and connection/contract inference
(`agent/inferrerAdapter.ts`). Any per-app notion of "which model" has to reach all of
them or it is a setting that visibly does nothing on some turns.

## Decision

**1. An app may pin a model; every app-scoped LLM call for that app routes there.**
All four lanes resolve through ONE function, `resolveModelForApp(appId)`
(`state/appModel.ts`), whose precedence is: the app's pick → the Settings default →
`undefined`. The tail is part of the contract: `undefined` means "let the provider
decide", because the adapters apply their own `ANTHROPIC_DEFAULT_MODEL` /
`OPENAI_DEFAULT_MODEL` when `options.model` is absent — which is what an empty Settings
model field has always meant. Substituting a hardcoded id at this altitude would move
that decision out of the adapter layer and silently change behavior for every existing
user who left the field blank.

**2. Inheriting is an ABSENCE, not a copy.** An app that has never been picked-for stores
no row, so a later change to the Settings default reaches it. The rejected alternative —
copying the default into each app on first open — would freeze every app at whatever the
default happened to be the first time it was opened, and would make "pinned" and
"inherited" indistinguishable on screen and in the file. The selector renders the
inherited default as a labelled option, so the state is visible and reversible.

**3. Resolution happens PER SEND, never at construction.** RunView memoizes its
transport and `useBuilderChat` memoizes its agent, so a value read once would freeze the
app on whatever was chosen when the view mounted; a mid-session switch would appear to do
nothing until a reload. This is the same rule `transport.ts` already documents for the
runtime contract and the brain, applied to one more value.

**4. The brain override still wins, and the control says so by absence.** Under the
webllm/demo brain (ADR-0015) the configured mode is overridden entirely and the engine
loads its own pinned model; `mock` is the demo brain and names no model. In those states
the selector renders nothing rather than offering a choice that cannot route.

## D1 — The model does NOT ride `RuntimeContract`

**Rejected.** An early read of the code suggested the natural home was a `model` field on
`packages/protocol`'s `RuntimeContract` (ADR-0018), since that structure is already
per-app and version-pinned. Three reasons against, any one sufficient:

- **It is a user preference, not app-declared config.** The contract describes what the
  APP needs to run. Which model the USER wants to pay for is a host-side setting, in the
  same family as `mode`, `provider` and the global `model`.
- **It would be version-linked by construction** — the contract is copied forward on
  edits and restored from the TARGET version on revert, so reverting an app's code would
  silently revert the user's model choice. That is a surprising coupling with no upside.
- **It would escalate the task to High tier** (`packages/protocol` schemas are the public
  spec, C3), owe a spec-sync step and a spec-changelog entry, and export/import as app
  content — carrying one user's model preference into another user's file.

## D2 — Storage is `snug_settings['appModel:<appId>']`, not a column

**Accepted.** `snug_settings` is already a free-form KV holding hub-level keys. A
namespaced per-app key needs **no `USERDB_SCHEMA_VERSION` bump, no migration, and no
spec-changelog entry**; the alternatives (a nullable `snug_apps.model` column, or a new
`snug_app_*` table) each cost a v7 migration and High-tier review for one string.

The key shape lives in ONE module, `packages/db/src/userdb/app-settings-keys.ts`, mirroring
the `auth-secrets.ts` precedent, and the DB exposes typed `listAppModels()` /
`setAppModel()` accessors so no caller hand-rolls a prefix scan over a shared namespace
(a loose `startsWith` would read the global `model`/`mode`/`provider` rows as app ids).

**The price is a cascade obligation.** `snug_settings` is not app-keyed, so `deleteApp`
cannot sweep it by `app_id` — the key is deleted explicitly at step 3c, an EQUALITY match
(there is exactly one row per app, so no `LIKE` escaping and no over-match against a
sibling id). This is the same shape as step 3b's `auth:<appId>:*` prefix delete, and the
delete-app suite's own header states why it must be explicit: there are zero foreign keys
in the user DB, so "cascade" is entirely hand-written and a missed table is a silent
orphan. It is pinned by a mutation-checked test.

## D3 — A model id does not join the F15 confirm gate

**Accepted.** F15 refuses byok/local turns after an import or first sync pull until the
user re-confirms endpoint settings, because an imported DB carries **executable endpoint
config**. A model id names a model AT an endpoint the user has already confirmed, so it
hydrates with the other settings and does not arm the gate. Revisit if a future provider
makes the model id itself address-bearing.

## Consequences

- Picks ride the portable file: they sync and export like `mode`/`provider`/`model`, and
  travel between web and desktop. No secret is involved.
- **Prompt caching (ADR-0012):** an app on a non-default model gets its own cache lineage,
  so cache-hit % dips right after a switch. Expected, not a regression — worth stating so
  the observability reading is not misread.
- **The builder lane is in scope** (owner decision): a weak model chosen for an app will
  also author that app's edits. The mitigation is honesty rather than restriction — the
  selector sits on the app's own header, where the user can see which model is authoring.
- The catalog is pinned and will go stale as providers ship models. Accepted: Settings
  keeps its free-text field for unlisted ids, and an already-stored id that falls out of
  the catalog still resolves and is still SHOWN, so a pruned entry can never silently
  re-route an app.

## Residual

`liveInferenceAdapter` now takes an optional `appId`, and the two call sites that have one
(the intent classifier and runtime-contract synthesis) pass it. The **connection**
requirement inferrer does not: `RunConnectionRequirementInferenceInput` carries
`providerName`/`slot` but no app id, because that inference runs at build time before an
app id is settled. Threading one would change that input contract and its callers, which
is beyond this task; it resolves to the Settings default today, exactly as before. Queued
in `next-steps.md`.
