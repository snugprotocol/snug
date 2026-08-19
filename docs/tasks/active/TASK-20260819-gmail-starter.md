# TASK-20260819-gmail-starter: Gmail inbox-copilot starter app

- **Status**: planned (awaiting owner approval)
- **Owner**: Jeetu
- **Risk tier**: **High** (auto-escalated — the Gmail scope/fields pin touches `packages/auth/src/well-known-providers.ts`; owner picked Low in the interview for the examples work, but PROCESS.md's escalation rule wins). High extras: negative tests, fresh-context AI plan review BEFORE implementation (**done 2026-08-19, findings folded in**), explicit self-sign-off in the journal.
- **Branch**: `feat/TASK-20260819-gmail-starter`
- **Packages touched**: `packages/auth` (registry-data-only: scopes + fields + registration on the `gmail` entry), `examples/` (new `gmail/` + test pins + package.json test script), `apps/playground` (STARTER_LOOKS tile + shelf test pins)
- **Spec impact**: none — no `packages/protocol` schema change
- **Related**: ADR-0028 (pinned scopes — amended by this task), ADR-0031 (shelf + write posture), ADR-0032/0038 (whatsapp/ledger precedent), ADR-0035 (authoring-docs ingestion), ADR-0038 D5 (open-url bridge), draft **ADR-0039** (this task), `docs/next-steps.md` item (7) (gmail wizard-incomplete — this task closes the gmail slice of it)

## Spec (what & why)

A gold-standard **connected Gmail starter app** — "Inbox Copilot", the 13th shelf app
and 8th connection declarer. One Gmail account per install. The existing connection
wizard + well-known `gmail` registry entry drive the OAuth hand-off; this task
completes the entry (it is recorded wizard-incomplete in next-steps item (7)): a
**pinned scope set**, **pinned credential fields**, and a layman-grade **registration
walkthrough**. Once connected: LLM-assisted organize / filter / cleanup / block /
unsubscribe; **in-app runnable suggestion cards** (preview → one confirm → governed
write; complements the open chat lane); **hand-rolled SVG trend charts** (volume
trend, top senders, category mix); **attention flags** (never-replied non-transactional
senders, unsubscribe-worthy senders, auto-trash candidates); **mass cleanup** with
per-batch confirmation, trash-not-delete (structurally: the pinned scopes cannot
permanently delete — that needs `https://mail.google.com/`). A rich **sample mode**
renders the full showcase keyless/unconnected. Ships full authoring provenance and a
`runtime-contract.json` — the **carry-forward base prompt** pinned into installed apps.

**Interview decisions (2026-08-19, owner):**
- Scopes: `gmail.modify` + `gmail.settings.basic` + `gmail.send`.
- Write safety: **confirm every batch**; every card shows exactly what it touches; trash-not-delete.
- Charts: hand-rolled inline SVG. (Interview premise corrected by plan review: Chart.js 4 IS on the shelf — Telepath ships it, and it is KB-known-good. SVG stands anyway: zero dependency, ~0 bytes toward the 5MB cap, full theme control. Re-confirm at approval if Chart.js is preferred.)
- Tier: owner picked Low; auto-escalated to High — flagged for owner at plan approval.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — scope pin.** `lookupWellKnownProvider('Gmail').scopes` equals, ordered:
   `https://www.googleapis.com/auth/gmail.modify`,
   `https://www.googleapis.com/auth/gmail.settings.basic`,
   `https://www.googleapis.com/auth/gmail.send`. Negative: no full-access
   `https://mail.google.com/`; `google`/`googledrive` stay unpinned. Roster update:
   `well-known-providers.test.ts` `ADR_0028_SCOPE_ENTRIES` gains `'gmail'`.
2. **AC2 — fields + layman walkthrough.** The `gmail` entry pins `fields`
   (`client_id`, plus `client_secret` **iff the live probe confirms Google's
   installed-app token exchange requires it** — expected yes; GitHub `oauth_app`
   option is the C1-compatible secret-collection precedent) and a `registration`
   walkthrough (console URL + steps: project → enable Gmail API → consent screen →
   Desktop-app OAuth client → copy credentials), phrased for a non-developer and
   HONEST about provider caveats (Spotify-precedent): Testing-status refresh tokens
   expire after 7 days (walk the user through publishing to Production + the
   unverified-app "Advanced → continue" screen for restricted scopes). No copy
   claiming "no secret" unless the probe proves it.
3. **AC3 — shelf contract.** `examples/gmail/app.html` passes the full
   `validate.test.mjs` contract (single file ≤5MB, hooks byte-identical, announce
   fields, no direct network/storage, no forms, honest LLM posture +
   `runtime-contract.json`). Tripwire: no `console.cloud.google.com` URL inside
   `app.html` (URL scan allows only CDN + declared hosts) — console guidance lives
   in the registry walkthrough, not the app.
4. **AC4 — connection manifest.** `connection.json`: slot `gmail`, kind
   `oauth2_auth_code`, `declaredApiHosts: ["gmail.googleapis.com"]`, **bare**
   (registry-borrow supplies pinned values — assert bareness like hue's). Pinned in
   `MANIFEST_APPS` (8th) and `P4_STARTER_FOLDERS` in `connection-manifests.test.mjs`.
5. **AC5 — sample mode.** Unconnected + keyless renders the complete showcase from
   an embedded ~90-day sample inbox: `SAMPLE_APPS` pin in `sample-mode.test.mjs`,
   `===== GMAIL-SAMPLE-BEGIN/END =====` markers, deterministic block (no
   `Date.now`/argless `new Date()`/bridge/net/db on `SAMPLE_*` lines — anchor to a
   fixed clock like ledger's `new Date(2026, 7, 18)`), visible `data-sample-banner`.
6. **AC6 — never-replied flag.** Pure function flags senders with ≥3 received and 0
   user replies, excluding transactional/paid senders (receipt/invoice/order
   heuristics + starred/important signals). Unit-tested with fixtures.
7. **AC7 — unsubscribe candidates.** Ranking = frequency + List-Unsubscribe presence
   (read via `format=metadata&metadataHeaders=List-Unsubscribe`) + never-replied.
   Channel split: `mailto:` → confirmed `gmail.send`; `http(s)` → open-url bridge
   with a `safeCancelUrl`-style https-only/no-userinfo gate. RFC 8058 POST excluded.
   Unit-tested including the split and the URL gate.
8. **AC8 — mass cleanup, governed.** Batch planner → explicit plans (Gmail query,
   count, action: trash | label | mark-spam | create-filter); trash rides
   `messages.batchModify` `addLabelIds:["TRASH"]` (≤1000 ids/call; live-probe TRASH
   on batchModify, fall back to per-message `messages.trash`); one confirm per
   batch; card copy for spam says "move to spam", never "report spam" (SPAM label ≠
   classifier training). **Negative test:** authored code contains no
   `messages.delete`/`batchDelete` call. Sync path paginates with backoff
   (250 quota units/user/sec; throttle ≠ refusal — 2026-08-18 lesson).
9. **AC9 — chart reducers.** Volume-by-week, top-senders, category-mix reducers
   correct against fixtures. Unit-tested.
10. **AC10 — carry-forward base prompt + provenance.** `runtime-contract.json`
    defines jobs by message kind (triage digest, cleanup suggestions, sender
    classification, unsubscribe drafting, filter composing, inbox Q&A) with
    persona/state/response guidance; `authoring/prompts/01-build.md` +
    `authoring/docs/{vision,requirements,plan,lessons,next-tasks}.md` exist —
    enforced by adding gmail to `CONNECTED_APPS` (validate) and via
    `SAMPLE_APPS`→`DOCS_APPS` (sample-mode).
11. **AC11 — shelf tile.** STARTER_LOOKS row: `name: 'Inbox Copilot'` (folder stays
    `gmail`), unique emoji (set-uniqueness pinned in `starterShelf.test.tsx`),
    **`desktopOnly: true`** (Desktop-app OAuth client → loopback redirect only; web
    playground origin not registrable — trade-copilot/hue/whatsapp precedent);
    extend `CONNECTED_FOLDERS` count pin in `starterShelf.test.tsx`.

**Out of scope**: multiple Gmail accounts; RFC 8058 one-click HTTP POST unsubscribe;
Gmail push/watch; permanent delete (structurally impossible under the pinned scopes);
`google`/`googledrive` scope pins; web-playground Gmail flow (desktop-only tile);
protocol/spec changes; hosted anything.

## Plan

**Order of work (tests first per TDD.md; High tier → negative tests included):**

**Slice A — registry pin (`packages/auth`, the High-tier slice)**
0. **Live probe (before pinning copy):** create a throwaway Google Cloud Desktop-app
   client; run the PKCE code exchange with and without `client_secret`; record the
   result in this file. Determines whether `fields` pins `client_secret`
   (Coinbase-recon lesson: never pin walkthrough copy from docs memory alone).
1. RED: `registry-pinned-scopes.test.ts` — AC1 + AC2 cases (ordered set; no
   `mail.google.com/`; google/googledrive unpinned; fields pin; registration with
   console URL + steps incl. the 7-day/production caveat). RED:
   `well-known-providers.test.ts` `ADR_0028_SCOPE_ENTRIES` += `'gmail'`.
2. `packages/auth/src/well-known-providers.ts` — `gmail` entry gains `scopes` +
   `fields` + `registration` (+ WHY comments citing ADR-0028/0039, probe result).
   Registry-data-only; ADR-0028 rules 2–3 machinery (emitter, borrow-REPLACE, wizard
   review/diff, re-consent) already handles pinned seats — no auth code paths.
3. `docs/decisions/0028-registry-pinned-scopes.md` — status line + foot amendment
   recording the Gmail set (Spotify-amendment format).

**Slice B — the starter app (`examples/gmail/`)**
4. RED: `examples/gmail-analysis.test.mjs` (marker-delimited core eval, ledger
   pattern) — AC6/AC7/AC8-planner/AC9. **Add it to `examples/package.json`'s test
   script in the same step** (suites are enumerated explicitly; an unlisted suite
   never runs — 2026-08-06 lesson).
5. `examples/gmail/connection.json` (AC4, bare) · `examples/gmail/runtime-contract.json`
   (AC10 — read `packages/knowledge/prompts/README.md` + the prompt-engineering
   reference before authoring).
6. `examples/gmail/app.html` — KB template + byte-identical hooks block; app code
   after the `// 5. RESPONSE SCHEMA` banner: sample dataset (fixed clock, markers,
   banner per AC5); unconnected wizard hand-off panel; Pulse lane (SVG charts — load
   the `dataviz` skill first); Attention lane (AC6/AC7); Suggestions lane (runnable
   cards: preview → confirm → `useConnectedFetch` writes); Cleanup lane (AC8
   planner + batchModify); open-url bridge hand-rolled outside the hooks block
   (ledger precedent) with the https-only gate; theme-aware, 375px, ≥44px targets,
   no forms, skeletons.
7. `examples/gmail/README.md` + `authoring/prompts/01-build.md` +
   `authoring/docs/{vision,requirements,plan,lessons,next-tasks}.md` (AC10).
8. Pins: `validate.test.mjs` APPS + `CONNECTED_APPS`; `connection-manifests.test.mjs`
   MANIFEST_APPS + `P4_STARTER_FOLDERS` + bare-manifest assertion;
   `sample-mode.test.mjs` `SAMPLE_APPS`.

**Slice C — playground shelf**
9. `HubView.tsx` STARTER_LOOKS (`name: 'Inbox Copilot'`, unique emoji,
   `desktopOnly: true`); `starterShelf.test.tsx` `CONNECTED_FOLDERS` +
   emoji-uniqueness; `starterTileName.test.tsx` as needed (AC11).

**Slice D — docs (same branch)**
10. ADR-0039 finalize + decisions/README index line. Doc drift owed in-branch:
    `docs/code-map.md` examples line 12/7 → 13/8; `examples/README.md` "Ten
    curated" + 10-row table → 13 rows (add whatsapp, ledger, gmail — pre-existing
    drift); `docs/next-steps.md` item (7): prune gmail from the wizard-incomplete
    list (ADR-0027) + add owner manual test (live Gmail connect + one governed
    cleanup batch on real mail).

**Cross-package impact**: `packages/auth` is registry-data-only but widely depended
on (playground, desktop, server) → Gate 5 runs root `pnpm test`. `examples` suite
needs `@snugprotocol/protocol` built (turbo chain handles).

**Spec-sync**: none.

**Test plan (first, in this order)**: probe (step 0) → registry-pinned-scopes +
well-known-providers RED → gmail-analysis RED (wired into package.json) → pins go
green as files land → playground suites → root `pnpm test` at Gate 5.

## Decisions & surprises

- Gmail entry existed but was **wizard-incomplete** (next-steps item (7)): no scopes,
  no fields, no walkthrough. This task completes it. "No fields needed" in the first
  plan draft was WRONG — the wizard renders `requirement.fields ?? []` and
  `generateAuthUrl` has no stored-client_id fallback; fields pin required.
- Google installed-app clients likely require `client_secret` at token exchange even
  with PKCE (docs-known, "not treated as a secret") — live probe in step 0 decides
  the fields pin; GitHub `oauth_app` is the secret-collection precedent.
- Trash-only is **structural**, not promised: permanent delete needs
  `https://mail.google.com/`, which we deliberately do not pin (folded into ADR-0039 D3).
- Chart-lib premise corrected: Telepath ships Chart.js 4 (KB known-good). SVG chosen
  on merits (zero dep, size, theme control), not absence of precedent.
- Desktop-only at v1: loopback-class Desktop client can't serve the web playground
  origin. Tile marked `desktopOnly` per trade-copilot/hue/whatsapp precedent.
- Fresh-context plan review (High-tier requirement) ran 2026-08-19: 3 blockers
  (fields pin; client_secret probe; unwired test suite), 9 should-fixes, all folded
  into this plan. Reviewer confirmed: counts (13th/8th), ADR-0039 number free,
  ADR-0028 machinery claim, analysis-suite eval pattern, tier escalation.

## Session journal (append-only, newest last)

### 2026-08-19 — Claude (Fable 5) — session
- Done: Gate 1 spec + owner interview (scopes modify+settings.basic+send; confirm
  every batch; SVG charts; Low→High auto-escalation). Gate 2: repo research, plan
  written, ADR-0039 drafted, branch `feat/TASK-20260819-gmail-starter` created,
  fresh-context AI plan review run and all findings folded in (fields pin,
  client_secret probe step, test-script wiring, P4_STARTER_FOLDERS/CONNECTED_APPS/
  SAMPLE_APPS pins, 7-day testing-mode caveat, desktopOnly tile, doc-drift list).
- State: **STOPPED at Gate 2 for owner plan approval.** No implementation code.
- Next step: owner approves plan (and confirms: High tier OK? desktopOnly OK?
  SVG-over-Chart.js stands?) → Gate 3 step 0 live probe → RED tests.
- Open questions: (a) High tier accepted, or split the auth pin into its own
  micro-task? (b) desktop-only v1 acceptable? (c) walkthrough posture if owner
  prefers not to publish the Google project to Production (accept 7-day re-consent?).
