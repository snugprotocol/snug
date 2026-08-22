# TASK-20260822-spec-10-final: Spec 1.0 final + whitepaper (final edition) + website docs/spec pages

- **Status**: in-review (implementation complete; awaiting Gate 5 review + owner review of the staged set)
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
- Flip the checker pins FIRST so they red until the content lands (list amended per the
  fresh-context plan review, 2026-08-22):
  - `scripts/check-whitepaper.mjs` — fixture path → `docs/spec-drafts/SPEC-1.0.md`;
    edition-3 metadata pins (title/author/edition); **AC5's existing positive
    draft-marking requirement (`checkCoverage` :313–315 requires `\bdraft\b`, `v0.3`,
    "not yet normative") is INVERTED** to "no stale v0.3-draft / release-candidate /
    not-yet-normative claims" — the §17 `standing approval → provisional` check
    (:327–330) STAYS, §17 remains provisional; **AC8's CSS running-head pin
    (:470–471, `/v0\.3/` on paper.css) flips to `1.0`**; **the `--spec` override
    candidate list (:91, `[SPEC-v0.3-draft.md, SPEC.md]`) becomes `[SPEC.md]`** —
    Phase 6 turns the old name into a pointer stub in the clone, and `find(existsSync)`
    would load the stub as the fixture.
  - `apps/website/scripts/sync-spec.mjs` — `SPEC_SOURCE` → the 1.0 file; DRAFT_BANNER
    replaced by a 1.0 banner; AUTHORED_PAGES source paths follow; **plus the two
    generated-body literals the review found: the spec-index blockquote hard-coding the
    draft path (:181) and the index description "v0.3 draft — the 1.0 release
    candidate" (:184), and the header comment (:5)**.
  - Red timing, stated honestly: `check-whitepaper` reds immediately (missing fixture);
    `check-website-sync` stays green until Phase 2's `git mv` breaks the manifest's
    source path — its red arrives then.

### Phase 1 — Fresh spec-vs-code conformance audit (read-only, parallel subagents)

The RC's source audit ran at `cbe03cc`-era head; four merges landed since. Re-audit
`SPEC-v0.3-draft.md` against the load-bearing files it names at TODAY's head
(`packages/protocol/src/*`, `packages/auth` registry, `packages/db/src/crypto/container.ts`),
one lane per Part, restating every constant from the exporting file. Known deltas to
confirm + fold; the audit may find more:

1. **SNUGENC1 §11.1** — correction already in the local draft (61-byte stride, 160-byte
   two-slot header); verify against `container.ts` and keep. Publication-only fold.
2. **`POST /session/forget`** — **already in the local draft** (§20.8, the 12-route
   table, matching `sidecar-contract.ts` exactly — plan review verified the full sets;
   only the pushed clone copy still says 11 routes). Publication-only fold, same as
   delta 1; **no draft edit** — executing "add the row" literally would duplicate it.
3. **ADR-0049 web-surface seats** (`webRedirectPosture`, `webRegistration`) — entry-level
   registry vocabulary, resolved at wizard render, never persisted; land in **§12.12's
   "capability facts" rule** (draft :834–841) + the byte-match binding rule (lesson
   2026-08-22: the grant binds to the endpoints the secret rides, never the provider
   name). **Asymmetry to respect (review finding 7):** desktop posture absent ⇒ wizard
   refuses honestly; web seat absent ⇒ entry-level walkthrough serves the web too —
   the web sentence must NOT mirror the desktop refusal semantics.
4. Sweep ADR-0045/0047 for any protocol-surface claim the draft contradicts (expected:
   none — starter/desktop update channels are app/distribution level; verify, don't assume).
5. Modality sweep (lesson 2026-08-07): grep the promoted document for each
   MUST/never/always against the source that backs it.
6. **Residual-token sweep of the promoted document itself** (review finding 6): every
   `v0.3` / `draft` / `release candidate` hit gets a per-hit keep-or-rewrite decision
   (known hits: :60 net-pair intro, :154 "R7 new in v0.3", :1325 "the v0.3 contract
   trades…", :1394 "decided at v0.3" — historical citations may stay, self-descriptions
   must not).

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
- Walk every AUTHORED page whose declared sources move (the ten, from the manifest —
  review finding 8): what-is-snug, first-app, implementors, envelopes-and-frames,
  the-user-file, connections, runtime-contracts, hub-client, embed, whitepaper.mdx
  (`index.mdx` tracks product-vision only and does NOT move this task). Plus a
  repo-wide grep for `v0.3`/`draft`/`release candidate` in `apps/website/src` —
  update copy to 1.0.
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

**High-tier requirement — DONE 2026-08-22:** fresh-context AI plan review ran before
implementation, briefed to verify mechanism claims against the named files. Result:
1 blocker + 4 must-fix + 3 improve, ALL folded into the phases above (AC5 inversion,
AC8 CSS pin, `--spec` candidate list, delta-2 restated as publication-only, sync-spec
generated-body literals, promoted-doc token sweep, ADR-0049 asymmetry, authored-page
list). Confirmations worth keeping: `packages/protocol/schemas/` and the spec clone's
`schemas/` are byte-identical TODAY (`diff -rq` clean); the clone is clean — `main` ==
`origin/main` at `cd011cc`, no stray branches; generated page slugs derive from Part
headings and are stable across the rename.

## Decisions & surprises

- ADR-0050 written: spec 1.0 publication + document layout + §17 provisional posture +
  whitepaper edition 3. (Also fixed: ADR-0049 was missing from the decisions README index.)
- **Surprise 1 (audit lane 2, REAL code defect):** `healMissingTables` counted the
  v5-dropped `snug_auth_specs` as a permanent "miss" — every open of a healthy post-v5
  file replayed DDL, reported healed=true, and persisted spuriously. Fixed test-first
  (red observed, then green): expected set now derived from `USERDB_DDL`. Fallout: the
  legacy-adoption compose test had been passing FOR THE WRONG REASON (its adoption rode
  the spurious dirty); given the §10 write it actually needs, claim preserved.
- **Surprise 2 (plan review):** `/session/forget` was already in the local draft — the
  changelog's "next consolidated push" wording made it look pending; fold was
  publication-only.
- Audit judgment calls taken INTO the spec (source-of-truth clause): 2560 measured as
  serialized UTF-16 code units; wipe gate is version-advance (not "exactly once");
  rewrap MAY reuse the slot IV under a new KEK; slot count valid range 2–8; factory
  version = newest pinned (ADR-0045); CDN_ALLOWLIST + SNUG_APP_REQUEST_TAG published.
- Website page walk found 3 pre-existing drifts (none introduced by the promotion), all
  fixed: quickstart's "structurally cannot" over-covered passphrase encryption;
  envelopes-and-frames over-generalized silent drops; connections defined the grant as
  containing credential values.

## Phase 7 — AC verification roll-up (2026-08-22)

| AC | Evidence |
|----|----------|
| 1 | Five parallel audit lanes at head: Part III fully clean; Parts I/II/IV/V/VI findings all folded (see Decisions). Modality sweep ~25 load-bearing MUSTs verified; ADR-0045/0047 sweeps clean; 63 §-refs checked, 1 fixed |
| 2 | Revision note in SPEC-1.0.md header names all folds; spec-changelog STAGED entry (headings grep: 25, none orphaned) |
| 3 | `check-whitepaper` **104/104** in BOTH modes (in-repo fixture AND `--spec ../spec` against the staged clone); PDF rebuilt (33pp, 10 figures); all 15 TOC page hints verified programmatically; visual pass on cover/TOC/pp3,15,26,31 |
| 4 | `sync-docs` regenerated 10 pages/assets; `check-website-sync` 24 pages/40 hashes OK; website vitest 33/33; root `pnpm test` exit 0 (first run), final-tree rerun recorded below |
| 5 | Spec clone: exactly ONE unpushed commit `3ac7700` on `main`; `origin/main` untouched at `cd011cc`; pending-branch sweep clean; SPEC.md = 1.0 doc; stubs written; README + whitepaper/README rewritten |
| 6 | `schemas/` byte-identical both sides (`diff -rq` clean); `packages/` diff = two test-file comments + the audited heal fix (userdb.ts + 2 tests + 1 doc comment) — the one code change, justified above |

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (Fable 5) — session
- Done: repo survey (spec-changelog, v0.3 draft header, whitepaper README, website sync
  manifest, protocol diff since RC); task file created; owner interview (4 decisions:
  §17 provisional, stage-only, edition 3, SPEC.md-becomes-1.0); Gate 2 plan written;
  branch cut; **fresh-context plan review ran and all 8 findings folded into the plan**
  (blocker: AC5 self-contradiction; must-fix: AC8 CSS pin, --spec stub-loading,
  delta-2 already-in-draft, sync-spec body literals).
- State: Gate 2 complete — **stopped for owner plan approval before implementation**.
- Next step: on approval → Phase 0 (checker pins first), then Phases 1–7 in order.
- Open questions: none blocking; the ADR-0049 fold's exact prose lands at Phase 1/2 and
  rides Gate 5 review.

### 2026-08-22 (later) — Claude (Fable 5) — session
- Done: **Phases 0–7 complete on owner approval.** Checker pins flipped (Phase 0);
  five-lane conformance audit at head, all findings folded (Phase 1); SPEC-1.0.md
  promoted with ADR-0049 §12.12 fold + revision note (Phase 2); whitepaper edition 3 —
  content pass, PDF rebuilt, 104/104 both fixture modes, TOC hints verified, visual pass
  (Phase 3); website synced + rebuilt 24 pages, authored-page walk (agent) → 3
  pre-existing drifts fixed, 33/33 + sync gate green (Phase 4); ADR-0050 + changelog
  STAGED entry + code-map/next-steps/README rows (Phase 5); spec clone staged at
  **`3ac7700`**, one unpushed commit, origin untouched (Phase 6); AC roll-up table above
  (Phase 7). Final-tree root `pnpm test` **exit 0 under pipefail** (first attempt piped
  to tail masked the code — re-run properly; the lesson held).
- Code change beyond docs (audited, test-first): the `healMissingTables` spurious-persist
  fix in packages/db (+ legacy-adoption test given its §10 write) and one comment in
  userdb-schema.ts. db 419/419 · protocol 346/346.
- State: implementation complete; branch `feat/TASK-20260822-spec-10-final` at Phases 0–6
  done. **NOT done, by design:** push to `snugprotocol/spec` (explicit ask), website
  deploy, GitHub Release, flip-public.
- Next step: owner reviews the staged set (SPEC-1.0.md · whitepaper PDF · website local
  preview · spec-clone `3ac7700`); then `/close-session` → gate-leg choice, Gate 5
  review, PR, merge; the spec push is its own ask afterward.
- Open questions: none.

### 2026-08-22 16:08 UTC — Claude (Fable 5) — session (publish)
- Done: **PUSHED `3ac7700` to `snugprotocol/spec`** on the owner's explicit in-session ask
  ("push 3ac7700 to snugprotocol/spec"), `cd011cc..3ac7700` on `main`. Verification by
  fresh shallow clone: remote head `3ac7700`; `schemas/` `diff -rq` clean against
  `packages/protocol/schemas/`; SPEC.md header reads "Specification 1.0"; whitepaper PDF
  SHA-1 `b6a9fc80…` matches the built artifact. Changelog entry flipped STAGED → PUSHED;
  next-steps updated.
- State: spec 1.0 is live in the (still-private) spec repo. Remaining: merge this branch
  via `/close-session`; website deploy / GitHub Release / flip-public are separate asks.
- Next step: owner runs `/close-session` (gate-leg choice → Gate 5 review → PR → merge).

### 2026-08-22 (Gate 6 close) — Claude (Fable 5) — session
- **Gate legs (owner choice: `--all`).** Verdict, stated exactly: **PASS 5/6 —
  workspace · smoke · rust · desktop · release all GREEN; the e2e leg is RED with 6
  failing specs that fail IDENTICALLY on `main` at `f36ba68`** (verified by running the
  same spec files on a `main` checkout): 4 × mobile 375px horizontal-overflow (a REAL
  regression from the #100 header nav) + 2 × starters-connect badge assertions gone
  stale against #100's deliberate `desktop` short-text change. Charged to `main`, filed
  as a dated next-steps item; this branch touches no playground surface and introduces
  zero e2e deltas. First e2e attempt was an ENVIRONMENT verdict (stale `dist/server.js`
  from 00:12 held port 8787 — zero specs ran; killed after command-line verification,
  along with six orphaned CPU-hog loops from the 2026-08-20 contention experiment).
- **Gate 5 fresh-context diff review**: 2 MUST-FIX + 4 NIT, zero blockers. Both
  MUST-FIXes applied (slot-count reader bound corrected to structurally-1–8 — my audit
  fold had over-tightened it, and the changelog claim of "verified" was wrong for the
  lower bound; AC3's 2560 pin restored to value-bearing). NITs 1/3/4 applied
  (heal-derivation count assert; rule-5 IV wording made exactly true; AC8 pin bound to
  the content property). NIT 2 (index-only damage unhealed) accepted as restoration of
  pre-bug intent, recorded here. Spec-clone editorial correction staged as `2132692`,
  UNPUSHED — awaits the owner's explicit push word.
- **Verification after fixes:** check-whitepaper 104/104 in both fixture modes; db
  32 files / 419 green via the package's tsc-gated script; the pipefail lesson recurred
  twice in this close (both background "exit 0" notifications were the pipe's) and is
  now a lesson entry.
- Lessons: 2 added (pipeline exit codes; permanently-firing repair guard + tests riding
  its side effect). Docs: next-steps (e2e reds item + 1.0 published entry), changelog
  correction, no other drift found (glossary/conventions clean).
- State: ready to merge on the evidence above.
- Next step: PR → merge → done-index → task file retired.
