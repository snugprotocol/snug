# TASK-20260806-spec-push: Spec push — v0.1 + v0.2-draft to `snugprotocol/spec` (AL-13)

- **Status**: done-pending-merge (push executed + verified; docs branch awaiting orchestrator merge)
- **Owner**: Jeetu (autonomous umbrella run; Claude executes)
- **Risk tier**: medium (release-rule action — spec push; no code touched; protocol schemas are *published*, not changed)
- **Branch**: `feat/TASK-20260806-spec-push` (snug docs side); the push itself lands on `snugprotocol/spec` `main`
- **Packages touched**: none (docs only in snug; content sourced read-only from `packages/protocol`)
- **Spec impact**: spec v0.1 published + spec v0.2 published as DRAFT (→ [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md))
- **Related**: umbrella TASK-20260805-alpha-umbrella (AL-13 row, Phase-0 decision 2) · roadmap `internal/07-roadmap.md` A12 · spec-changelog staged entries (2026-07-31 v0.1, 2026-08-03 v0.2×2) · ADR-0010 (schema v2) · TASK-20260805-auth-core (v0.2 annotation source, commit `750ca29`)

## Spec (what & why)

Execute the owner-authorized (Phase-0 decision 2, 2026-08-05) first real publication to
`github.com/snugprotocol/spec` (private, currently the v0.0 skeleton at `43f65e0`): the
battle-tested **v0.1 wire protocol** (9 frames + chat envelope, rules R1–R6, 10 exported
JSON Schemas) and the **v0.2 Portable User Database Format as an explicitly-marked
DRAFT**. Auth content is **deliberately excluded** (spec-from-working-code doctrine,
roadmap A12: "only battle-tested layers publish"; the v0.3 auth/net surface is staged
internally by AL-12 and publishes no earlier than Beta exit).

**Acceptance criteria** (verified by inspection/grep/diff — docs task, no test suite):
1. Spec repo carries v0.1 wire-protocol content assembled per SPEC_SYNC: `SPEC.md` prose
   from `packages/protocol/SPEC-DRAFT.md` + `schemas/*.json` byte-identical to
   `packages/protocol/schemas/` at snug `main` `6704d95`.
2. v0.2 userdb draft included, explicitly marked DRAFT, carrying the v3-internal-draft
   version note (substance from auth-core commit `750ca29`).
3. ZERO auth content anywhere in the pushed tree, grep-verified: no `auth_required`
   (the v0.1 R5 reserved error code `AUTH_REQUIRED` is the single allowed occurrence —
   the wire spec already reserves it), no `snug_auth_specs`, no `AuthSpec`, no auth-kind
   literals (`api_key`, `oauth`, `pkce`, `bearer`, `device_code`).
4. Push to spec `main` recorded in this journal with UTC time + verification
   (fresh-clone fetch-back + diff against the local tree and against
   `packages/protocol/schemas/`).
5. Spec-changelog entries appended in the snug repo (one per spec version pushed, with
   spec-repo commit SHAs).

**Out of scope**: any change to `packages/protocol` (publication only) · repo-visibility
changes · pushes to any other repo · pushing the snug branch (orchestrator merges) ·
whitepaper content (stays "in progress" stub) · v0.3 auth/net draft (AL-12, internal).

## Plan

Sources (all read before this plan):
- Process: `docs/engineering/SPEC_SYNC.md` (authority), `docs/engineering/PROCESS.md`
  release rules, `docs/spec-changelog.md` staged entries.
- v0.1 prose: `packages/protocol/SPEC-DRAFT.md` at `6704d95`.
- v0.1 schemas: `packages/protocol/schemas/*.json` (10 files) at `6704d95` — currency
  locked by `schemas-stable.test.ts` ("committed schemas/ files are in sync with the
  source of truth"), green in the 906-test main baseline, so no local regen needed.
- v0.2 prose: `docs/spec-drafts/spec-v0.2-userdb.md` **at auth-core commit `750ca29`**
  — the only non-main source; deliberately chosen because the brief requires the fresh
  v3-internal-draft annotation carried, and that annotation exists only on the unmerged
  `feat/TASK-20260805-auth-core` branch. Everything else is sourced from `main`.
- Skeleton conventions: current spec-repo `SPEC.md`/`README.md` (version header lines,
  section framing, links).

Steps (spec repo, the local spec-repo clone (path per `internal/.env.local` conventions), already on `main`,
clean, up to date with origin):

1. **Commit 1 — `spec v0.1: …`** (one commit per spec change, SPEC_SYNC invariant):
   - `SPEC.md` → full v0.1 spec: version header (v0.1, current) keeping the skeleton's
     versioning-policy line; body from SPEC-DRAFT.md with the internal staging
     blockquote replaced by a publication note; normative-schemas pointer to
     `schemas/`; lineage section kept. The skeleton's §6 "Authenticated connections
     (reserved)" — which contained an `auth_required` literal — is dropped; the only
     auth reservation remaining is R5's `AUTH_REQUIRED` reserved code (AC-3 allowance).
   - `schemas/`: copy the 10 JSON files verbatim; delete `.gitkeep`.
   - `README.md`: status v0.0-skeleton → v0.1 published.
2. **Commit 2 — `spec v0.2-draft: …`**:
   - `SPEC-v0.2-draft.md` (separate file so `SPEC.md` stays authoritative at v0.1):
     v0.2 userdb draft, DRAFT-marked header, internal process language (push-gating,
     AL-nn child ids) rewritten for publication; the v3 version note carried in
     substance with the `snug_auth_specs` table literal **redacted** to "a Dynamic Auth
     storage surface" — AC-2 and AC-3 would otherwise collide.
   - `SPEC.md` + `README.md`: link the draft; README status names both layers.
3. **Exclusion grep** over the assembled tree (before commit; re-run on the fresh
   clone): `auth_required|snug_auth_specs|AuthSpec|api_key|oauth|pkce|bearer|device_code`
   case-insensitive; expect exactly one `AUTH_REQUIRED` hit in SPEC.md R5.
4. Commit messages per SPEC_SYNC format `spec vX.Y: <summary> (from snug TASK-<id>)`,
   bodies crediting snug source `6704d95` (and `750ca29` for the annotation).
5. **Push** `origin main` (the single 🔑 action authorized by Phase-0 decision 2).
6. **Verify**: fresh clone into scratchpad → `git diff` fresh-clone HEAD vs local HEAD
   (expect empty) → `diff -r` fresh-clone `schemas/` vs worktree
   `packages/protocol/schemas/` (expect identical) → re-run exclusion grep on the clone.
7. **Snug side (this worktree, no push)**: spec-changelog — two pushed entries (v0.1,
   v0.2-draft) with spec SHAs, plus backfill of the v0.0 entry's "(SHA recorded at
   first push)" placeholder with `43f65e0`; next-steps ✅ line; journal below (UTC +
   verification per release rules); commit on this branch.

Blocker policy: if any SPEC_SYNC precondition fails (schema drift, dirty spec clone,
push rejection) — stop before/at the push and report, don't improvise.

## Decisions & surprises

- **Annotation source is an unmerged branch.** The v3-internal-draft annotation the
  brief requires does not exist on `main` (worktree base `6704d95`); it lives in
  auth-core commit `750ca29`. Carried from there read-only; credited in the spec
  commit body. If auth-core later rewords the annotation before merge, the published
  draft may need a follow-up sync — accepted, journaled. **Resolved 2026-08-06:
  auth-core merged to main (PR #6) with the annotation wording UNCHANGED — the
  published note is in sync; no follow-up needed.**
- **AC-2/AC-3 collision resolved by redaction.** The annotation names the
  `snug_auth_specs` table; AC-3 forbids that literal anywhere in the pushed tree. The
  published note keeps the annotation's full substance (internal v3 exists,
  `user_version = 3`, v0.2 describes v2 and publishes as such, auth surface excluded
  and publishes no earlier than a later revision, v2→v3 purely additive) without the
  table name.
- **Two commits, one push.** SPEC_SYNC's "single commit" rule is per spec change; this
  push carries two spec versions → two commits, preserving the one-commit-per-change
  history invariant.
- **No local schema regen.** `schemas-stable.test.ts` locks committed schemas to the
  generator at the 906-green baseline; copying the committed files from `6704d95` is
  byte-faithful by construction.

## Session journal (append-only, newest last)

### 2026-08-06 08:15 UTC — Claude (Fable 5) — session (Gates 1+2)
- Done: all mandated reads; task file + plan (this file).
- State: plan written; proceeding to execution (umbrella Phase-0 pre-approves child
  plans; push itself pre-authorized by decision 2).
- Next step: assemble spec-repo content.
- Open questions: none blocking.

### 2026-08-06 08:20 UTC — Claude (Fable 5) — session (execution + release record)
- Done — **the 🔑 spec push** (release-rule record, per PROCESS.md):
  - **What**: `snugprotocol/spec` `main` advanced `43f65e0..ed6e596`, two commits:
    - `f148c22` — `spec v0.1: wire protocol — 9 frames + chat envelope + rules R1–R6,
      normative JSON Schemas` (SPEC.md rewritten from SPEC-DRAFT.md; 10 schema files
      added; `schemas/.gitkeep` removed; README status → v0.1).
    - `ed6e596` — `spec v0.2-draft: Portable User Database Format, published as DRAFT`
      (new `SPEC-v0.2-draft.md`; SPEC.md + README link it).
    Pushed tree: `LICENSE`, `README.md`, `SPEC.md`, `SPEC-v0.2-draft.md`,
    `implementations.md`, `schemas/*.json` ×10, `whitepaper/README.md` (stub, untouched).
  - **When**: pushed 2026-08-06 **08:16:37 UTC**.
  - **Verification**: fresh clone to scratchpad → HEAD `ed6e596` matches; `diff -r`
    clone vs local spec tree: identical; `diff -r` clone `schemas/` vs worktree
    `packages/protocol/schemas/` at `6704d95`: byte-identical; exclusion grep on the
    clone (`auth_required|snug_auth_specs|AuthSpec|api_key|oauth|pkce|bearer|device_code`,
    case-insensitive): exactly one hit — `AUTH_REQUIRED` in SPEC.md R5, the allowed
    v0.1 reserved-code note (AC-3 ✅). AC-1/2/4/5 ✅ (this entry + changelog below).
- Done — snug side: spec-changelog two pushed entries + v0.0 SHA backfill (`43f65e0`);
  next-steps ✅ line; this journal.
- Surprises: (1) stale zero-byte `HEAD.lock` (dated Jul 30, skeleton session) in the
  spec repo's `.git` blocked the first commit — removed after confirming no live git
  process. (2) The v3 annotation exists only on unmerged auth-core `750ca29`, not on
  `main` — carried from there (see Decisions). (3) Editorial deltas journaled: R5
  `AUTH_REQUIRED` note made timeline-neutral; skeleton §6 auth-reserved section
  retired; §2.2 heading's ADR-0010 pointer dropped for external cleanliness.
- State: push done + verified; worktree branch carries task file + changelog +
  next-steps only. NOT pushed (orchestrator merges snug branches).
- Next step: orchestrator review + merge; task file → `done/` on merge.
- Open questions: if auth-core rewords the v0.2 annotation before its merge, the
  published draft note may want a follow-up sync commit (tracked here, not blocking).

### 2026-08-06 08:35 UTC — Claude (Fable 5) — session (rebase onto post-AL-02/AL-08 main)
- Done: coordinator-directed `git rebase origin/main` (main `7e169d4`, PRs #6 AL-02 +
  #7 AL-08 landed after this branch cut). Conflicts resolved as expected in
  `docs/next-steps.md` + `docs/spec-changelog.md` — both sides kept, date-ordered;
  main's updated AL-01 sweep entry (AL-08 FIXED strikethrough) kept over this branch's
  stale duplicate; push entries sit newest-first above AL-02's internal-draft entry.
- **Open question CLOSED**: auth-core merged to main with the v0.2 annotation wording
  UNCHANGED — the published `SPEC-v0.2-draft.md` version note is in sync with main;
  no follow-up spec commit needed.
- State: status → done-pending-merge; diff vs origin/main re-verified docs-only.
- Next step: orchestrator merges this branch; task file → `done/`.
- Open questions: none.
