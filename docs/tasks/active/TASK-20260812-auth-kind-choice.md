# TASK-20260812-auth-kind-choice: multi-option auth-kind resolution — the user decides when a provider has more than one way in

- **Status**: planned — **awaiting owner approval (Gate 2 stop; High tier ⇒ fresh-context plan review before implementation)**
- **Owner**: Jeetu (commissioned 2026-08-12, from a live repro of the wrong-flow symptom); planning session by Claude
- **Risk tier**: **High** (auto-escalated: `packages/auth` — including a change to Guard 2b, a security guard, in `requirement-admission.ts`; decides which credential flow a user is walked into)
- **Branch**: `feat/TASK-20260812-auth-kind-choice` — **CHAINED off `feat/TASK-20260812-registry-authoritative-auth`** (owner decision Q4: this task needs the `kind` seat + `requirementFromRegistryEntry` emitter that branch adds; PR'd after it in order, the P0→P5 chain precedent)
- **Packages touched**: `auth` (registry variants, Guard 2b variant-awareness, inferrer alternatives), `knowledge` (inferrer prompt teaches alternatives), `playground` (switch card, choice persistence, wizard variant rendering); dependents: root run
- **Spec impact**: **none expected.** The persisted row remains exactly ONE `connectionRequirement`; alternatives are wizard/chat-ephemeral and the inferrer's reply envelope is internal (prompt + parser, not a published schema). If implementation finds otherwise → stop for a spec-sync decision.
- **Related**: TASK-20260812-registry-authoritative-auth (parent branch; D5/D6, AC10 split-brain pin) · ADR-0017 (proposal/validation posture) · owner repro 2026-08-12 (fresh Coinbase app → credentials collected → OAuth flow wrongly triggered)

## Spec (what & why)

**The motivating repro (owner, 2026-08-12):** a freshly built Coinbase app's CTA worked
(the parent branch's registry row landed), credentials were collected — and then the
wizard triggered an OAuth flow. Coinbase API key + secret needs no OAuth. The parent
branch fixes the DEFAULT (registry-authoritative kind ⇒ `api_key`, no connect step), but
the owner's deeper point stands: **some providers genuinely offer MORE THAN ONE way in**
(Coinbase: API key surface AND retail OAuth; GitHub: PAT AND OAuth app), and the host
silently picking one — even the right default — hides a real decision. When options
exist, the user decides, in a proper UI card. The same applies when inference runs for
unregistered providers, and when inference is used at development time to author
registry entries and starters.

**Owner interview (2026-08-12), all four on the tabled recommendation:**
- **Q1 build-time behavior** → **persist default + offer switch.** Recovery persists a
  reviewable row using the provider's DEFAULT option immediately (the app stays
  connectable, nothing blocks on an absent user), and the turn surfaces a card offering
  the other options; choosing swaps the declared row before approval.
- **Q2 registry options source** → **human-authored variants; Coinbase + GitHub first.**
  Entries gain an authored variants list (each variant a complete option: kind, fields,
  endpoints, walkthrough). This task ships Coinbase (api_key default + retail OAuth) and
  GitHub (PAT default + OAuth app); every other entry stays single-option.
- **Q3 inference ambiguity** → **the model may return alternatives.** The reply envelope
  gains an optional bounded `alternatives` list; each is validated + admitted like the
  primary or dropped. More than one valid option ⇒ card; exactly one ⇒ today's flow.
- **Q4 bindingness + sequencing** → **choice = `user` provenance; chain the branch.**
  Picking an option re-persists the row on the `user` channel, so R3 ("user_confirmed
  wins") makes the decision durable against later inference. Branch chains off the
  unmerged registry-authoritative branch.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 (registry variants are complete options):** `WellKnownOauthProvider` gains an
   optional `authOptions` variants list; each variant carries everything needed to be
   THE requirement (kind, fields, endpoints?, registration?, authorizeParams?, pkce?).
   Structural suite: every variant of every entry composes through
   `requirementFromRegistryEntry` and parses against the real
   `connectionRequirementSchema` (the parent task's AC3, extended per-variant). Coinbase
   ships `api_key` (default, top-level) + `oauth2_auth_code` (retail OAuth variant);
   GitHub ships `bearer_token` (default) + `oauth2_auth_code` (OAuth app variant).
2. **AC2 (single-option providers unchanged):** every entry WITHOUT variants behaves
   byte-for-byte as on the parent branch — the whole-surface Coinbase journey (default
   path) and all parent suites stay green untouched.
3. **AC3 (build persists the default, and the switch is OFFERED):** post-turn recovery
   for a multi-option registry provider persists the DEFAULT variant's row (provenance
   `registry`, `declared`) AND the turn's chat surfaces a switch card naming every
   option with human-readable labels. Zero-interaction builds stay connectable.
4. **AC4 (choosing is binding — R3):** selecting an option re-persists the row with the
   chosen variant's complete shape on the `user` channel; the stored row's provenance is
   `user`; a subsequent rebuild/inference cannot overwrite it
   (`skipped_user_provenance`, asserted through the real pipeline).
5. **AC5 (Guard 2b becomes variant-aware — the security pair):** a borrowing channel
   carrying a field list byte-identical to ANY human-authored variant's pinned list is
   not refused for that seat (it is the pinned value, same rationale as
   `fieldsMatchRegistry` today); a list differing from EVERY variant in any field is
   still refused. Both directions asserted; the parent's borrow-ban suites stay green.
6. **AC6 (inference may be honestly unsure):** the inferrer's reply envelope accepts an
   optional `alternatives` list (bounded, ≤3); each entry passes schema + admission on
   the inference channel or is silently dropped from the list (never fails the turn).
   >1 valid ⇒ alternatives ride the result for the caller's card; exactly 1 valid (or 0)
   ⇒ behavior identical to today. Registry rung NEVER consults the seam (parent AC4
   still green) — registry options come from the entry, not the model.
7. **AC7 (alternatives are never rows):** no alternative is ever persisted as a
   connection row. Inference alternatives ride the chat message meta with
   validate-on-read + re-admission (the R-M5 staged-proposal precedent); stale or
   invalid meta renders NOTHING (no card, no crash) rather than trusting old bytes.
8. **AC8 (the card is a doorbell, not an authority):** for registry providers the card
   renders its options FROM THE PINNED REGISTRY at render time — the message payload
   contributes nothing but the app/slot pointer. Only inference alternatives render
   from (re-admitted) message meta. Negative test: a forged card payload cannot inject
   an option the registry/meta does not hold.
9. **AC9 (routing follows the chosen kind):** choosing the api_key variant routes
   `credentials → done` (no connect step); choosing the OAuth variant routes
   `credentials → connect` with that variant's endpoints and walkthrough rendered.
   Asserted through `nextStep` + the sheet, per variant.
10. **AC10 (C1 holds):** no variant, alternative, card payload, or meta seat carries a
    credential VALUE; the parent's shape rule (every field parses against
    `connectionFieldSchema`, strict) applies to every variant field list; existing
    credential-scan suites stay green.
11. **AC11 (dev-time parity):** the alternatives + variants surface on the INFERRER
    RESULT and the REGISTRY API themselves — not inside playground UI code — so a
    dev-time caller (starter authoring, future CLI) gets the same options the runtime
    card gets. Test: a headless caller invoking the real inferrer for a multi-option
    provider receives all options with no UI imported (import-surface asserted, the
    browser-safe suite's technique).

**Out of scope:** variants for providers beyond Coinbase + GitHub (queue as authored
follow-ups) · a dedicated dev CLI/UI for registry authoring (AC11's API parity is the
deliverable; tooling is its own task) · changing admission's kind-agnostic posture
(D6/AC10 of the parent task — still its own queued task; AC5 here touches ONLY the
`fieldsMatchRegistry` exemption, not the ban's kind logic) · rebuilding the OAuth popup
flow · repairing rows persisted before this task (forward-only, per standing Q4).

## Plan

> Gate 2, written 2026-08-12 against the parent branch at `7f5bfae`. High tier ⇒
> fresh-context AI review BEFORE any implementation code, then owner approval.

### 0. Ground truth (verified in-session on the parent branch)

- `WellKnownOauthProvider` now carries required `kind` + the parent's optional `aliases`;
  `requirementFromRegistryEntry(entry, providerName, slot)` is the ONE emitter; rung 1 =
  exact key ?? `INFERRER_ALIASES`, then emitter → schema parse (`well-known-providers.ts`,
  `connection-requirement-inferrer.ts`).
- Guard 2b refuses a borrowing channel that AUTHORS `fields`, with `fieldsMatchRegistry`
  exempting a list byte-identical to `entry.fields` — the DEFAULT list only. **This is
  the wrinkle AC5 exists for**: a chosen VARIANT's field list re-persisted on the `user`
  channel would today be refused as authored prompt copy whenever the provider name is a
  borrow hit. Without AC5, Q4's "choice = user provenance" is unimplementable for
  registry providers.
- The `user` channel is IN the borrow ban's scope (only `registry` is exempt), and R3's
  `skipped_user_provenance` already protects `user` rows from non-user overwrites
  (`connectionPipeline.ts` Gate 5) — Q4 needs no new pipeline rule, only the AC5 fix.
- Chat message meta already has a persisted, validate-on-read seat with a MERGING
  updater (`updateChatMessageMeta`, R-M5) — the alternatives card rides it.
- The inferrer's reply envelope is parsed ad hoc (`envelope['requirement']`,
  `confidence`, `evidence`) in `connection-requirement-inferrer.ts`; the prompt lives at
  `packages/knowledge/prompts/tools/connection-requirement-inferrer.md` (ADR-0004: not
  authored in packages/auth). Adding `alternatives` touches both, publishes nothing.

### 1. Design decisions

- **D1 — top-level entry stays the DEFAULT; variants are additive.** The existing
  entry shape (kind/fields/endpoints at top level) IS option zero. `authOptions` lists
  ALTERNATE options only, each shaped like a mini-entry with a required human `label`
  and its own kind/fields/endpoints/registration/authorizeParams/pkce. Rationale: every
  existing consumer (emitter, admission substitution, ban indexing) keeps reading the
  default unchanged — AC2 falls out structurally; no migration of the 8 single-option
  entries.
- **D2 — one emitter, variant-selectable.** `requirementFromRegistryEntry` gains an
  optional variant argument (default = the entry itself). The card, the wizard, and the
  choice-persist path all build a chosen requirement through the SAME function the
  recovery uses — one altitude, per the parent's D2.
- **D3 — Guard 2b's exemption becomes "matches ANY authored variant list verbatim".**
  `fieldsMatchRegistry` compares against the default AND every variant's field list.
  The guard's own rationale is unchanged and is quoted in the code: a byte-identical
  human-reviewed list is not an authoring act; anything edited still is. This is the
  ONLY admission change; the ban stays kind-agnostic (parent D6 untouched, its AC10
  pin must stay green).
- **D4 — the switch card is two cards with one renderer.** Registry providers: card
  payload = (appId, slot) pointer only; options resolved from the pinned registry at
  render (AC8's doorbell rule — same posture as the v4 connection card). Inference
  providers: options = the turn's validated alternatives, persisted on message meta,
  RE-ADMITTED on read before rendering; invalid/stale meta renders nothing. Choosing
  calls one shared handler: build the chosen requirement (D2 emitter for registry;
  the re-admitted alternative for inference) → `persistConnectionRequirement` on the
  `user` channel → the existing wizard opens on the row.
- **D5 — alternatives are bounded and fail soft.** ≤3, each schema-parsed + admitted on
  the proposing channel; failures drop the alternative, never the turn. The model is
  TOLD (prompt) to return alternatives only for genuinely multi-method providers, but
  nothing trusts that instruction — the bound and per-item validation are the guard.
- **D6 — ADR-0020 records the posture**: "when a provider offers multiple auth methods,
  the host defaults, discloses, and lets the user rebind (user provenance wins)".
  Drafted at P4 close alongside the implementation reality, not before.

### 2. Phases (tests FIRST in each)

**P0 — registry variants (`packages/auth`)**
1. RED: AC1 structural suite per variant through the emitter; AC2 regression pins.
2. `authOptions` seat + Coinbase/GitHub variants (authored copy: Coinbase retail-OAuth
   endpoints + walkthrough; GitHub OAuth-app variant reuses its pinned endpoints);
   emitter variant argument (D2).

**P1 — Guard 2b variant-awareness (`packages/auth`)**
1. RED: AC5 both directions + parent borrow-ban suites as regression.
2. `fieldsMatchRegistry` → any-variant match (D3).

**P2 — inference alternatives (`packages/auth` + `packages/knowledge`)**
1. RED: AC6 (>1/1/0 valid; bound; per-item admission drop; registry rung untouched),
   AC11 (headless caller parity, import-surface assertion).
2. Envelope parsing + result seat; prompt teaches the `alternatives` key.

**P3 — playground: card + choice + routing**
1. RED: AC3 (default persists + card appears), AC4 (user-provenance rebind through the
   real pipeline), AC7 (meta validate-on-read; stale meta renders nothing), AC8 (forged
   payload negative), AC9 (per-variant routing incl. the sheet), AC10 scan.
2. Card component + meta seat + shared choice handler + wizard variant rendering.

**P4 — close**: whole-surface journeys (Coinbase default→done; Coinbase switched-to-OAuth
→ connect step with retail endpoints; GitHub both), ADR-0020, docs (code-map, next-steps),
threat-model note ONLY if the variant surface changes the trust story (expected: no —
variants are human-authored registry content, same channel as today's entries).

### 3. Test plan (AC → suite)

| AC | Where |
|---|---|
| AC1/AC2 | `packages/auth` registry-self-containment suite, extended per-variant |
| AC5 | `packages/auth` requirement-admission suite (new pair + parent regressions) |
| AC6/AC11 | `packages/auth` inferrer suite (recording adapter; headless parity) |
| AC3/AC4/AC7/AC8/AC9/AC10 | playground: new `authKindChoice` suite + wizard suite extension |
| whole-surface | playground `coinbaseJourney` extended + new `githubJourney` |

Runs: `packages/auth`, `apps/playground`, root `pnpm test -- --force` at close.

### 4. Cross-package impact & risks

- `packages/protocol` UNCHANGED (alternatives never persist as rows; envelope internal).
- **Risk 1 — Guard 2b change regressing the ban.** Contained by AC5's negative half plus
  the parent's full borrow-ban suites as a required regression gate; the ban's kind
  logic and host substitution are untouched.
- **Risk 2 — meta-riding alternatives going stale** (registry moved on, requirement
  since user-confirmed). Contained by AC7's re-admission-on-read + AC4's R3 rule (a
  `user` row makes the card's persist a `skipped_user_provenance` no-op; the card
  hides itself when the row is no longer `declared`+non-user).
- **Risk 3 — chained-branch churn** if the parent branch changes in review. Accepted
  (owner Q4); rebase cost is local to this branch.

## Decisions & surprises

- 2026-08-12: interview answers Q1–Q4 recorded in the spec; all four on the tabled
  recommendation.

## Session journal (append-only, newest last)

### 2026-08-12 — Claude (planning session) — session

- Done: Gate 1 spec from the owner's live repro + 4-question interview; Gate 2 plan
  written against the parent branch's actual code (ground truths verified in-session:
  the Guard 2b `fieldsMatchRegistry` default-only exemption is the load-bearing wrinkle
  — without D3, Q4's user-provenance rebind is structurally impossible for registry
  providers). Branch chained off `feat/TASK-20260812-registry-authoritative-auth`.
- State: planned, NO implementation code (High-tier gate).
- Next step: **fresh-context plan review (High tier) → owner approval → P0 tests-first.**
- Open questions: none blocking.
