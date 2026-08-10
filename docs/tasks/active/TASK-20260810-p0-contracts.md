# TASK-20260810-p0-contracts: Dynamic Auth v2 — P0, doctrine + contracts

- **Status**: **ACTIVE — Gate 3 (tests first).** Child P0 of the Dynamic Auth v2 rewrite. Parent plan (decision-complete, Gate-2 reviewed and folded): [`TASK-20260810-dynamic-auth-rewrite.md`](TASK-20260810-dynamic-auth-rewrite.md).
- **Owner**: Claude (orchestrator; owner directed an autonomous P0→P5 run on 2026-08-10 — see §Owner directive)
- **Risk tier**: **High** — `packages/protocol` (schemas = the public spec) + `packages/auth` (credential broker) + `packages/db`. Auto-escalate applies regardless.
- **Branch**: `feat/TASK-20260810-p0-contracts`, cut off fresh `main` @ `3644d35`.
- **Packages touched**: `packages/protocol`, `packages/auth`, `packages/db`, docs (ADR-0017, spec draft, spec-changelog).
- **Spec impact**: **YES** — userdb schema v4 + the new `connectionRequirementSchema`. SPEC_SYNC steps 1–3 + 6 taken in this task; **steps 4–5 (push to `snugprotocol/spec`) explicitly NOT taken** — publication requires an explicit human ask and AL-12 stays HELD (owner approved only the local staged-draft carve-out, 2026-08-10).

## Owner directive (2026-08-10)

The owner answered the two open pickup questions:

1. **The v0.3 staged draft carve-out is APPROVED** — P0 creates `docs/spec-drafts/spec-v0.3-auth.md` plus an INTERNAL-DRAFT spec-changelog entry. Publication stays HELD; nothing is pushed.
2. **Run P0→P5 autonomously**, without stopping for owner review between phases.

**Stated concern, recorded once, then proceeded on the owner's decision:** the house process mandates a fresh-context review per High-tier child, and that bar has caught real blockers on six consecutive children (including this plan's own two BLOCKERs). An autonomous run removes the human gate *between* phases. **Compensation: the adversarial fresh-context review is built INTO each phase** — reviewers run as workflow agents against the phase diff, and their findings are folded before the phase closes. What is preserved is the bar's substance; what is lost is the owner's eyes between phases, and that is the owner's call.

## Scope — what P0 delivers

Exactly the parent plan's P0 line, no more. Each item traces to a fold or an owner decision.

### A. Contracts (`packages/protocol`)
1. `connectionRequirementSchema` per parent §4 — every bound explicit, every string charset-guarded, `strictObject` throughout.
2. The `none` kind in the union (**Q6**), alongside the five shipped kinds.
3. A bounded `userLayer` seat — **registry-synthesized ONLY**; the lint rejects it on the LLM and manifest channels (**fold T-M7**). Keeps R5's two-layer expressible and umbrella AC5(a) checkable.
4. userdb schema **v4** DDL: the `snug_connections` table per parent §3, replacing `snug_auth_specs` **additively** (see §Cutover).
5. The `connection_requirement` directive kind + payload.

### B. Validation (`packages/auth` + `packages/protocol`)
6. **Template lint reconciled with the shipped engine (fold S-M2)** — three parts, all mutation-evidenced:
   - (a) TRIM `template-engine.ts` HELPERS to the pinned enum: delete `unix_ms`, `hmac_sha512`, `sha256`.
   - (b) The lint rejects any `{{helper(...)}}` whose name ∉ enum, AND any bare `{{token}}` that is neither a declared field key nor a pinned request token — the engine's unknown-token→literal fallback (`template-engine.ts:189`) must be unreachable from a linted template.
   - (c) An AC proving no render path bypasses the lint.
7. **The Coinbase-variant encoding decision (fold F-m3)** — recorded in ADR-0017. Verified at source: `hmac_sha256` returns **hex only** (`hmacHex`), and the helper grammar supports neither nesting nor secret-decoding, so Coinbase-Exchange's `base64(HMAC(base64decode(secret), msg))` is genuinely inexpressible today. P0 decides: add ONE encoding-capable helper variant, or pin the P2 case to a hex-expressible provider variant. Bar: *the named eval providers are expressible* — not *every scheme imaginable*.
8. **Registry-borrow ban on provider-name match OR `declaredApiHosts` ∩ registry `apiHosts`, for ALL kinds (fold S-M3).** On either hit the registry's pinned values win and declared values for those seats are discarded.
9. **Confusable guard** on `provider.name` (printable-ASCII + normalization) — promoted from AL-10. **Scoped honestly in ADR-0017**: it stops non-ASCII homoglyphs and registry-key evasion; it does NOT stop pure-ASCII lookalikes (`5potify`), which are carried by the strong review's provenance copy.
10. **Registry type widening for static kinds (fold T-M1)** — `WellKnownOauthProvider.endpoints` is REQUIRED today, so static entries need the contract change here. **Data entries stay in P4.**

### C. Storage (`packages/db`)
11. Accessors with named errors, each mutation-evidenced: `putDeclaredConnection` (+ **`AUTH_MAX_SLOTS_PER_APP`**, fold S-M1), **`stagePendingRequirement`** (fold B2), `approveConnection`, `reapproveConnection`, `revokeConnection` (tombstone + credential-slice wipe).
12. `requirement_version` bumps on every persisted replacement whose **canonical hash differs** (fold T-mn3).
13. **`importUserDb` auth reconciliation rewritten against `snug_connections`** (fold T-M5) — byte-identical keeps approval, doctored demotes. Test home `packages/db`.
14. **First-v4-open legacy-slice wipe, fixture-tested (fold T-M4).** Verified at source: `authCredentialSecretKey` builds `auth:<appId>:<field>` with **no slot** (`packages/db/src/userdb/auth-secrets.ts:31`), so under v4's slot-keyed shape those rows hold REAL credential values that nothing in v4 lists, reads, or wipes — the AL-03 lingering-values failure exactly.
15. **The DDL-replay self-healing guard (Q9)** — absorbed from `docs/next-steps.md` `23266fc`; no longer an AL-10 candidate.

### D. Doctrine + spec
16. **ADR-0017** — the Q1 amendment table verbatim, the confusable-guard scoping, the Coinbase-encoding decision.
17. **`docs/spec-drafts/spec-v0.3-auth.md`** (owner-approved carve-out) + an INTERNAL-DRAFT `docs/spec-changelog.md` entry (house precedent: AL-02/03/04 all carry one; C3 + Gate 6 require it).
18. Delete `authRequiredPayloadSchema` — **P0-safe**: zero non-test consumers.

## Cutover rule (fold B1, BLOCKER — the constraint that shapes this whole phase)

**P0 is ADDITIVE. v4 contracts land ALONGSIDE v3.** Verified at source on `main`, not assumed:

- `apps/playground/src/starter/starterDeclaration.ts:31` imports `llmProposalSchema` at **runtime** and `.safeParse`s it at `:122`.
- The `snug_auth_specs` surface has many live consumers across `packages/db`, `packages/auth`, and the playground.

So `llmProposalSchema` and the `snug_auth_specs` surface **keep shipping** through P0. Their deletions are **named exit items** of P4 and P3 respectively. Deleting either here makes "every phase ends green" unsatisfiable.

## Acceptance criteria

Each AC gets a test, and High-tier ACs get negative tests (TDD rule 3).

| AC | Claim | Test home |
|---|---|---|
| AC1 | `connectionRequirementSchema` accepts a full Coinbase-shaped requirement (3 fields + signed header template + walkthrough + host) | `packages/protocol` |
| AC2 | Every bound rejects at its edge: >8 fields, >10 instructions, oversize strings, bad slot charset, non-https urls | `packages/protocol` (negative) |
| AC3 | `provider.name` confusable guard rejects non-ASCII homoglyphs; ASCII lookalikes are NOT claimed to be caught | `packages/protocol` (negative) |
| AC4 | `none` kind parses and is a first-class union member | `packages/protocol` |
| AC5 | `userLayer` is accepted registry-synthesized and REJECTED on the LLM/manifest channels | `packages/auth` (negative) |
| AC6 | Template lint rejects helpers ∉ enum, and bare tokens that are neither declared field keys nor pinned request tokens | `packages/auth` (negative) |
| AC7 | The engine's HELPERS map equals the pinned enum exactly — `unix_ms`/`hmac_sha512`/`sha256` are gone | `packages/auth` |
| AC8 | No render path reaches `renderAuthHeaderTemplate` without a passing lint | `packages/auth` (grep-proof + unit) |
| AC9 | Registry-borrow ban fires on name match **and** on host intersection, for ALL kinds | `packages/auth` (negative) |
| AC10 | `putDeclaredConnection` throws on `approved` and on `revoked`; replaces on `declared` | `packages/db` (negative) |
| AC11 | `AUTH_MAX_SLOTS_PER_APP` is enforced — the N+1th declared slot throws | `packages/db` (negative) |
| AC12 | `stagePendingRequirement` writes ONLY `pending_requirement_json`; requirement, hosts, status, credentials untouched | `packages/db` |
| AC13 | `revokeConnection` keeps the row, stamps the tombstone, and wipes the `auth:<appId>:<slot>:*` slice | `packages/db` |
| AC14 | `reapproveConnection` promotes pending → current and re-freezes hosts | `packages/db` |
| AC15 | `requirement_version` bumps only when the canonical hash differs | `packages/db` |
| AC16 | First v4 open wipes the legacy non-slot `auth:<appId>:<field>` slice (fixture with real values) | `packages/db` |
| AC17 | Self-healing guard: a DB stamped v4 with a dropped table gets the table back on open, other rows untouched | `packages/db` |
| AC18 | `importUserDb`: byte-identical keeps approval; doctored requirement demotes to declared | `packages/db` (negative) |
| AC19 | v3 surface still ships green — `llmProposalSchema` and `snug_auth_specs` consumers untouched (cutover rule) | root `pnpm test` |
| AC20 | ADR-0017, the v0.3 draft, and the changelog entry exist and say what §Scope D requires | docs review |

## Out of scope (P0)

Any UI · the build/edit pipeline · the directive EMISSION path (P2) · slot routing in the executor (P1) · registry data entries (P4) · deleting `llmProposalSchema` (P4) or the `snug_auth_specs` table (P3) · pushing anything to `snugprotocol/spec`.

## Session journal (append-only, newest last)

### 2026-08-10 — Claude — P0 opened; pickup verification, docs-to-main path, source re-verification

- **Pickup verification of the parent, done live rather than asserted:** branch `feat/TASK-20260810-dynamic-auth-rewrite` @ `2195b66`, clean, in sync with origin. Root `pnpm test` re-run: **19/19 packages, playground 512, FULL TURBO** — matches the recorded baseline. Diff-vs-main (32 files / +4,500) is fully explained by the parent's Branch line (cut from AL-09's tip); this task's own commits are docs-only. **No lost context.**
- **Fold F-M2 executed:** the three docs commits were cherry-picked onto `docs/TASK-20260810-plan` off fresh `main`. Three conflicts, all the same shape — `main` lacks AL-09-branch-only rows. Resolved by keeping both sides for `docs/next-steps.md` and the umbrella journal (durable queue/journal state that belongs on main regardless of AL-09's merge fate), and by dropping the superseded duplicate status header in the AL-09 task file. **Verified: the parent task file on the docs branch is byte-identical to the source branch**, and the docs branch is docs-only against main (4 files, +320/−6).
- **Owner directive received** (§Owner directive): v0.3 carve-out approved; autonomous P0→P5. Concern about losing the between-phase human gate stated once and compensated by folding the adversarial review into each phase.
- **Every load-bearing plan claim P0 depends on was re-verified at source on `main` before writing a line of code** — the reviewers are not taken on faith, and neither is the plan:
  - **Root cause CONFIRMED**: `render-directive.ts:63–69` — `llmProposalSchema = authSpecHintsSchema.omit({registrationConsoleUrl, registrationInstructions, headerTemplate, fields, userLayerFields})`. The Coinbase defect is exactly these omissions.
  - **Fold S-M2 CONFIRMED and sharpened**: the engine ships **six** helpers (`timestamp`, `unix_ms`, `base64`, `hmac_sha256`, `hmac_sha512`, `sha256` — `template-engine.ts:65–84`) against a pinned enum of three, and `resolveArgToken:189` is the unknown-token→literal fallback. **New at-source finding beyond the fold**: `hmac_sha256` returns **hex only** (`hmacHex`, `:49–54`), and the grammar supports neither nested calls nor secret-decoding — so the Coinbase-Exchange variant is *provably* inexpressible, which makes the F-m3 encoding decision load-bearing rather than advisory.
  - **Fold F-m2 CONFIRMED**: gate 3 row lookup (`connected-fetch.ts:296`) genuinely precedes gate 4 URL parse (`:311`) — host-based slot routing requires P1's swap.
  - **Fold T-M4 CONFIRMED**: `authCredentialSecretKey` builds `auth:<appId>:<field>` with no slot (`auth-secrets.ts:31`) — the orphaned-credential slice is real.
  - **Fold B1 CONFIRMED**: `starterDeclaration.ts:31` runtime-imports `llmProposalSchema`, `.safeParse` at `:122`. The additive cutover rule is mandatory.
  - **Fold T-M2 CONFIRMED**: only `docs/spec-drafts/spec-v0.2-userdb.md` exists; there is no v0.3 draft. ADR-0017 CONFIRMED free (`docs/decisions/` ends at 0016).
  - **Fold B1's manifest count CONFIRMED**: `main` carries exactly ONE manifest (`examples/connection-demo/connection.json`); AL-09's five are branch-only harvest material. Six total for P4.
  - **v4 is a `packages/protocol` change**: the DDL lives in `packages/protocol/src/userdb-schema.ts` (`USERDB_SCHEMA_VERSION = 3`, `snug_auth_specs` DDL at `:216–224`), locked by a snapshot test — so C3/SPEC_SYNC genuinely applies, as planned.
- **A fresh-context consumer map was run over `main` before implementation** (the plan's cite precision is good, but the cutover rule deserved its own sweep). It confirmed every fold above and pinned the exact write surface: **exactly one non-test writer** of auth specs (`apps/playground/src/state/wizard.ts` — `putAuthSpec:382`, `approveAuthSpec:383/388`, `reapproveAuthSpec:380/386`), one delete path (`SettingsView.tsx:592`), two read adapters (`net.ts:80`, `wizard.ts:194`), and a **narrowed** `NetSpecReader` shim in `packages/auth` (`connected-fetch.ts:51–60`) that never writes. 33 files touch the v3 surface in total. `authRequiredPayloadSchema` re-confirmed with **zero** non-test consumers (deletion is P0-safe, only test churn).
- **Three cutover traps the sweep found that the plan does NOT name — recorded here so P0 designs against them rather than discovering them mid-implementation:**
  1. **`reconcileImportedAuthSpecs` branch 2 (`userdb.ts:464`) recomputes `allowed_hosts` from the spec instead of trusting the imported column** — that is a good security property, but it means **host-union output stability is load-bearing**: if v4's derivation changes the bytes for an otherwise-unchanged connection, every approved row loses byte-identity in branch 1 and falls into branch 2, mass-demoting to unapproved on the first sync pull after cutover. AC18 must therefore assert host-union stability explicitly, not just the two documented branches.
  2. **`MIGRATIONS[2]` is a bare DDL replay** (`userdb.ts:389`) that works *only* because v3 added a whole new table. `CREATE TABLE IF NOT EXISTS` will not alter an existing table, while `migrate()` stamps `PRAGMA user_version` **unconditionally** (`:498`) — the exact "the persisted version lied" shape Q9's self-heal guard exists to catch. Since v4 adds a NEW table (`snug_connections`) rather than columns to an old one, a DDL replay is correct here — but the guard (AC17) is what makes that safe, and the one-CREATE-per-table invariant is asserted by `userdb-schema.test.ts:68` (`USERDB_DDL.length === Object.values(USERDB_TABLES).length`), so the new table must be added to BOTH constants or the snapshot test fails.
  3. **`starterDeclaration.ts:122` fails SOFT** — a bad parse becomes a console warning (`:109`), not a throw. So a shape regression there would not surface as an app-level test failure; only `starterDeclaration.test.ts` and the key-shape snapshot at `render-directive.test.ts:294` would catch it. Relevant when P4 rewires this to `connectionRequirementSchema`.
- Two existing snapshot/shape tests will need deliberate updating rather than incidental churn: `render-directive.test.ts:294` (`Object.keys(llmProposalSchema.shape)`) and `userdb-schema.test.ts:178/:182` (DDL snapshots).
- NEXT: Gate 3 — write the failing tests for AC1–AC20, then implement.
