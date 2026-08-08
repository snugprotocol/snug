# TASK-20260807-connection-reachability: a chat-less app can never become a connected app

- **Status**: active — **Gate 1 (spec) only. NOT started, NOT scheduled.** Parked pending the owner's green light (it sits with the held AL-10/AL-11 tail).
- **Owner**: unassigned (raised by Claude, orchestrator, 2026-08-07 while running AL-09)
- **Risk tier**: **High** — protocol surface (announce or equivalent), the auth/wizard trust ladder, and the host-side spec-write path. Any design here decides who may propose a connection.
- **Branch**: none yet
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

The AL-05 fold's separately-queued "second provider stranded with no CTA" case (AL-10/AL-11) · the keyless (`none`) credential kind (AL-12/post-alpha) · the URL-borne credential channel (AL-10/AL-11) · AL-09's starters themselves.

## Session journal (append-only, newest last)

### 2026-08-07 — Claude (orchestrator) — raised while running AL-09; owner chose to park AL-09 and promote this

- Found while building AL-09's walking skeleton, then confirmed exhaustively at source: no chat-less app can reach a connection. Designed a seam (AL-09 plan v3), ran a 3-lens security review of the DESIGN before writing code, and it failed with 3 BLOCKERs + 9 MAJORs — all recorded above as constraints rather than as one proposal's bug list.
- **Owner chose option C**: park AL-09, promote this gap to its own High-tier task, resume the starters after it lands. This file is Gate 1 (spec) only — no branch, no plan, no code.
- Value already banked from the failed attempt: the design review cost zero production code and produced the constraint list above; AL-09 separately landed AC10 (Spotify registry walkthrough) and AC12 (`bearer_token` proven through the wizard — the review found that kind had **zero** shipped coverage).
