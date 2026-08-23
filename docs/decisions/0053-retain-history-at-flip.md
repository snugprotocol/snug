# 0053 — Flip-to-public keeps full git history, PRs, and issues

- **Status:** accepted (owner interview, 2026-08-23)
- **Date:** 2026-08-23
- **Task:** TASK-20260823-launch-readiness

## Context

`snugprotocol/snug` flips private→public for the 1.0 launch. Flipping a GitHub repo exposes not just the working tree but **everything**: all commits on all pushed refs, all 120 PRs with their bodies and review comments, all issues, and any unreachable objects GitHub has not garbage-collected. The question was whether to expose that record or restart from a squashed initial commit.

Two facts shaped the decision. First, history was already rewritten once: main was fresh-bootstrapped on 2026-07-31 and the pre-scrub original survives only in a local backup branch (`backup-pre-scrub-20260731`, never pushed post-scrub — though the force-push left the two pre-scrub commits on the remote as unreachable objects, see LAUNCH_OPS item 0). Second, ADR-0027 makes git history the archive by doctrine: done task files are deleted from the tree because history retains them, so squashing would destroy the project's own memory system.

## Decision

**Retain everything at flip**: full post-bootstrap commit history, all PRs and review comments, all issues. No squash, no fresh-start re-init, no branch-history rewrite.

Gated on evidence, all recorded in TASK-20260823-launch-readiness:

1. **Full-history secret scan clean** — gitleaks over `--log-opts="--all"` (every ref, including kept local-only branches): 54 findings, every one verified a planted test credential, schema field-name, or docs grammar text; pinned in a committed `.gitleaksignore`; rescan reports zero.
2. **PR/issue corpus scan clean** — all 110 PR bodies, 17 comments, and issues swept for token shapes, personal emails, local paths, phone numbers: zero real findings.
3. **Stage-0 purge still binds** (LAUNCH_OPS item 0): the two pre-scrub commits remain fetchable by SHA from the remote (re-verified 2026-08-23). That purge must complete — and its probe must FAIL — before the flip. Since the repo now has 120 PRs and live issues, the delete-and-recreate option in the original LAUNCH_OPS note is obsolete; **the GitHub Support purge request is the only path that preserves this decision.**

Branch surface at flip (owner-decided 2026-08-23): origin carries `main` only. All squash-merged leftovers were deleted (SHA ledger in the task file); the parked instagram-starter branch was withdrawn from origin and lives only locally until its post-1.0 resume; `backup-pre-scrub-20260731` stays local-only forever.

## Alternatives rejected

- **Squash to a fresh initial commit** — destroys the ADR-0027 archive (done task files, superseded ADR text, spec-changelog ancestry) and orphans every PR discussion; the transparent build trail is also an asset, not a liability, for a launch whose story is an AI-built protocol under a disciplined process.
- **Retain commits but recreate the repo to shed PRs/issues** — loses the review record and the seeded good-first-issues for no privacy gain the scans didn't already rule out.

## Consequences

- The commit trail, PR record, and review comments become part of the public story; nothing in them requires scrubbing (scans above).
- Any future "this must never be public" mistake has to be handled the hard way (rewrite + support purge); the cheap window closed with this decision.
- `.gitleaksignore` is the standing allowlist: new findings must be verified with the same rigor before being added, and a full-history gitleaks run belongs in any future pre-publish gate.
