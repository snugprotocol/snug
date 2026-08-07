# TASK-20260807-al05-review-fold: fold the post-merge AL-05 adversarial-review findings

- **Status**: in-progress
- **Owner**: Jeetu (Claude orchestrates; owner instruction 2026-08-07: "fix all findings — major & minor using dynamic workflows")
- **Risk tier**: **Medium** (KB/prompt teaching text + one disclosure-copy line; no schema or wire change; TDD mandatory)
- **Branch**: `feat/TASK-20260807-al05-review-fold` (cut off `feat/TASK-20260806-starters-auth-spectrum` @ `5a8819a`, which carries unmerged AL-05 housekeeping + HANDOFF #4 off `main` @ `2b84c6d`)
- **Packages touched**: `packages/knowledge` (KB prose + retrieval/guard tests + goldens), `apps/playground` (AC7 local-mode disclosure copy + test)
- **Spec impact**: none — prose, copy, and tests only. No schema, no wire shape, no `schemas/` change (C3 untouched).
- **Related**: `docs/tasks/done/TASK-20260806-auth-kb.md` (AL-05, merged PR #23) · umbrella `TASK-20260805-alpha-umbrella.md` row AL-05 · review workflow `wf_bd1ffa6e-08e` (3 lenses + refute-first verify) · fix workflow `wf_e6a5fb58-e5e`

## Spec (what & why)

AL-05 merged via PR #23 (`main` @ `2b84c6d`). Its pre-merge fresh-context adversarial review had been launched against the branch tip `0890442`; it completed **after** the merge and returned findings that are therefore **live on `main`**. Eleven raw findings deduped to 11, of which **9 survived refute-first verification** (each with an independently executed repro) and **2 were refuted**. Of the 9 survivors, **4 were the already-fixed cluster** confirmed remediated by the in-branch fold commit `5ad60d3` (reported for fold verification only — no action). **5 are live and unfixed** — this task fixes all 5.

The through-line of every finding is the same standard AL-05 set for itself and then missed in five places: **teaching served to a builder LLM must be true about the shipped machinery.** Two findings are false claims about host behavior, one is a missing branch in the emission doctrine, one is a disclosure line naming a wire attribute the wire never reads, and one is a retrieval gap that leaves true teaching unreachable for the plainest auth vocabulary.

### Acceptance criteria

1. **AC1 — M62 (MAJOR, C1 teaching truthfulness).** `90-auth-and-connected-apis.md` no longer claims a hardcoded key "could not work even if you wrote one". The strip is header-NAME-only (`connected-fetch.ts:143-159`, 5-name `STRIP_SET` + `/api[-_]?key/i` + `/^x-.*(auth|token)/i`) and **no code path inspects URL query strings** — a `?appid=SECRET` on an approved host rides through, which is how OpenWeather (the file's own worked example) really authenticates. The never-hardcode rule stays unconditional; the replacement must **not** enumerate which channels are inspected (that maps the gap for the LLM being taught). Guarded by a rendered-text assertion in the M60 style.
2. **AC2 — M63 (MAJOR, emission doctrine completeness).** The emission rules gain the missing **multi-provider first write** branch. Today "exactly one directive" + singular `providerName` + `declaredApiHosts` = all app-called hosts are jointly satisfiable for a two-provider app only by bundling both providers under one name, which strands the second provider at `NET_HOST_BLOCKED` (a code deliberately given no CTA, and `snug_auth_specs.app_id` is a PRIMARY KEY so a second connection cannot exist) or prefills a foreign host into the approval ceiling. Teaching: declare ONE provider, tell the user plainly, design the second feature manual/sample — matching the honest-truth pattern the file already uses for keyless providers.
3. **AC3 — M64 (MINOR, corpus self-consistency).** `10-overview-and-contract.md`'s "three hooks … are the ONLY way an app talks to the host" is now false (`useConnectedFetch` is a fourth) and outranks the new teaching for `api`-flavored queries; the Section Map has no connected-APIs row; the fetch prohibitions in `10-overview` and `70-defensive-coding` carry no pointer to the host-mediated path. Corrected surgically — the CSP prohibition itself is TRUE and stays primary (C2).
4. **AC4 — M65 (MINOR, AC7 disclosure honesty).** `inferenceWireCopy()`'s local branch interpolates `wire.provider`, but local mode ignores the provider entirely (`adapter.ts` builds `localAdapter({baseUrl, model})`); with the default `providerStore` of `mock` the paste box reads "your local **mock** server" while docs go to `localUrlStore.get()`. Copy must name the actual wire, still derived from the same decision ladder (drift-proof by construction).
5. **AC5 — M66 (MINOR, retrieval delivery).** Natural auth vocabulary must reach the teaching. The searcher has no stemming and keeps `oauth2_auth_code`/`bearer_token`/`useconnectedfetch` whole, so `authentication` and `bearer token` miss — `authentication` zero-scores the whole corpus and dumps the ~54 KB fallback. Fixed by making the prose naturally carry the vocabulary (no keyword stuffing), pinned by extending the AC10b top-3 retrieval set.
6. **AC6 — Roll-up.** Every fix test-first with a recorded RED, every guard mutation-evidenced (M62–M66), independently re-verified by a fresh agent. Full suites + typecheck + lint green. Goldens updated only as reviewed intentional diffs. `docs/next-steps.md` date-closed for the folded rows; umbrella journaled.

## Plan (test-first; mutation numbering continues from M61)

| Step | Work | Test first (mutation) |
|---|---|---|
| 1 | M62 — truthful hardcoded-key wording | rendered-text guard vs the overclaim → RED before edit |
| 2 | M63 — multi-provider emission branch | rendered-text guard on the one-connection rule + tell-the-user requirement → RED |
| 3 | M64 — corpus reconciliation (hooks sentence, Section Map row, fetch pointers) | self-consistency guard (no "ONLY way" claim; Section Map references the section) → RED |
| 4 | M65 — honest local-mode wire copy | default-case test (local + `mock`) asserting no "mock server" → RED |
| 5 | M66 — retrieval vocabulary | AC10b query set extended with natural phrasings, top-3 pinned (fallback cannot false-pass) → RED |
| 6 | Independent verification pass: each fix re-mutated by a fresh agent; suites, typecheck, lint | — |
| 7 | Docs: next-steps date-closes, umbrella journal, task file to `done/`; PR → merge | — |

## Decisions & surprises

- **Fixed post-merge on a follow-up branch, not reopened in AL-05.** AL-05 is merged and its task file is in `done/`; the review simply finished after the merge. A clean follow-up branch keeps the merged history honest and keeps these five fixes reviewable as their own diff.
- **Branch parented on the housekeeping branch, not bare `main`.** `feat/TASK-20260806-starters-auth-spectrum` @ `5a8819a` carries unmerged AL-05 housekeeping (HANDOFF #4, task-file moves). Cutting from `main` would have stranded it.
- **Two findings were refuted and are NOT fixed** (correctly — recorded so they are not re-litigated): (a) the 90-file's `Example:`/`Design` heading tokens "crowd" unrelated queries — the verifier showed no relevant displacement, the rank-1 collision pre-dates this diff, and half the claimed waste is on-topic; (b) D8 rule 3's singular host phrasing "under-declares" for multi-production-host providers — this is the Gate-2 decision verbatim (bias narrow, reviewer widens through the rule-7 evidence valve), and the security asymmetry favors it.
- **A third cluster needed no action**: the timeline/confirm/dropped-whole overclaims and the bare-`oauth` retrieval miss were already fixed in-branch by `5ad60d3` (M60/M61); the review independently confirmed that fix landed and is green.
- **Serial, not parallel, fan-out.** Three of the five fixes edit the same KB file and the same regenerated `content.ts`/goldens, so the fix agents run serially inside the workflow; only the independent verification stage parallelizes.

## Session journal (append-only, newest last)

### 2026-08-07 — Claude (orchestrator) — review fold opened
- Resumed AL-05 per `/pickup`; found it already merged (PR #23) while the pre-merge review workflow `wf_bd1ffa6e-08e` was still running. Verified all 5 live findings against `main` before acting (each grep-confirmed present).
- Owner instruction: fix all findings, major and minor, using dynamic workflows. Branch cut, task file opened, fix workflow `wf_e6a5fb58-e5e` launched (5 serial test-first fixes → parallel independent verification).

### 2026-08-07 — Claude (orchestrator) — ALL 5 FIXED, verified, gates green
- **M62** (AC1): the overclaim is gone. New prose grounds the rule in "there is no key for you to write" — the app is broken (it ignores the user's real credential) and leaks (the typed value sits in publishable source) — with **no channel enumeration**, so the teaching cannot map the strip boundary for the LLM it teaches. Three guards: no-inertness-claim, no-boundary-map, and a positive pin on all three `never` prohibitions so a later edit cannot satisfy the negatives by simply deleting the rule.
- **M63** (AC2): new "two or more providers (one connection per app)" section + a fifth emission bullet. Teaches declare-one, `declaredApiHosts` carries only the declared provider's hosts, tell the user plainly, and **build the second feature manual/sample in the same write** ("do not quietly drop it").
- **M64** (AC3): "Three hooks … ONLY way" → "These hooks … the first three are always present; the fourth appears only in apps that call an external API", with `useConnectedFetch` documented as the fourth. Verified independently against `packages/sdk/src/hooks.ts` — exactly four exported hooks, so the corrected sentence is now TRUE rather than reworded. Section Map row + fetch-prohibition pointers in `10-overview` and `70-defensive-coding`; the CSP prohibition stays primary (C2).
- **M65** (AC4): `WireDecision`'s local variant now carries `localUrl` instead of `provider` — the copy **cannot** name a provider by construction, not merely by convention. `liveAdapter` consumes the same `wire.localUrl`, so copy and adapter provably call one endpoint. Its verifier ran a second, harder mutation the fix agent had not (hardcoding the correct default URL) and the custom-endpoint guard caught it, proving the copy is pinned as *derived*.
- **M66** (AC5): prose now naturally carries "authentication", "bearer token", "access tokens", "sign in with Google" — no keyword stuffing, placeholders intact. AC10b extended with the five previously-missing queries, pinned top-3 (the fallback cannot false-pass).
- **Verification (AC6):** all 5 independently re-mutated by fresh agents; every guard bit; `problems: none`. Two verifiers went beyond their brief — M63's ran four mutations, M64's mutated all four edits (the agent had mutated two).
- **Honest note on a real hazard the verifiers caught:** a sibling left `generated/content.ts` stale mid-run and the M64 verifier deliberately restored it to that stale state rather than laundering a sibling's defect into a green handoff. `content-drift.test.ts` fired correctly. I re-verified sync myself at the end by regenerating and diffing — **byte-identical**. This is the mechanic to watch when several agents share one branch: `gen:content` rewrites the corpus for all siblings.
- **Gates:** root 19/19 · knowledge **112** (was 96) · playground **409** (was 407) · protocol 188 · Playwright 53 + 1 skip · typecheck (via playground build) clean · lint clean · generator byte-identical.
- Grep audit for the same false-guarantee class across `packages/knowledge/prompts/**` and `docs/**`: no other surface carries it.
- Next-steps: fold row date-closed; **two new queued rows** — the unpatched URL-borne credential channel (AL-10/AL-11 decision, with the OpenWeather tension stated) and the `http request` retrieval miss left deliberately unfixed.
