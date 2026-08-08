# TASK-20260807-connection-reachability: a chat-less app can never become a connected app

- **Status**: active — **Gate 2 in progress** (owner green light 2026-08-08; posture + direction C ratified — see journal)
- **Owner**: Claude (orchestrator), taken over 2026-08-08 on owner instruction via /pickup
- **Branch**: `feat/TASK-20260807-connection-reachability`
- **Risk tier**: **High** — protocol surface (announce or equivalent), the auth/wizard trust ladder, and the host-side spec-write path. Any design here decides who may propose a connection.
- **Packages likely touched**: `packages/protocol`, `packages/sdk` (BOTH faces — embedded + typed), `packages/auth`, `packages/db`, `apps/playground`, `examples/`, `packages/knowledge`
- **Spec impact**: likely YES (additive) — and it must respect the publication line: `app-announce.json` IS in the published `SOURCES` (`packages/protocol/src/json-schemas.ts:16`) while the whole auth surface is deliberately OUT until Beta exit (`auth-schema.ts:10–19`). That tension is a design input, not an afterthought.
- **Related**: raised by **AL-09** (`TASK-20260807-starters-auth-spectrum` — see its §Security review verdict and §Owner decision needed; the owner chose option **C**, park AL-09 and promote this gap) · AL-04 (wizard, directive contract, B2 ladder) · AL-05 fold (queued the sibling "second provider stranded with no CTA" case to AL-10/AL-11) · ADR-0014 (custody)

## The gap (verified at source, 2026-08-07)

**A connection can only be created by a build conversation.** The only non-test `putAuthSpec` call is inside the wizard (`apps/playground/src/state/wizard.ts:328`), and every path that opens a wizard session needs one of:

- a **directive** — `RunView.tsx:485` / `BuilderView.tsx:141`, mounted from persisted chat history, so it needs a build conversation;
- an **existing row** — `SettingsView.tsx:471` renders from `db.listAuthSpecs()`; with no row the surface reads *"no connections yet — an app declares one when it needs an API."*;
- a **net-error CTA** — `RunView.tsx:501`; it opens, but over no row and no proposal, so the user faces an empty manual review where they must hand-type the provider and every hostname.

Consequences for any app that ships without a chat thread — starter apps (by AL-08 design), imported HTML, a hand-authored app, anything installed rather than built:

- read-only starter: `net: undefined` (`RunView.tsx:226–236`) and no chat rail (`:416`) — it cannot even attempt a connected call;
- installed copy: real net handler, but no row ⇒ `NET_NOT_APPROVED` at Gate 3 (`packages/auth/src/connected-fetch.ts:298`) ⇒ CTA fires ⇒ **empty wizard**.

Nothing here is broken code. Three separately-correct decisions — AL-08's chat-less starters, AL-04's directive-only proposals, and the wizard's row-or-proposal review model — compose into a dead end nobody had hit, because AL-08's starters were all keyless and AL-04's wizard was always driven from the builder.

**Correction to an earlier diagnosis (AL-09 D7):** a fresh installed app yields `NET_NOT_APPROVED`, never `NET_HOST_BLOCKED` — the host-ceiling gate is Gate 4 (`:324`) and is reachable only *after* a row exists and is approved. The CTA path is open; what is missing is a reviewable proposal behind it. M12's off-ceiling silence is a separate, correct guard and is not implicated.

## Prior art in this repo: one design was already tried and FAILED review

AL-09 v3 proposed a **starter-declared connection seam**: apps declare `authRequired {providerName, kind, declaredApiHosts?}` in their announce frame; the host, for an installed app with no row, runs the registry ladder and seeds an `unapproved` spec. A 3-lens fresh-context security review of that design (before any code) returned **3 BLOCKERs + 9 MAJORs confirmed**, every load-bearing claim re-derived at source. **Read AL-09's §Security review verdict in full before designing anything here** — these are the constraints any future design must satisfy, not just one rejected proposal's bugs:

1. **"Registry hit discards declared hosts" does not exist for static kinds.** The registry-host fallback lives only in the `oauth2_auth_code` branch (`params-to-auth-spec.ts:181`); `bearer_token`/`basic_auth`/`api_key`/`oauth2_client_creds` take hosts solely from `requireDeclaredHosts()` (`:97`), and `provider.name` falls back to the raw caller string (`:65`). The shipped B2 protection is structurally OAuth-coupled — `resolveWizardIntent` hard-codes `kindHint:'oauth2_auth_code'` on every registry hit (`wizard.ts:241–248`). **Any "the registry protects us" claim must be re-proven per kind.**
2. **Registry rung vs. declared static kind is unsatisfiable as posed** (a GitHub PAT declaring `bearer_token` against a registry that is structurally OAuth-only).
3. **Bounds are not inherited for free.** `authRequiredPayloadSchema` is unbounded (`render-directive.ts:124–128`); `llmProposalSchema` keeps AL-04's `.max()` bounds because `.omit` preserves validators. Reusing the payload "verbatim" *widens* the trust surface.
4. **Trust-ladder parity is the crux.** A directive registry-miss gets `provenance:'inference'` ⇒ forced field-by-field `spec_confirm` + the "it is a guess, not an authority" warning; a row-review session carries no provenance (`wizard.ts:270`) ⇒ light approve-as-is (`AuthWizardSheet.tsx:187`). Any new proposal channel must land in the ladder *explicitly* (an `app_declared` provenance forcing the strong review is the obvious candidate), never by default into the light path.
5. **Identity/display integrity:** `normalizeProviderKey` strips non-`[a-z0-9]`, so confusables (`ѕpotify` → `potify`) miss the registry while the attacker's string becomes the display name; both `providerName` fields are bare `z.string()`.
6. **Fail-open on unapproved rows:** `putAuthSpec` silently full-`UPDATE`s spec+hosts for an existing non-approved row (`packages/db/src/userdb/userdb.ts:1439–1443`), and `approveAuthSpec` re-derives the union from the LIVE row — so "first-wins" must be an enforced invariant, not a call-site convention.
7. **Revoke must stay terminal:** revoke is `clearApp` + `deleteAuthSpec` with no tombstone (`:1490–1493`) and the app stays installed, so any re-declaration channel silently reverses the user's revoke unless a tombstone exists.
8. **Frame-level failure modes:** a strict inner payload on the lenient announce frame makes any malformed value a whole-frame MALFORMED (`frames.ts:277–285`); announce is not answerable (`host.ts:575–586`) and MALFORMED frames bypass `onFrame`, so an app would silently lose its display identity with no diagnostic.
9. **Publication line:** regenerating `app-announce.json` drags a Beta-gated auth shape into the published normative schema set, and `z.strictObject` conflicts with the documented R2 forward-compat rule for published artifacts.
10. **Two SDK faces:** `packages/sdk/src/hooks.ts:34–41` (typed) and `packages/sdk/embedded/snug-hooks.js` both post announce; `SnugAppMeta` (`types.ts:4–13`) cannot express new fields, and the contract suite's `toMatchObject` lets the faces drift silently green.

## Design directions (none chosen — this is Gate 1)

Sketched only so the next session does not restart from zero. Each needs its own Gate-2 plan + fresh-context security review:

- **A — app-declared proposal, hardened.** The AL-09 seam with every finding above designed against: bounded payload mirroring the AL-04 hint bounds, an explicit `app_declared` provenance that forces the SAME strong review as inference, no registry rung for declarations (or registry resolution only on exact-kind match), a revoke tombstone, parse-and-drop instead of whole-frame MALFORMED, and the published-schema question settled before any regen.
- **B — user-initiated connection from Settings.** Add "add a connection" to Settings so the *user* (never the app) proposes: pick provider → the existing registry/inference ladder runs → wizard. No app-authored channel at all, so most of the threat surface above evaporates; costs the app the ability to say what it needs, and the user must know the provider.
- **C — install-time declaration with explicit consent.** The declaration travels with the install act (a starter's manifest / an import's review sheet) rather than a runtime frame, so it is reviewed once, at a moment the user is already deciding to trust the app — and there is no re-announce/re-seed channel at all.
- **D — a seeded bootstrap thread for chat-less apps.** AL-08 already queued "starter ships a pre-seeded build conversation" as an owner call. If a starter carried a real bootstrap turn, the *existing* directive path would work unchanged and no new trust channel is created — possibly the smallest true fix, at the cost of manufacturing chat history.

**Cross-cutting question for whichever direction wins:** should a connection proposal ever be *app*-authored at all, or is the honest 1.0 answer that only the user (Settings) or the builder LLM (directive, reviewed) may propose one? That is a product-posture call as much as a security one.

## Out of scope

The AL-05 fold's separately-queued "second provider stranded with no CTA" case (AL-10/AL-11) · the keyless (`none`) credential kind (AL-12/post-alpha) · the URL-borne credential channel (AL-10/AL-11) · AL-09's starters themselves · an imported-HTML-app declaration channel (**no HTML-import flow exists in the product at all** — "import" is whole-`.sqlite` import only, verified 2026-08-08; when an app-import flow is built, its review sheet adopts this task's declaration pattern and inherits the full constraint list, esp. confusables #5 and bounds #3).

## Security review of plan v1 — REVISE (2026-08-08, 3 lenses, 20 agents, refute-first)

3-lens fresh-context review of the DESIGN before any code (`wf_46da5ab7-695`; trust-boundary / fail-closed / blast-radius). **17 findings; 15 CONFIRMED (8 MAJOR, 7 MINOR — one MAJOR downgraded on verification), 2 REFUTED, 0 unverified.** **No BLOCKER: the ratified posture survives** — the reviewers independently confirmed 20 soundness properties including bounds/poison inheritance via `.omit`, the no-registry resolver, wizard-only writes, revoke terminality, the publication line, and that no frame/SDK/published artifact is touched. Every load-bearing claim below was **re-derived at source by the orchestrator**, not taken on the reviewers' word. Plan v2 folds all 15.

**The eight MAJORs (each sinks part of v1 as written):**

1. **`install_source` is not evidence of an install act.** It is a plain TEXT column (`userdb-schema.ts:161`) and `importUserDb` swaps the DB wholesale, reconciling ONLY `snug_auth_specs` (`userdb.ts:432–484`, `:1749`) — `apps` rows land verbatim from attacker bytes. A crafted `.sqlite` with `install_source:'starter:my-repos'` + arbitrary HTML would inherit the first-party manifest's identity, and the wizard would attest an install act that never happened — laundering a credential grab through the host's own trusted voice, where a seeded row would at least have shown "imported — needs re-approval".
2. **`app_declared` is not session-sticky.** `applyInferenceResult` overwrites the LIVE session's provenance (`wizard.ts:555–577`) and the inferrer's rung 1 returns `'registry'` for any registry-name hit *before any model call* (`auth-spec-inferrer.ts:106–125`). The `spec_confirm` branch itself renders an "infer from docs" button (`AuthWizardSheet.tsx:442`) — **one click flips a declaration session to the LIGHT approve-as-is path and the "not verified" warning vanishes.** T3/T5 as written pin only resolve-time and render-time, so they stay green while the invariant dies at runtime.
3. *(same defect, fail-closed lens)* For a declared **static** kind + registry name (`github`+`bearer_token`), the same click also strands the session: the registry rung's proposal is `{providerName, kindHint}` only, so `declaredApiHosts` are erased and `paramsToAuthSpec` fails (`params-to-auth-spec.ts:101–104`).
4. **The glob cannot deliver parse-and-drop as specified.** Without options `import.meta.glob` returns lazy promise loaders (so a *sync* resolver cannot exist); with `eager:true` a malformed `connection.json` becomes a build/module-graph error in a module `RunView.tsx:29` imports — **taking down the entire playground**, the exact whole-surface failure constraint #8 exists to prevent.
5. **`openWizardForNetError` needs async DB state.** Both new inputs are async (row check via `getUserDb`; `install_source` lives in the apps table and the caller passes only `appId`), but the function is sync and its call site consumes the boolean (`RunView.tsx:499–503`) — a naive `async` conversion makes the Promise always truthy, **dismissing the CTA even when the wizard refuses to open** (parked-session refusal, `wizard.ts:259–262`).
6. **T8 proves the Settings path, not the headline gap.** Disposition #11 pins "no network call is made", so `NET_NOT_APPROVED` can never fire in the e2e and the CTA→prefilled-wizard integration — the very seam finding 5 breaks — is covered by no test above unit level.
7. **`connection-demo` cannot be both validated and connected.** The validate suite's no-network rule regex matches `net.fetch(` in app-authored code (`\b` sits between `.` and `fetch`), so the demo either goes red in `APPS`, or ships unvalidated.
8. **Widening `AUTH_PROVENANCES` leaks into the persisted, LLM-claimable directive schema** (`render-directive.ts:109`): a builder directive could then claim `provenance:'app_declared'` (today strict-rejected), and chat meta carrying the new literal reads as *no directive at all* on an older host.

**The seven MINORs:** (9/11) disposition #7's parenthetical "nothing app-timed exists" is **false** — the CTA is fired by the app's own net attempt, so post-revoke an app can re-summon a one-click prefilled re-connect sheet on its own cadence (the terminality invariant itself holds; the rationale was wrong). (10) the validate rule has **no build path to `llmProposalSchema`** — `examples/` has no protocol dependency and no build step, so the gate can silently not run. (12) "consented at install" is **unbound**: the manifest resolves from the *current bundle* at every wizard open while the app HTML froze at install, so a later deploy re-proposes different hosts under the same install identity. (13) shelf blast radius incomplete: `starterShelf.test.tsx:86` pins exactly 8 starters, `STARTER_LOOKS` has no row (silent ⬡ fallback), and **AL-09's parked branch pins 13 ids** — a 9-starter main makes those literals stale at resume. (14) disposition #2 was factually wrong: registry effects on a declared proposal are three, not one (display name, registration walkthrough, and for oauth2 the manifest's endpoints/hosts WIN — the inverse of the directive channel's discard). (15) the shipped KB still teaches the directive "is the only way an app ever becomes connected" — falsified by this release, and AL-09's own bar makes that a defect at resume.

**Two REFUTED — recorded so they are not re-litigated:** (a) "the validate suite can't catch registry-name/foreign-host manifests" — misreads disposition #5, whose load-bearing control is human PR curation; the suite is only ever claimed to enforce bounds + poison keys. (b) "HubView installs with zero disclosure" — `installStarter` (`HubView.tsx:119–139`) is **dead code**; per AC18 the tile only browses, and the sole install path is RunView's button, exactly where v1 puts the disclosure.

## Plan v1 (Gate 2, 2026-08-08) — direction C: install-time declaration, resolved not persisted

> **SUPERSEDED by plan v2 below (2026-08-08).** Kept for the audit trail: the review's findings are only legible against the design they attacked. Where v1 and v2 conflict, **v2 wins**.

### Design in one paragraph

A **connected starter carries a declaration file in its example folder** (`examples/<folder>/connection.json`), validated against the SAME bounded schema as LLM proposals (`llmProposalSchema` — reused directly, not copied; it already omits the poison surfaces: registration copy, `headerTemplate`, credential `fields`). The declaration is **never persisted anywhere** — it is resolved on demand from the app's existing `install_source` (`starter:<folder>`, unique-indexed, already the single source of install identity) back to the in-repo manifest. The wizard gains a third open-request variant `{ source: 'declaration', appId, declaration }` whose session carries a NEW host-computed provenance **`app_declared`** that forces the SAME field-by-field `spec_confirm` strong review as `inference` (`AuthWizardSheet.tsx:187` gains one disjunct) with its own honest copy ("declared by this app — not verified"). `putAuthSpec` remains wizard-only on explicit user approval; no row, no seed, no schema change, no migration, no announce-frame change, no SDK change, no published-artifact regen. Constraints #3/#6/#7/#8/#9/#10/#11 are eliminated structurally (nothing is persisted, no runtime channel exists, no published schema is touched); #1/#2/#4/#5 are designed against explicitly (below).

### The trust ladder after this task (posture, ratified 2026-08-08)

| Proposer | Channel | Review |
|---|---|---|
| user | Settings row / empty-wizard CTA | manual entry (unchanged) |
| builder LLM (reviewed) | directive → `resolveWizardIntent` | registry rung light / inference strong (unchanged) |
| **install act** (NEW) | starter manifest → `resolveDeclaredIntent` | **always strong (`app_declared` ⇒ `spec_confirm`)** |
| app at runtime | — | **does not exist, by owner decision** |

### Constraint-by-constraint disposition (the 12 from §Prior art)

1. **Registry-hit host discard doesn't exist for static kinds** → `resolveDeclaredIntent` NEVER consults the registry and NEVER emits `registry` provenance — the declared kind and declared hosts go to the transformer as-is; `paramsToAuthSpec`'s per-kind rules (static ⇒ `requireDeclaredHosts`, oauth2 ⇒ registry endpoint/host fallback) apply unchanged. No "registry protects us" claim is made for any kind.
2. **Registry rung vs. declared static kind unsatisfiable** → dissolved: there is no registry rung for declarations. `my-repos` (github + `bearer_token` + `api.github.com`) flows as declared; the only registry effect is the transformer's display-name borrow, acceptable for REPO-CURATED manifests (see #5).
3. **Bounds not inherited for free** → the manifest validates against `llmProposalSchema` itself (strict, bounded: `providerName.max(120)`, hosts `max(253)/max(32)`). No new schema, no new bounds to derive, poison keys strict-rejected.
4. **Trust-ladder parity** → `app_declared` joins `inference`/`user_docs` in the FORCED `spec_confirm` branch. Mutation test: removing the disjunct goes red.
5. **Confusables** → residual risk accepted THIS task because every manifest is first-party, in-repo, PR-reviewed content (validate suite gates it); the moment any untrusted channel (app import) adopts this pattern, a charset guard becomes a BLOCKER — recorded in next-steps with this constraint cited.
6. **`putAuthSpec` fails open on unapproved rows** → not triggered: this task never calls `putAuthSpec` outside the wizard and never creates rows. The underlying db asymmetry stays queued (AL-10, already in next-steps 2026-08-07).
7. **Revoke terminality** → structurally preserved: revoke still deletes the row and nothing re-creates it without a fresh, user-initiated, strongly-reviewed wizard approval. Settings/CTA re-OFFERING the declaration after revoke is disclosure, not reversal (nothing app-timed exists). Negative test pins: declaration present + revoke ⇒ `listAuthSpecs()` stays empty until a user approves again.
8. **Whole-frame MALFORMED** → no frame is touched.
9. **Publication line** → nothing published is regenerated; `AUTH_PROVENANCES` lives in `render-directive.ts` (Beta-gated internal surface, snapshot-pinned); spec-changelog gets an internal-draft entry per SPEC_SYNC.
10. **Two SDK faces** → neither face changes.
11. *(AL-09 v3's AC7 stub contradiction)* → this task's e2e proves REACHABILITY (install → prefilled strong review → approve → frozen row → revoke), not live injection; the fixture declares `api.example.com` and no network call is made (Gate-3 errors fire before any fetch). Live injection stays proven by AL-03/AL-04 suites and AL-09's AC7 when it resumes.
12. *(D7 correction)* → carried: the CTA fires on `NET_NOT_APPROVED` (Gate 3); this task makes the wizard behind it PREFILLED instead of empty.

### Mechanism (files to touch, with anchors)

1. **`packages/protocol/src/render-directive.ts`** — add `'app_declared'` to `AUTH_PROVENANCES` (`:43`); doc comment gains the install-act rung. Snapshot/pin tests updated in-package. **SPEC_SYNC applies (internal draft); spec-changelog entry.**
2. **`apps/playground/src/starter/starterApps.ts`** — add `import.meta.glob('../../../../examples/*/connection.json')`; new `starterDeclarationFor(installSource: string): LlmProposal | null` — parses `install_source`, looks up the manifest, validates with `llmProposalSchema` (strict; invalid ⇒ `null` + console warn, NEVER a throw — a bad manifest must not break install/run: parse-and-drop, the anti-#8 posture).
3. **`apps/playground/src/state/wizard.ts`** — third union variant `{ source: 'declaration'; appId: string; declaration: LlmProposal }` (`:219–221`); `resolveDeclaredIntent(appId, declaration): WizardSession` → `{ appId, source: 'declaration', mode: 'connect', provenance: 'app_declared', proposal: declaration, evidence: [] }` (NO registry consult — contrast `resolveWizardIntent:231–255`); `openWizardForNetError` (`:667–671`): when mode is `'connect'` and the app has a declaration and NO existing row, open the declaration variant instead of the empty `error_cta` session (`reapprove` path unchanged).
4. **`apps/playground/src/connections/AuthWizardSheet.tsx`** — `:187` gains `|| session.provenance === 'app_declared'`; review-step copy branch: "this connection was declared by the app when you installed it — it is a claim, not a verified fact; review every field."
5. **`apps/playground/src/views/SettingsView.tsx`** — `ConnectionsCard` additionally lists installed apps having a declaration but no `snug_auth_specs` row as "declared — not connected" with a connect button → declaration variant; empty-state hint (`:452–453`) updated to stop saying declarations don't exist.
6. **`apps/playground/src/run/RunView.tsx`** — install affordance (`:560–570`) gains a one-line disclosure when the starter declares a connection: "connects to {provider} ({hosts}) — you approve before anything is sent"; no blocking sheet (consent lives in the wizard, where it is strong).
7. **`examples/connection-demo/`** — a minimal, honest, shippable example app that declares `{providerName: 'Example API', kindHint: 'api_key', declaredApiHosts: ['api.example.com']}` — the walking-skeleton proof vehicle and the shelf's first visibly-connected starter pattern. `examples/validate.test.mjs` gains the manifest rule: every `connection.json` validates against `llmProposalSchema` (via the built protocol package), and folders WITHOUT one are exempt.
8. **Docs**: architecture/code-map counts; next-steps rows (confusable-guard blocker-on-import #5; AL-09 note that the five starters add manifests on resume); spec-changelog.

### Test plan (TDD, red-first; mutation row per guard)

- **T1** (validate) `connection.json` schema rule: valid manifest passes; poison key (`headerTemplate`) manifest REJECTED; oversized `providerName` REJECTED. *(constraint #3)*
- **T2** (unit, starterApps) `starterDeclarationFor`: resolves for `starter:connection-demo`; `null` for non-starter sources, unknown folders, and INVALID manifests (parse-and-drop, no throw). *(anti-#8)*
- **T3** (unit, wizard) `resolveDeclaredIntent`: provenance is ALWAYS `app_declared` — including for a registry-hit name (`github` + `bearer_token` keeps the declared kind; never `registry` provenance, never an oauth2 kindHint swap). Mutation: reintroduce the `resolveWizardIntent` registry branch ⇒ red. *(constraints #1/#2)*
- **T4** (unit, wizard) `openWizardForNetError` prefill: `NET_NOT_APPROVED` + declaration + no row ⇒ declaration session; with an existing row ⇒ unchanged `error_cta`; `NET_IMPORTED_UNAPPROVED` ⇒ unchanged `reapprove`. *(#12)*
- **T5** (component, AuthWizardSheet) `app_declared` ⇒ `spec_confirm` forced + the declared-by-app copy visible. Mutation: drop the disjunct ⇒ red. *(constraint #4)*
- **T6** (component, SettingsView) declared-but-unconnected row renders + opens the declaration session; after approval it becomes a normal row; empty-state copy updated.
- **T7** (negative, db-level) declaration present + revoke ⇒ `listAuthSpecs()` empty, credentials cleared, and NOTHING recreates a row without a wizard approval. *(constraint #7)*
- **T8** (e2e, Playwright, default chromium project) the walking skeleton: shelf → open `connection-demo` → install (disclosure visible) → trigger connect (Settings path) → PREFILLED strong review → approve → Settings shows approved row with frozen `api.example.com` → revoke → declared-not-connected again. No network leaves the page.
- **T9** (negative, C1) the declaration path never renders/accepts credential values before the wizard's credentials step; manifest cannot define `fields` (poison omit) — covered by T1 + existing wizard suites; asserted explicitly.

### Sequencing

Walking skeleton FIRST (protocol constant → resolver → wizard variant → sheet branch → T8 skeleton red→green), then breadth (Settings surface, disclosure, negative tests). If the skeleton stalls on a structural surprise, STOP and re-plan before breadth — the AL-09 lesson.

### Shared literals pinned (fan-out rule)

Manifest filename **`connection.json`** · wizard source **`'declaration'`** · provenance **`'app_declared'`** · example folder **`connection-demo`** · testids **`starter-install-disclosure`**, **`connection-declared-row`**, existing `starter-install` / `net-auth-cta` unchanged · declared fixture host **`api.example.com`**.

### Packages touched (TDD.md table)

`packages/protocol` (constant + tests; High) · `apps/playground` (wizard/sheet/settings/run/starter; High by escalation) · `examples` (fixture + validate rule; Low). **NOT touched:** `packages/auth`, `packages/db`, `packages/sdk`, `packages/runner`, `apps/server`, `packages/knowledge` (KB doctrine note deferred to AL-09 resume — recorded in next-steps).

---

## Plan v2 (2026-08-08) — the review folded; THIS is the plan of record

Five structural changes answer the eight MAJORs; the rest are pinned as named guards. **The ratified posture is unchanged** (no runtime app channel; install-act declarations always get the strong review) — v2 changes the *mechanism*, not the posture.

### V2-1 — Provenance is DERIVED, not stored on the session (kills MAJORs 2+3, MINOR 14 residue)

The v1 error was treating provenance as session state that any later step could overwrite. In v2 the declaration is a **separate, immutable session field** — `declaration: LlmProposal` — set only at open by `resolveDeclaredIntent` and **never written by `applyInferenceResult`** (which keeps overwriting `provenance`/`proposal` exactly as today, untouched). The sheet's strong-review gate becomes:

```ts
const specConfirm = session.declaration !== undefined
  || session.provenance === 'inference' || session.provenance === 'user_docs';
```

so **no mid-session action can reach the light path** — inference on a declaration session still renders the strong review, now showing both "declared by this app" and whatever the inferrer returned. `app_declared` is thus **not** a new `AUTH_PROVENANCES` member (this also kills MAJOR 8 outright: the persisted directive enum is untouched, no forward-compat break, no LLM-claimable literal, and mechanism step 1 disappears — **`packages/protocol` is no longer touched at all, so SPEC_SYNC and the spec-changelog no longer apply**). Provenance on a declaration session starts `undefined` and is display-derived.
**Guards:** T3 (open-time), **T3b — mid-session mutation: run inference on a declaration session, assert `specConfirm` stays true and the declared-by-app copy stays visible** (mutation: drop the `session.declaration` disjunct ⇒ red), **T3c — static-kind strand: `github`+`bearer_token` declaration + infer-from-docs ⇒ declared hosts still present in the reviewed draft.**

### V2-2 — Trust the FROZEN app HTML, not `install_source` (kills MAJOR 1, MINOR 12)

`install_source` is attacker-writable via whole-DB import, so it can never be the sole key to a first-party declaration. v2 requires **both**:

1. the app's `install_source` resolves to a bundled manifest, **and**
2. the **installed HTML byte-matches the bundled starter HTML** for that folder (`loadStarterHtml(folder)`), compared against the app's **pinned factory version 1** (`snug_app_versions`, written at install — `userdb.ts:1110`), never the mutable current version.

An imported row with attacker HTML fails (2); an app the user has since edited fails (2) and correctly falls back to today's empty-wizard behavior. This also binds MINOR 12: a later deploy that changes a starter's HTML *or* manifest stops matching, so the declaration silently withdraws rather than re-proposing new hosts under an old consent. **Copy is corrected to what is actually proven** — "this app ships with a declared connection to {provider}", never "you approved this at install".
**Guards:** **T2b — byte-mismatch (one changed byte in the stored HTML) ⇒ `null`**; **T2c — imported-app simulation: an `apps` row with a starter `install_source` but foreign HTML ⇒ `null`, and Settings does NOT list it as declared** (mutation: drop the HTML check ⇒ red). **T2d — the comparison reads version 1, not `current_version`.**

### V2-3 — Async resolver, async open, explicit call-site rework (kills MAJORs 4+5)

- `import.meta.glob('../../../../examples/*/connection.json', { query: '?raw', import: 'default' })` — **raw strings, lazy loaders**, matching the existing `app.html` pattern. Raw import means Vite never JSON-parses at transform time, so **a malformed manifest can never break the build**; `starterDeclarationFor` becomes **async**, does its own `JSON.parse` in a try/catch, then `llmProposalSchema.safeParse` — invalid ⇒ `null` + one `console.warn`. True parse-and-drop.
- `openWizardForNetError` becomes **`async`** and its call site is reworked in the same commit: `void openWizardForNetError(...).then((opened) => { if (opened) setNetAuthError(null) })` — the CTA is dismissed **only** on a real open, so a parked-session refusal keeps the banner. The declaration lookup needs the app record; `RunView` already has `appId` and gains one `db.getApp(appId)` read inside the async path.
**Guards:** **T2e — malformed JSON manifest ⇒ resolver returns `null` AND the shelf/run view still render** (the anti-#8 whole-surface proof); **T4b — parked-session refusal: `openWizardForNetError` resolves `false` and the CTA stays mounted** (mutation: return the raw promise ⇒ red).

### V2-4 — The e2e proves the CTA gap, not a detour (kills MAJOR 6, MAJOR 7)

`connection-demo` **does** attempt a connected call — that is the point — so:
- it goes in `examples/validate.test.mjs` `APPS` and the **no-network rule is satisfied honestly**: the app calls `net.fetch(...)` **inside the hooks block region** (the governed seam the AL-04 repair already exempts), with the app-authored region free of network APIs. If authoring cannot keep the call inside the exempt region, the rule is **not** weakened — the demo instead uses the existing `useConnectedFetch` handle pattern verbatim, and if that still trips the rule the finding is escalated to the owner rather than patched around.
- **T8 is re-pointed at the real gap**: install → app's own call → `NET_NOT_APPROVED` → **CTA banner** → click → **PREFILLED strong review** → approve → frozen row → revoke → declared-not-connected. The Settings path becomes **T8b** (second, cheaper assertion), not the headline. This exercises the sync/async seam of V2-3 end-to-end.

### V2-5 — Post-revoke re-offer is rate-limited by honesty, not silence (folds MINORs 9/11)

The terminality invariant holds (verified sound), but v1's rationale was wrong: the CTA *is* app-timed. v2 does **not** add a tombstone (that stays queued for AL-10 as already recorded) and does not let the app's cadence drive a prefilled sheet either. Instead: **the prefilled declaration upgrade applies only when the app has never had a row in this session's lifetime**; once the user revokes, subsequent CTAs for that app open the **plain** (unprefilled) wizard until the user initiates from Settings. Cheap, needs no schema, and makes the app's retry loop strictly less useful than the user's own click.
**Guard:** **T7b — revoke, then re-fire `NET_NOT_APPROVED` ⇒ the wizard opens WITHOUT the declaration prefilled** (mutation: drop the check ⇒ red).

### V2-6 — The named small folds

- **MINOR 10** — `examples/package.json` gains a workspace dependency on `@snugprotocol/protocol` and the manifest rule imports it directly; **the rule must fail loudly if the import fails** (no graceful-degrade try/catch — a curation gate that can silently skip is not a gate). Pinned by a self-check test.
- **MINOR 13** — the shelf fold is explicit: bump `starterShelf.test.tsx`'s count pin to 9, add a `STARTER_LOOKS` row for `connection-demo` **and extend the look-coverage loop to cover it** (so the ⬡ fallback cannot ship silently), update `code-map` counts. **AL-09 collision recorded in ITS task file too**: on resume its `APPS` 8→13 and 13-id pins become 9→14 and 14 ids.
- **MINOR 14** — disposition #2 corrected in place: registry effects on a declared proposal are **three** (display name, registration walkthrough, and for `oauth2_auth_code` the manifest's endpoints/hosts WIN over the registry's — the inverse of the directive channel's discard). Acceptable only because manifests are first-party; **stated as the precise reason an untrusted declaration channel needs a charset guard + registry-borrow ban before it can exist.**
- **MINOR 15** — the one-sentence KB amendment lands **in this task, not AL-09**: the doctrine's "the directive is the only way an app ever becomes connected" gains the install-act rung. `packages/knowledge` is therefore back in the touched set (its generator + suite run).
- **MINOR 5 (from the original 12)** — next-steps row: a charset/confusable guard on `providerName` is a **BLOCKER prerequisite** for any future untrusted declaration channel (app import), citing this review.

### Revised packages touched

`apps/playground` (High by escalation) · `packages/knowledge` (KB sentence + generator) · `examples` (fixture, validate rule, workspace dep). **NO LONGER TOUCHED: `packages/protocol`** (V2-1 removes the enum change) — so **no spec-sync, no spec-changelog, no published-artifact regen**. Still untouched: `packages/auth`, `packages/db`, `packages/sdk`, `packages/runner`, `apps/server`.

### Revised sequencing

Walking skeleton first, now proving the **CTA** path: resolver (async, raw-glob, HTML byte-match) → wizard `declaration` field + async open + call-site rework → sheet gate → **T8 red→green**. Then breadth: Settings surface, disclosure copy, revoke rule, KB sentence, shelf/validate folds. **If the skeleton stalls on a structural surprise, STOP and re-plan** — the AL-09 lesson, which has now paid twice.

### Fidelity verification of the v2 fold — 10/15 FOLDED, and it caught a FALSE claim (2026-08-08)

An independent fresh-context verifier checked whether v2 actually disposes of all 15 findings or merely claims to. **Result: 10 FOLDED, 4 PARTIAL, 1 DISSENT-on-a-false-premise, plus 4 new risks in v2's own text.** Both structural kills were verified real at source (V2-1's separate immutable field survives `applyInferenceResult`'s spread; V2-2's factory-version-1 getter is `getAppHtml(appId, 1)`, `userdb.ts:1275–1285`, and install stores the HTML untransformed). **`packages/protocol` needing no change: verified TRUE** (`WizardSession` is playground-local, `wizard.ts:59–79`). **The raw-glob shape: verified TRUE** (identical to the shipped `app.html` pattern).

**V2-4 rests on a claim that is FALSE — orchestrator re-verified at source, the verifier is right:**

- `hookBlock` cuts everything ABOVE the section-5 banner (`validate.test.mjs:67–74`), so **app-authored code is by definition outside it** — the "put the call inside the exempt region" escape does not exist. The block is additionally byte-locked to `packages/sdk/embedded/snug-hooks.js` (`:114–116`), so nothing app-specific can be added there at all.
- **No shipped example ever CALLS `net.fetch`** — all eight only *define* `useConnectedFetch` (verified: zero call sites across `examples/*/app.html`). There is no precedent to copy.
- A connected demo trips a **second, independent rule**: every absolute URL must be on `CDN_ALLOWLIST` (`:83–89`), and `https://api.example.com/...` is not.

**Consequence: MAJOR 7 is NOT folded, and MAJOR 6's re-pointed T8 inherits the failure** — the walking skeleton has no viable demo app. Per the plan's own STOP rule (and the AL-09 lesson: never weaken a guard to make a demo convenient), this is an **owner decision, pulled to the FRONT of the sequence** — see §Owner decision needed below. No skeleton code starts before it is answered.

**Three more corrections to fold before implementation (cheap, no fork):**

- **V2-1 needs one more line (new risk C4):** `AuthWizardSheet.tsx:189–193` re-seeds the draft from `session.proposal` on every session change, so an "infer from docs" click on a declaration session still **wipes the declared hosts from the form** — `specConfirm` correctly stays strong (MAJOR 2 genuinely fixed) but the user reviews an empty-hosts draft the transformer will refuse. **Fix: `draftFromProposal` (or the re-seed effect) must fall back to `session.declaration` for hosts when the inferrer returns none.** Without it, T3c asserts an outcome no code produces.
- **V2-5's framing is overstated (B7 / new risk C2):** "never had a row in this session's lifetime" is implementable with no schema change, but nothing persists it — revoke leaves zero DB residue by design, so the control **dies on page reload** and an app that induces a refresh gets the prefilled sheet back. **It is UX friction, not a security boundary, and the plan must say so.** The real fix is the revoke tombstone, already queued to AL-10; V2-5 stands only as a speed bump with honest wording.
- **V2-2 introduces a silent-withdrawal failure mode (new risk C1):** the byte-match breaks on ordinary deploy cadence — any later edit to the starter's HTML, including a forced hooks-block resync when `snug-hooks.js` changes, makes an already-installed app stop matching. The user then hits the **empty wizard: the exact bug this task exists to fix**, with no diagnostic. **Fold: compare a NORMALIZED form (the suite's own `normalize()` precedent, `validate.test.mjs:55–60`), log the mismatch reason, and surface a Settings state ("this app's code no longer matches its starter") instead of withdrawing in silence.**
- **Two factual corrections:** `loadStarterHtml` takes a **starter id**, not a folder (`starterApps.ts:47–50`); and `starterShelf.test.tsx:86` pins no literal `8` — it derives from `ORIGINAL_FOLDERS`/`PILLAR_FOLDERS`, so the work is adding `connection-demo` to an array plus extending the look-coverage loop. Also `wizardStore.test.ts:210/225` assert a **sync** boolean from `openWizardForNetError` and must move in the same commit as V2-3. MINOR 10: with a workspace dep on protocol, `examples`' plain-node suite needs a build-ordering guarantee named (turbo `dependsOn`), or fresh clones go red. MINOR 15: the KB edit is larger than one sentence — the same file's emission rules assume a directive-closing reply a chat-less starter cannot produce, and the generated snapshot + KB suite move with it.

## Owner decision needed — the demo app vs. the validate suite (BLOCKS the skeleton)

`connection-demo` must make a real connected call for T8 to prove the CTA gap closed, but the validate suite forbids exactly that in app-authored code, and the guard is an AL-03/AL-04 security rule I will not weaken unilaterally. Four honest options:

- **(i) Extend the rule precisely** — allow a method call on the governed `useConnectedFetch` handle (`net.fetch(...)`) in app-authored code while bare/`window.`-qualified network calls stay forbidden, and allow declared hosts from the app's own `connection.json` past the CDN-allowlist check. **This is a real widening of a C2-adjacent guard and needs its own review** — but note AL-09's parked branch already carries a repair of this exact rule (13 regex cases evidenced), so the precedent and the test vehicle exist.
- **(ii) Keep the demo call-less** — T8 proves install → Settings → prefilled strong review → approve → frozen row, and the CTA path is proven only by unit tests. **Honest but it leaves MAJOR 6 standing**: the headline gap stays unproven end-to-end.
- **(iii) Exempt the demo from the suite** — a named, justified exclusion in `APPS`. Cheapest, and the worst: the one app exercising the connected path is the one nothing validates.
- **(iv) Defer the demo entirely** — land the mechanism against the five AL-09 starters when AL-09 resumes (they will declare real providers anyway), and prove the CTA path there. Costs this task its own walking skeleton.

**Orchestrator recommendation: (i), scoped narrowly and reviewed** — it is the only option that both proves the gap closed and keeps every app under validation, and it converges with AL-09's needs rather than deferring the same decision twice. **(ii) is the safe fallback** if the owner would rather not touch a security rule in this task.

### Shared literals (v2 — supersedes v1's list where they differ)

Manifest filename **`connection.json`** (raw-imported) · wizard session field **`declaration`** · example folder **`connection-demo`** · declared fixture host **`api.example.com`** · testids **`starter-install-disclosure`**, **`connection-declared-row`**, existing `starter-install` / `net-auth-cta` unchanged. **DROPPED from v1: the `'app_declared'` provenance literal and the `'declaration'` wizard `source` value** — v2 keeps `source:'error_cta'|'settings'` and carries the declaration in its own field, so no persisted discriminator changes.

## Session journal (append-only, newest last)

### 2026-08-08 — Claude (orchestrator) — /pickup; owner green light; posture ratified; Gate 2 opened

- Resumed the alpha umbrella per `/pickup` from HANDOFF #5. Baseline verified green on `main` @ `85ecd3b` (19/19 root suites; playground 409). Owner chose **"Design connection-reachability"** from the held options; branch cut off main.
- **All 12 constraint anchors re-verified at source by the orchestrator** before any design work — every citation in §Prior art holds on current main (docs-only merges since verification).
- **OWNER DECISION (2026-08-08): the cross-cutting posture question is settled — an app may NEVER propose a connection at runtime.** Proposals come only from: the user (Settings), the reviewed builder LLM (directive), or the **install act's declaration** — consented at install and given the SAME strong field-by-field `spec_confirm` review as inference. **Direction C (install-time declaration) is ratified**; A rejected (runtime channel, failed-review lineage), B rejected as primary (user must know the provider; registry structurally OAuth-only), D rejected (trust laundering — app content would wear `inference` provenance and fake chat history).
- Session ops per owner: dynamic workflows for reviews; mechanical subagents on Opus, high-risk/deep-thinking work on Fable.

### 2026-08-08 — Claude (orchestrator) — Gate 2 complete: plan v1 → 3-lens review (REVISE) → v2 fold → fidelity verify → owner fork

- **Plan v1 authored and committed** (`ff00478`) on direction C after an Opus subagent mapped the install/import/CTA/Settings/wizard surface with exact anchors. Material discovery: **there is no HTML-import flow in the product at all** — "import" is whole-`.sqlite` only — so starters are the entire live chat-less gap, and **no proposal storage exists** (wizard proposals are deliberately ephemeral, M1), which is why v1 resolves rather than persists.
- **3-lens fresh-context security review of the DESIGN** (`wf_46da5ab7-695`; 20 agents, 0 errors, ~1.26M subagent tokens): **REVISE — 15 confirmed (8 MAJOR, 7 MINOR), 2 refuted, 0 unverified.** No BLOCKER: **the ratified posture survived** and 20 soundness properties were independently confirmed. Full verdict in §Security review of plan v1. The sharpest finding is one I would not have found by inspection: **`app_declared` was not session-sticky** — the `spec_confirm` branch ships an "infer from docs" button whose `applyInferenceResult` overwrites the live session's provenance with the inferrer's rung, so **one click would have laundered a declaration into the LIGHT approve-as-is path** while T3/T5 stayed green. Second sharpest: `install_source` is attacker-writable through whole-DB import, so it can never by itself evidence an install act.
- **Plan v2 folds all 15** (`114eb99`) via five structural changes: declaration as a separate immutable session field (which also **removes the `packages/protocol` change entirely** — no new provenance literal, no persisted-enum widening, no SPEC_SYNC), install-act proof by **frozen factory-version-1 HTML byte-match** rather than `install_source` alone, raw-glob + async resolver + async CTA open with the call site reworked, an e2e re-pointed at the real CTA gap, and an honest post-revoke rule.
- **Independent fidelity verification: 10/15 FOLDED — and it caught my own false claim.** V2-4 asserted a connected demo could put its call "inside the hooks block region"; **that region is above the app-authored banner and byte-locked to the SDK file**, no shipped example ever calls `net.fetch`, and the demo would trip the CDN-allowlist rule as well. Orchestrator re-verified all three at source: **the verifier is right, MAJOR 7 is not folded, and the walking skeleton has no viable demo app.** Three further corrections folded (the draft re-seed wiping declared hosts; V2-5 being UX friction rather than a security boundary; V2-2's silent-withdrawal mode needing normalization + a visible reason).
- **STOPPED at an owner decision** per the plan's own rule and the AL-09 lesson (never weaken a security guard to make a demo convenient): the demo-vs-validate-suite fork is recorded in §Owner decision needed with four options and a recommendation. **No skeleton code starts before it is answered.**
- **Lesson reinforced, now five times running: reviewing a DESIGN costs a fraction of reviewing an implementation** — and this session adds a corollary: **the fold itself needs an independent verifier.** Eight MAJORs died with zero production code written, and one self-serving fold was caught by the step that exists to catch exactly that.

### 2026-08-07 — Claude (orchestrator) — raised while running AL-09; owner chose to park AL-09 and promote this

- Found while building AL-09's walking skeleton, then confirmed exhaustively at source: no chat-less app can reach a connection. Designed a seam (AL-09 plan v3), ran a 3-lens security review of the DESIGN before writing code, and it failed with 3 BLOCKERs + 9 MAJORs — all recorded above as constraints rather than as one proposal's bug list.
- **Owner chose option C**: park AL-09, promote this gap to its own High-tier task, resume the starters after it lands. This file is Gate 1 (spec) only — no branch, no plan, no code.
- Value already banked from the failed attempt: the design review cost zero production code and produced the constraint list above; AL-09 separately landed AC10 (Spotify registry walkthrough) and AC12 (`bearer_token` proven through the wizard — the review found that kind had **zero** shipped coverage).
