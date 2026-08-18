# TASK-20260818-registered-flag: the wedge detector was destroying working sessions

- **Status**: done (fix merged via PR #68; retroactive task file — see "Process failure")
- **Owner**: jeetu
- **Risk tier**: **medium** — `apps/whatsapp-sidecar` only. No protocol change, no credential
  path, no C1/C2 surface. Rated medium rather than low because the predicate is wired to a
  DESTRUCTIVE remedy (re-pairing wipes the session), which is what made its false positive
  cost real user data.
- **Branch**: `fix/TASK-20260818-registered-flag` (merged) · close-out on
  `chore/TASK-20260818-registered-flag-close`
- **Packages touched**: `whatsapp-sidecar`
- **Spec impact**: none — `isHalfLinkedStore` is internal to the helper; the `needsRelink`
  seat it feeds was already recorded in the spec-changelog on 2026-08-17 and is unchanged.
- **Related**: TASK-20260817-telepath (shipped the faulty detector), ADR-0032,
  `docs/solutions/2026-08-17-eight-seam-defects-in-one-feature.md`

## Process failure (recorded first, because it is the most important thing here)

**This task file did not exist while the work was done.** PR #68 was authored, verified and
merged with no task file and no `done/INDEX.md` entry — Gate 1 skipped outright. The reason
was urgency (a shipped bug was actively destroying the owner's session on every attempt),
and urgency is exactly the condition the gates exist for. Written retroactively per Gate 6.

**A second, worse mistake rode along.** The commit for PR #68 was made with a blanket
`git add -A` from a branch cut off a `main` that carried the owner's UNCOMMITTED work for
`TASK-20260817-per-app-model-selector`. That swept five well-formed commits' worth of a
different task (ModelSelect, appModel routing, RunHeaderActions, ADR-0036, its docs and 36
tests) into my squash merge, so 31 files landed on `main` under a commit message about a
WhatsApp bug.

Verified afterwards: `git diff origin/feat/TASK-20260817-per-app-model-selector origin/main`
is **empty** for those paths, its ADR/architecture/glossary/done-INDEX entries are all
present, and its 36 tests pass on `main`. **Nothing was lost or corrupted — only the
attribution is wrong**, and it cannot be rewritten without force-pushing shared history.
The honest remedy is this record plus the lessons in `docs/lessons.md`.

## Spec (what & why)

Owner-reported 2026-08-18: re-paired the linked device, restarted, and was asked to re-pair
AGAIN — twice in a row.

`isHalfLinkedStore` (shipped the previous day) read `creds.registered !== true` beside a
saved `me` as "scanned but never finished". **The premise was false.** In
`baileys@7.0.0-rc14`, `creds.registered` is set to `true` in exactly ONE place —
`Socket/messages-recv.js:940`, inside the `link_code_pairing` (phone-number code) flow. The
QR flow never touches it: `pair-success` runs `configureSuccessfulPairing`, which writes
`me`, `account`, `signalIdentities` and `platform`, and leaves `registered` at its
`initAuthCreds` default of `false`.

Every session this helper creates is QR-paired, so `registered: false` is the permanent,
correct steady state. The detector therefore fired on every healthy session, and because it
is wired to a destructive remedy the result was a loop: healthy pair → "needs relinking" →
user re-pairs → `startLink` calls `shouldResetAuthStore` → **working session deleted** →
repeat. The owner went round it twice.

**Acceptance criteria** (each became at least one test):
1. A QR-paired session (the owner's real `creds.json` shape, identifiers redacted) reads as
   HEALTHY. This fixture fails against the old predicate — the regression cannot return
   silently.
2. A genuinely interrupted scan — `me` written mid-handshake, no `account`, no
   `signalIdentities` — still reads as wedged.
3. `signalIdentities: []` counts as incomplete, not as a session.
4. A completed phone-code session (`registered: true` WITH the material) reads as healthy —
   the predicate is flow-agnostic by construction.
5. First run, missing store and unparseable JSON never throw and never claim a fault.

**Out of scope**: `shouldResetAuthStore`'s wipe-on-pair behaviour (correct in itself — the
fault was what triggered it); the owner's already-wiped session (only re-pairing restores it).

## Plan

Detect on the MATERIAL a completed pairing leaves behind — `account` plus a non-empty
`signalIdentities`, beside a saved `me` — rather than on a flag that merely correlated. That
is what a session needs to resume, and it is the same answer for both pairing flows.

## Decisions & surprises

- **2026-08-18 — the fixture is the owner's real session**, redacted. A predicate whose
  false positive destroys data must be tested against a real healthy artifact, not only
  against the broken shape I imagined. That single fixture is what turns this from a fix
  into a guard.
- Verified the fix through the INSTALLED helper build (`~/Snug/helpers/…`), not just the
  source tree: previously `true` (wrong), now `false` (correct) on the owner's own file.

## Session journal (append-only, newest last)

### 2026-08-18 — claude (fable) — session (report → correct diagnosis → fix → merge)
- Done: read `creds.json` in full (it showed `account`, `signalIdentities`, `myAppStateKeyId`,
  `platform: iphone` — a fully paired session I had been misreading), then grepped the
  library for every write-site of `registered`, which settled it in one step. Rewrote the
  predicate and its suite; verified against the owner's real file and the installed build.
- Verified: sidecar **100 → 102**, root `turbo run test --force` **23/23**. CI remains
  billing-blocked on this repo, so all evidence is local.
- Merged: PR #68 (`4e7ea5f`) — carrying, unintentionally, the per-app-model-selector work
  described above.
- State: `main` clean, all suites green, both restart causes now closed (#65 orphan-rival,
  #68 false positive).
- **Next step: the owner re-pairs once more** (the loop wiped the session), then restarts
  twice to confirm the connection holds.
- Open questions: none blocking. Recorded gaps unchanged: `linkVerifiedAt` written-never-read;
  an installed starter never receives a rebuild; GitHub Actions billing-blocked.
