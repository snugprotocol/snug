# TASK-20260822-spec-10-final: Spec 1.0 final + whitepaper (final edition) + website docs/spec pages

- **Status**: draft
- **Owner**: Jeetu
- **Risk tier**: high (spec publication surface — C3; the published spec IS the protocol; whitepaper claims discipline; website sync gate)
- **Branch**: `feat/TASK-20260822-spec-10-final` (to be created at Gate 2 approval)
- **Packages touched**: `docs/spec-drafts/` (promoted), `docs/whitepaper/`, `apps/website`, `scripts/check-whitepaper.mjs`, possibly `packages/protocol` (version/pointer constants only — zero schema-shape changes expected), local `snugprotocol/spec` clone (staged; push only on explicit ask)
- **Spec impact**: spec **1.0** (promotion of the v0.3-draft release candidate → SPEC_SYNC full flow)
- **Related**: TASK-20260820-spec-v03-whitepaper (v0.3 RC + whitepaper e2), TASK-20260821-launch-security-review (SNUGENC1 §11.1 correction pending push), ADR-0044 (v0.3 publication line), ADR-0046 §7 (`/session/forget`), ADR-0049 (web-surface registry seats), ADR-0048 (website + sync gate)

## Spec (what & why)

Promote the consolidated v0.3-draft (the declared 1.0 release candidate) to the **final
Specification 1.0** for the public launch (HN Show). Fold in everything that landed after
the RC was authored, re-verify every constant and claim against the codebase at head,
produce the final whitepaper PDF, and regenerate the website docs/spec pages through the
sync gate. Everything is staged so a publish is one explicit ask away; the version stays
1.0 through any pre-launch edits.

**Known deltas the RC does not yet carry (from spec-changelog + git):**
1. SNUGENC1 §11.1 slot-table layout correction (61-byte stride, 160-byte two-slot header) —
   already corrected in the local draft, never pushed.
2. `POST /session/forget` joins the sidecar route table (ADR-0046 §7 said "next
   consolidated push" — this is that push).
3. ADR-0049 web-surface registry seats (`webRedirectPosture`, `webRegistration`) —
   entry-level, resolved at render, never persisted; Part III registry-rules impact to be
   assessed at Gate 2.
4. Anything else a fresh spec-vs-code audit at head surfaces (ADR-0045/0046/0047 landed
   after the RC's source audit).

**Acceptance criteria** (each becomes at least one check/test):
1. `SPEC-1.0` document exists, carries no DRAFT markers except deliberately-kept
   provisional/reserved markers per owner decision (interview), and every stated constant
   matches the exporting file at head (spec-vs-code conformance audit, re-run fresh).
2. The three known deltas above are folded in (or explicitly excluded by owner decision),
   each traceable in the document's revision note.
3. Whitepaper final edition builds; `check-whitepaper.mjs` green against the 1.0 document
   as fixture; AC6 claim discipline unweakened; per-page visual pass done.
4. Website spec + docs pages regenerate from the 1.0 sources; `check-website-sync` green;
   root `pnpm test` green.
5. Spec-repo publication staged in the local clone (SPEC.md = 1.0, schemas byte-identical,
   whitepaper PDF), with a drafted spec-changelog entry — **push happens only on an
   explicit owner ask** (PROCESS release rules).
6. No schema-shape change to `packages/protocol` (assert: `schemas/*.json` byte-identical
   before/after, or any delta separately justified and owner-approved).

**Out of scope**: website deployment (Cloudflare Pages — separate explicit ask),
GitHub Releases / desktop binaries, flipping any repo public, npm publishes, resolving the
open security findings triaged as non-blocking (threat model v3 list).

## Plan

**Owner decisions (interview, 2026-08-22):** §17 stays in 1.0 marked PROVISIONAL ·
stage everything, owner pushes after review · whitepaper becomes **edition 3** ·
in the spec repo, **SPEC.md becomes the 1.0 document** (v0.2/v0.3 drafts retire to
pointer stubs).

### Phase 0 — Branch + tests first (Gate 3 for a docs task = the enforcing checkers)

- Branch `feat/TASK-20260822-spec-10-final` off `main` (tree verified clean).
- Flip the checker pins FIRST so they red until the content lands:
  - `scripts/check-whitepaper.mjs` — fixture path → `docs/spec-drafts/SPEC-1.0.md`;
    edition-3 metadata pins (title/author/edition); AC5 gains "no stale v0.3-draft /
    release-candidate claims in the paper".
  - `apps/website/scripts/sync-spec.mjs` — `SPEC_SOURCE` → the 1.0 file; DRAFT_BANNER
    replaced by a 1.0 banner; AUTHORED_PAGES source paths follow. (`check-website-sync`
    reds on the manifest until Phase 4 re-syncs — that red is the test.)

### Phase 1 — Fresh spec-vs-code conformance audit (read-only, parallel subagents)

The RC's source audit ran at `cbe03cc`-era head; four merges landed since. Re-audit
`SPEC-v0.3-draft.md` against the load-bearing files it names at TODAY's head
(`packages/protocol/src/*`, `packages/auth` registry, `packages/db/src/crypto/container.ts`),
one lane per Part, restating every constant from the exporting file. Known deltas to
confirm + fold; the audit may find more:

1. **SNUGENC1 §11.1** — correction already in the local draft (61-byte stride, 160-byte
   two-slot header); verify against `container.ts` and keep.
2. **`POST /session/forget`** — joins the Part V sidecar route table (wizard-only,
   nonce-guarded, destructive; ADR-0046 §7 named "the next consolidated push" — this is it).
3. **ADR-0049 web-surface seats** (`webRedirectPosture`, `webRegistration`) — entry-level
   registry vocabulary, resolved at wizard render, never persisted; assess Part III's
   registry-rules section and add the seats + the byte-match binding rule (lesson
   2026-08-22: the grant binds to the endpoints the secret rides, never the provider name).
4. Sweep ADR-0045/0047 for any protocol-surface claim the draft contradicts (expected:
   none — starter/desktop update channels are app/distribution level; verify, don't assume).
5. Modality sweep (lesson 2026-08-07): grep the promoted document for each
   MUST/never/always against the source that backs it.

### Phase 2 — Promote the spec to 1.0

- `git mv docs/spec-drafts/SPEC-v0.3-draft.md docs/spec-drafts/SPEC-1.0.md`.
- Header: **Specification 1.0**, date, status normative-at-launch; supersedes-as-documents
  line updated; stability table → all Parts normative at 1.0 (wire core "since v0.1"),
  §17 stays marked PROVISIONAL; versioning paragraph rewritten for post-1.0 semantics
  (1.x additive; version held at 1.0 through launch edits).
- Fold Phase-1 deltas; add a short revision note (`v0.3-draft → 1.0`) naming each fold.
- Update every in-repo reference to the old path/name: `docs/{architecture,code-map,next-steps}.md`,
  `docs/whitepaper/README.md`, comments in `packages/protocol/src/__tests__/{review-regressions,net-frames}.test.ts`
  (comments only — no test behavior changes).

### Phase 3 — Whitepaper edition 3

- `src/paper.html`: cover/edition/date → edition 3, "specification 1.0" throughout;
  fold post-RC facts where the paper covers those surfaces (sidecar lifecycle gains the
  forget/unlink fact if §linked-device states route inventory; container layout already
  correct per Phase 1; web-surface seats mentioned only if the paper describes the
  registry — verify, keep claim discipline AC6 unweakened).
- Rebuild PDF (`build.mjs`, let it finish — /Info rewrite); re-check hand-authored TOC
  page hints after reflow; per-page visual pass (pymupdf renders) — CSS-counter numbering
  is invisible to the checker (README's known limit).
- `check-whitepaper.mjs` green (Phase 0 pins now satisfied), including AC6 negation-only
  checks.

### Phase 4 — Website

- Run `pnpm --filter website sync-docs` → spec pages regenerate verbatim from SPEC-1.0.md,
  schemas page from `packages/protocol/schemas/`, new PDF copied, `docs-sync.json` rewritten.
- Walk every AUTHORED page whose sources moved (manifest names them: index.mdx,
  what-is-snug, first-app, whitepaper.mdx, …) plus a repo-wide grep for `v0.3`/`draft`/
  `release candidate` in `apps/website/src` — update copy to 1.0.
- Delete `apps/website/node_modules/.astro` before the build check (lesson 2026-08-21:
  stale content-layer cache after schema/content changes).
- Green: website vitest (incl. dist-freshness tripwire), `check-website-sync`, root
  `pnpm test`.

### Phase 5 — Docs, ADR, changelog

- **ADR-0050** (drafted at Gate 2, finalized here): spec 1.0 publication — promotion of
  the v0.3 RC, §17-provisional posture, SPEC.md-becomes-the-document layout, whitepaper
  edition 3, version held at 1.0 through pre-launch edits.
- `docs/spec-changelog.md`: new entry **"STAGED, push pending owner ask"** — records the
  1.0 promotion, the three folds (incl. carrying the pending SNUGENC1-correction record),
  and the staged spec-repo commit. Headings-only grep after the anchored insert
  (lesson 2026-08-14).
- code-map/architecture/next-steps rows updated in the same branch.

### Phase 6 — Stage the spec repo (local clone; NO push)

- `git fetch --all && git branch -a -v` in `../spec`; disposition any unmerged branch
  (lesson 2026-08-20 — the edition-1 branch sat 13 days invisible).
- One local commit on the clone's `main`, not pushed:
  `spec 1.0: <summary> (from snug TASK-20260822-spec-10-final)` —
  SPEC.md = the 1.0 document verbatim · SPEC-v0.2-draft.md + SPEC-v0.3-draft.md → pointer
  stubs · `schemas/` byte-compared against `packages/protocol/schemas/` (expected
  byte-identical — zero schema-shape changes this task; any delta is a Phase-1 finding
  needing separate owner approval) · `whitepaper/` PDF e3 · README updated.
- Record in the journal: staged SHA, verification performed, "push awaits explicit ask".

### Phase 7 — Verification roll-up (AC map)

| AC | Verified by |
|----|------------|
| 1 | Phase-1 audit lanes (report in journal) + check-whitepaper AC3/AC4 against the 1.0 fixture |
| 2 | Revision note in SPEC-1.0 + changelog entry naming each fold |
| 3 | `pnpm run check-whitepaper` green + per-page visual pass |
| 4 | `check-website-sync` + website vitest + root `pnpm test` (read exit code, not summary) |
| 5 | Staged commit exists in `../spec` `main`, `origin/main` untouched (`git log origin/main..main` = exactly 1) |
| 6 | `git diff` on `packages/protocol/` empty except the two test-file comments; spec-clone `schemas/` byte-compare clean |

**Cross-package impact:** none at runtime — `packages/protocol` changes are comments in
two test files only; website is a leaf; whitepaper/spec are docs. Root `pnpm test` covers
dependents anyway.

**Spec-sync impact:** the full SPEC_SYNC flow, steps 1–4 + 6; step 5 (push) deferred to
the owner's explicit ask, per the interview decision.

**High-tier requirement:** fresh-context AI plan review BEFORE implementation, briefed to
verify this plan's mechanism claims against the named files (lesson 2026-08-21: the
highest-yield question is "the plan says X will happen — does the code that must do X
actually do it?").

## Decisions & surprises

- ADR-0050 to be drafted: spec 1.0 publication + document layout + §17 provisional
  posture + whitepaper edition 3.

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (Fable 5) — session
- Done: repo survey (spec-changelog, v0.3 draft header, whitepaper README, website sync
  manifest, protocol diff since RC); task file created.
- State: Gate 1 — interviewing owner on version identity, §17 provisional handling,
  publication scope, whitepaper edition naming.
- Next step: write Gate 2 plan from interview answers; fresh-context AI plan review
  (High tier) before any implementation.
- Open questions: see interview.
