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

## Plan v1 (Gate 2, 2026-08-08) — direction C: install-time declaration, resolved not persisted

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

## Session journal (append-only, newest last)

### 2026-08-08 — Claude (orchestrator) — /pickup; owner green light; posture ratified; Gate 2 opened

- Resumed the alpha umbrella per `/pickup` from HANDOFF #5. Baseline verified green on `main` @ `85ecd3b` (19/19 root suites; playground 409). Owner chose **"Design connection-reachability"** from the held options; branch cut off main.
- **All 12 constraint anchors re-verified at source by the orchestrator** before any design work — every citation in §Prior art holds on current main (docs-only merges since verification).
- **OWNER DECISION (2026-08-08): the cross-cutting posture question is settled — an app may NEVER propose a connection at runtime.** Proposals come only from: the user (Settings), the reviewed builder LLM (directive), or the **install act's declaration** — consented at install and given the SAME strong field-by-field `spec_confirm` review as inference. **Direction C (install-time declaration) is ratified**; A rejected (runtime channel, failed-review lineage), B rejected as primary (user must know the provider; registry structurally OAuth-only), D rejected (trust laundering — app content would wear `inference` provenance and fake chat history).
- Session ops per owner: dynamic workflows for reviews; mechanical subagents on Opus, high-risk/deep-thinking work on Fable.

### 2026-08-07 — Claude (orchestrator) — raised while running AL-09; owner chose to park AL-09 and promote this

- Found while building AL-09's walking skeleton, then confirmed exhaustively at source: no chat-less app can reach a connection. Designed a seam (AL-09 plan v3), ran a 3-lens security review of the DESIGN before writing code, and it failed with 3 BLOCKERs + 9 MAJORs — all recorded above as constraints rather than as one proposal's bug list.
- **Owner chose option C**: park AL-09, promote this gap to its own High-tier task, resume the starters after it lands. This file is Gate 1 (spec) only — no branch, no plan, no code.
- Value already banked from the failed attempt: the design review cost zero production code and produced the constraint list above; AL-09 separately landed AC10 (Spotify registry walkthrough) and AC12 (`bearer_token` proven through the wizard — the review found that kind had **zero** shipped coverage).
