# TASK-20260812-auth-kind-choice: multi-option auth-kind resolution — the user decides when a provider has more than one way in

- **Status**: **APPROVED by owner 2026-08-12 (incl. the D3 widening — Guard 2b substitution becomes matched-option-aware) — implementation in progress, P0 first**
- **Owner**: Jeetu (commissioned 2026-08-12, from a live repro of the wrong-flow symptom); planning session by Claude
- **Risk tier**: **High** (auto-escalated: `packages/auth` — including a change to Guard 2b, a security guard, in `requirement-admission.ts`; decides which credential flow a user is walked into)
- **Branch**: `feat/TASK-20260812-auth-kind-choice` — **CHAINED off `feat/TASK-20260812-registry-authoritative-auth`** (owner decision Q4: this task needs the `kind` seat + `requirementFromRegistryEntry` emitter that branch adds; PR'd after it in order, the P0→P5 chain precedent)
- **Packages touched**: `auth` (registry variants, Guard 2b variant-awareness, inferrer alternatives), `knowledge` (inferrer prompt teaches alternatives), `playground` (switch card, choice persistence, wizard variant rendering); dependents: root run
- **Spec impact**: **none expected.** The persisted row remains exactly ONE `connectionRequirement`; alternatives are wizard/chat-ephemeral and the inferrer's reply envelope is an internal package API (prompt + parser + the exported `InferConnectionRequirementResult` type — NOT a `packages/protocol` schema; minor 7). If implementation finds otherwise → stop for a spec-sync decision.
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
5. **AC5 (Guard 2b becomes variant-aware — the security pair) — RESTATED (review
   MAJOR 3, the tautology trap):** on NAMED non-registry channels (`user` and
   `starter`), a field list byte-identical to ANY human-authored option's pinned list
   is not refused for that seat, AND the admitted, POST-SUBSTITUTION
   `requirement.fields` still equals that same option's list — "not refused" alone is
   necessary-but-not-sufficient and would pass while substitution corrupts the row
   (BLOCKER 1). A list differing from EVERY option in any field is still refused.
   Both directions asserted; the parent's borrow-ban suites stay green.
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
8. **AC8 (the card is a doorbell, not an authority — EXTENDED with the visibility
   gate, review MAJOR 5):** for registry providers the card renders its options FROM
   THE PINNED REGISTRY at render time — the message payload contributes nothing but
   the app/slot pointer. Only inference alternatives render from (re-admitted)
   message meta. Negative tests: a forged card payload cannot inject an option the
   registry/meta does not hold; AND the card reads the LIVE row at render and shows
   NOTHING when the row is no longer `declared` with non-`user` provenance — a card
   for a since-user-confirmed or approved row must not offer a dead re-bind (the F4
   silent-button class).
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
12. **AC12 (the PERSISTED row carries the chosen variant — the BLOCKER 1 pin):** after
    the user picks an option, the row read back from the db carries the chosen
    variant's kind, fields, AND endpoints, end to end through the REAL
    `persistConnectionRequirement` — asserted on the stored row, never on any
    intermediate. This is the test that fails today: `applyRegistryValues`
    substitutes the DEFAULT's field list over the choice on every borrow hit.
13. **AC13 (`channel:'user'` is unforgeable — review MAJOR 4):** the choice handler is
    the FIRST production writer of the `user` channel; its channel argument is a
    hardcoded literal bound to a real DOM gesture. Negative test: no directive,
    import, recovery, or message-meta path can reach `persistConnectionRequirement`
    with `channel:'user'` — because R3 gives `user` rows supremacy, a forgeable `user`
    channel would let one hostile turn mint a row no rebuild can ever correct.

**Out of scope:** variants for providers beyond Coinbase + GitHub (queue as authored
follow-ups) · a dedicated dev CLI/UI for registry authoring (AC11's API parity is the
deliverable; tooling is its own task) · changing admission's kind-AGNOSTIC posture
(D6/AC10 of the parent task — still its own queued task; this task's admission change
is scoped to which OPTION substitution honors, never to substituting `kind`) ·
rebuilding the OAuth popup flow · repairing rows persisted before this task
(**forward-only, stated plainly per review MAJOR 6: the switch card appears for FRESH
multi-option builds and re-declares only. The owner's existing wrong-kind Coinbase row
gets no card until its app re-declares — one edit/rebuild turn after the parent branch
merges re-lands the row and THEN the card appears**).

## Plan

> Gate 2, written 2026-08-12 against the parent branch at `7f5bfae`. High tier ⇒
> fresh-context AI review BEFORE any implementation code, then owner approval.

### 0. Ground truth (verified in-session on the parent branch)

- `WellKnownOauthProvider` now carries required `kind` + the parent's optional `aliases`;
  `requirementFromRegistryEntry(entry, providerName, slot)` is the ONE emitter; rung 1 =
  exact key ?? `INFERRER_ALIASES`, then emitter → schema parse (`well-known-providers.ts`,
  `connection-requirement-inferrer.ts`).
- Guard 2b refuses a borrowing channel that AUTHORS `fields`, with `fieldsMatchRegistry`
  exempting a list byte-identical to `entry.fields` — the DEFAULT list only. A chosen
  VARIANT's field list re-persisted on the `user` channel would today be refused as
  authored prompt copy whenever the provider name is a borrow hit (reviewer-confirmed).
- **CORRECTED PREMISE (BLOCKER 1).** My first draft claimed "Q4 needs no new pipeline
  rule, only the AC5 fix." **False** — the refusal half is only half of Guard 2b. The
  SUBSTITUTION half (`applyRegistryValues`, `requirement-admission.ts:323-325`) runs on
  EVERY borrow hit on EVERY channel and writes the DEFAULT entry's `fields`
  unconditionally, so a user-chosen OAuth variant would persist as the OAuth kind with
  the api_key field list — the user's choice silently undone and a fresh instance of
  the D6 split-brain. The parent's own AC10 pin proves the mechanism. (Verified
  nuance beyond the review: the chosen variant's ENDPOINTS survive for Coinbase —
  substitution overwrites endpoints only when the ENTRY has them and the default
  Coinbase entry has none; GitHub's default endpoints equal its variant's. The fields
  clobber alone is what corrupts the choice.) Fix is D3's matched-option handle.
- R3's `skipped_user_provenance` protects `user` rows from non-user overwrites
  (`connectionPipeline.ts` Gate 5) — that half of Q4 needs no new rule. But NOTHING
  writes `channel:'user'` today (reviewer grep: enum + Gate 5 read only) — the choice
  handler becomes the FIRST `user`-channel writer, hence AC13/D7.
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
- **D3 (REWRITTEN after BLOCKERs 1+2) — one MATCHED-OPTION handle drives BOTH halves
  of Guard 2b.** Admission resolves WHICH option (the default, or one named variant)
  the declared field list matches byte-identically, and that single handle feeds both
  the exemption (`fieldsMatchRegistry` → "matches option X") and the substitution
  (`applyRegistryValues` substitutes option X's fields, and option X's endpoints when
  it has them — never the default's over a matched variant). No match ⇒ exactly
  today's behavior (default substituted; authored lists refused on borrowing
  channels). This keeps the guard's quoted rationale coherent for multi-option
  entries — the blessed list and the substituted shape can never disagree about which
  human-reviewed option they came from (BLOCKER 2's mix-and-match dies structurally).
  **This IS a change to a security guard's substitution contract** — the thing the
  first draft claimed to avoid — which is why it is named here as an owner-approval
  item and recorded in ADR-0020, and why AC5/AC12 assert on the POST-substitution and
  PERSISTED shapes respectively. The ban stays kind-agnostic (parent D6 untouched,
  its AC10 pin must stay green: a borrower's KIND is still never substituted).
- **D7 (NEW, from MAJOR 4) — `channel:'user'` is gesture-bound and unforgeable.** The
  choice handler passes the literal `'user'`; no directive, import, recovery result,
  or message-meta value can ever become the channel argument (AC13's negative test).
  R3 makes `user` rows permanent against inference — the write path must be exactly
  as hard to reach as the guarantee is strong.
- **D4 — the switch card is two cards with one renderer, gated on the LIVE row
  (extended per MAJOR 5).** Registry providers: card payload = (appId, slot) pointer
  only; options resolved from the pinned registry at render (AC8's doorbell rule —
  same posture as the v4 connection card). Inference providers: options = the turn's
  validated alternatives, persisted on message meta, RE-ADMITTED on read before
  rendering; invalid/stale meta renders nothing. IN BOTH CASES the renderer reads the
  live connection row first and renders NOTHING unless the row is `declared` with
  non-`user` provenance — a card over a user-confirmed or approved row would be a
  dead button (Gate 5 would no-op it), the exact F4 silence class. Choosing calls one
  shared handler: build the chosen requirement (D2 emitter for registry; the
  re-admitted alternative for inference) → `persistConnectionRequirement` with the
  literal `'user'` channel (D7) → the existing wizard opens on the row.
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

**P1 — Guard 2b matched-option handle (`packages/auth`) — the security phase**
1. RED: AC5 both directions ON NAMED CHANNELS asserting post-substitution fields;
   AC12's persisted-row fidelity through the real pipeline (fails today — the
   BLOCKER 1 repro); parent borrow-ban + AC10 suites as required regressions.
2. `fieldsMatchRegistry` → matched-option resolution; `applyRegistryValues` →
   substitutes the MATCHED option's fields/endpoints (D3). Kind still never
   substituted.

**P2 — inference alternatives (`packages/auth` + `packages/knowledge`)**
1. RED: AC6 (>1/1/0 valid; bound; per-item admission drop; registry rung untouched),
   AC11 (headless caller parity, import-surface assertion).
2. Envelope parsing + result seat; prompt teaches the `alternatives` key.

**P3 — playground: card + choice + routing**
1. RED: AC3 (default persists + card appears), AC4 (user-provenance rebind through the
   real pipeline), AC7 (meta validate-on-read; stale meta renders nothing), AC8 (forged
   payload negative + live-row visibility gate), AC9 (per-variant routing incl. the
   sheet), AC10 scan, AC13 (user channel unforgeable — negative sweep over every
   production `persistConnectionRequirement` caller).
2. Card component + meta seat + shared choice handler (literal `'user'`, D7) + wizard
   variant rendering.

**P4 — close**: whole-surface journeys (Coinbase default→done; Coinbase switched-to-OAuth
→ connect step with retail endpoints; GitHub both), ADR-0020, docs (code-map, next-steps),
threat-model note ONLY if the variant surface changes the trust story (expected: no —
variants are human-authored registry content, same channel as today's entries).

### 3. Test plan (AC → suite)

| AC | Where |
|---|---|
| AC1/AC2 | `packages/auth` registry-self-containment suite, extended per-variant |
| AC5/AC12 | `packages/auth` admission suite (matched-option pair) + playground pipeline (persisted row) |
| AC6/AC11 | `packages/auth` inferrer suite (recording adapter; headless parity) |
| AC3/AC4/AC7/AC8/AC9/AC10/AC13 | playground: new `authKindChoice` suite + wizard suite extension |
| whole-surface | playground `coinbaseJourney` extended (default + switched-to-OAuth) + new `githubJourney` |

Runs: `packages/auth`, `apps/playground`, root `pnpm test -- --force` at close.

### 4. Cross-package impact & risks

- `packages/protocol` UNCHANGED (alternatives never persist as rows; envelope internal).
- **Risk 1 — Guard 2b change regressing the ban.** NOW LARGER than the first draft
  admitted: D3 touches the substitution contract, not just the exemption. Contained by
  AC5's negative half, AC12's persisted-row fidelity, the parent's full borrow-ban +
  AC10 suites as required regression gates, and the invariant that host substitution
  and provider-name pinning remain unconditional on every borrow hit for every option
  path (a dedicated test per option). The ban's kind logic is untouched.
- **Risk 2 — meta-riding alternatives going stale** (registry moved on, requirement
  since user-confirmed). Contained by AC7's re-admission-on-read + AC4's R3 rule (a
  `user` row makes the card's persist a `skipped_user_provenance` no-op; the card
  hides itself when the row is no longer `declared`+non-user).
- **Risk 3 — chained-branch churn** if the parent branch changes in review. Accepted
  (owner Q4); rebase cost is local to this branch.

## Decisions & surprises

- 2026-08-12: interview answers Q1–Q4 recorded in the spec; all four on the tabled
  recommendation.

### Fresh-context plan review record (2026-08-12, adversarial, REVISE → all folded)

One read-only reviewer attacked the plan against source, refute-first. **2 BLOCKERs +
3 MAJORs + 1 minor; all folded before owner approval.** I independently re-verified
BLOCKER 1's mechanism against `requirement-admission.ts` (in-context from the parent
session) before folding.

| # | Finding | Disposition |
|---|---|---|
| B1 | `applyRegistryValues` substitutes the DEFAULT field list on every borrow hit on every channel — the user-chosen variant is silently clobbered between the handler and the row; the plan's "no new pipeline rule needed" premise was false. (My verification refined one sub-claim: the variant's ENDPOINTS survive for Coinbase since the default entry has none; the fields clobber is the corruption.) | **Folded**: §0 premise corrected; D3 rewritten as the matched-option handle driving BOTH Guard 2b halves; AC12 added (persisted-row fidelity, fails today) |
| B2 | D3-as-drafted decoupled the blessed field list from the substituted shape — a borrowing channel could pass one variant's fields and receive the default's shape, a mix-and-match the guard's rationale can't justify | **Folded**: same matched-option handle — exemption and substitution can never disagree about which option matched |
| M3 | AC5's positive half was the tautology trap: "not refused" passes while substitution corrupts | **Folded**: AC5 restated — named channels + post-substitution fields equality |
| M4 | NOTHING writes `channel:'user'` today; the choice handler becomes the first writer of a channel R3 makes supreme, and the plan never said what keeps it unforgeable | **Folded**: D7 + AC13 (gesture-bound literal; negative sweep) |
| M5 | The card's hide condition needs the LIVE row's status/provenance, which the pointer payload doesn't carry | **Folded**: D4 extended — renderer reads the row, renders nothing unless `declared`+non-`user`; AC8 extended |
| M6 | The owner's EXISTING wrong-kind row gets no card (forward-only) — true to standing Q4 but unstated, and the motivating repro implies otherwise | **Folded**: out-of-scope states it plainly, with the route (one re-declare turn, then the card) |
| m7 | "envelope is internal" overstated — `InferConnectionRequirementResult` is an exported package API | **Folded**: spec-impact line reworded (still no `packages/protocol` change) |

Reviewer-refuted attacks worth keeping: the plan's core premise that D3's exemption is
NECESSARY is confirmed (an OAuth-variant list on `user` is refused today); the forged
registry-card payload cannot inject options (pointer-only payload); the R-M5 meta
precedent exists as claimed; no C1 hole in variant field definitions.

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

### 2026-08-12 — Claude (planning session, review fold) — session

- Done: fresh-context adversarial plan review run and ALL findings folded (record in
  §Decisions). **My own premise was wrong in the same shape as the parent task's**: I
  scoped Guard 2b's refusal half and missed that its SUBSTITUTION half runs
  unconditionally and would have silently clobbered the user's chosen variant — the
  exact "choice that does nothing" class this task exists to kill. D3 is now the
  matched-option handle; AC12/AC13 added; AC5/AC8 restated; forward-only stated
  plainly.
- **The fold WIDENS the task**: D3 now changes a security guard's substitution
  contract (which option's fields/endpoints substitution honors — kind stays
  untouched). This widening is flagged for explicit owner approval, not slipped in.
- State: replanned, NO implementation code (High-tier gate honored).
- Next step: **owner approval (including the D3 widening) → P0 tests-first.**
- Open questions: the D3 widening decision is the approval question.

### 2026-08-12 — Claude (implementation session) — session

- Done: **owner APPROVED the reviewed plan including the D3 widening.** Implementation
  begins, P0 tests-first.
- State: implementing.
