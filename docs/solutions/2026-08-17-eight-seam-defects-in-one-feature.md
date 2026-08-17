# Eight seam defects in one feature — and why every suite stayed green

**Date:** 2026-08-17
**Task:** TASK-20260816-whatsapp-twin (ADR-0032/0033)
**Found by:** the owner, clicking through the real flow on real hardware, eight times in a row.

## What happened

The WhatsApp linked-device feature shipped across six phases. Each phase was test-first, each
landed green, and the whole tree passed `turbo run test --force` at every step: protocol 329,
auth 821, playground 1123, sidecar 50, desktop 124, cargo 79. The macOS shell gate passed.

Then the owner tried to link their phone, and it failed. Eight times, for eight different
reasons, each one hidden behind the previous one:

| # | Defect | Why every test missed it |
|---|---|---|
| 1 | `SidecarState` never `.manage()`d | Commands were written, unit-tested, and registered in both handler lists. Tauri resolves state at the IPC boundary, so the invoke failed *before* the command body — no test called them through Tauri. |
| 2 | `/pair/*` refused on the only door the wizard had | The refusal was correct and total. Both halves were tested; nothing tested that the wizard could still pair. |
| 3 | QR rendered as a payload string | A `<pre>` with a comment claiming "the desktop surface draws it" — a surface that did not exist. No test asserted a scannable image. |
| 4 | The minted token was never stored | `completeDeviceLink` returned it correctly and the sheet dropped it. The test asserted the *return value*. |
| 5 | The wizard step never advanced | Storing the token was half the fix; the branch chain still fell through to the credentials screen. The test asserted absent *copy*, and the label differed from the heading. |
| 6 | A half-linked session store wedged every retry | Created by #4: an interrupted flow left `registered:false` + `me` on disk, and nothing ever cleared it. No test had a partially-completed flow. |
| 7 | Nothing started the helper for an app | `sidecarCtl('start')` had exactly one caller — the wizard. Every app test injected a fake transport, so no test needed a live process. |
| 8 | The access token died with the process | Production used `createMemoryStore`. Every unit test constructed one store and used it immediately; none simulated a restart. |

## The single cause

Every one of these is a **seam**: a place where two independently-correct components meet.
Every component had tests. Not one of the eight had a test that drove the real path across
the boundary.

The pattern is uncomfortably consistent:

- **#1, #7** — a dependency nobody registered/called, because every test supplied it directly.
- **#2, #3, #4, #5** — a contract each side honored differently, with the test written at the
  altitude of one side.
- **#6, #8** — state whose *lifetime* nobody tested: what survives a crash, what survives a
  restart.

## The rules this earns

1. **A feature is not done when its parts pass. It is done when someone walks it.** Budget for
   an end-to-end pass on real hardware before declaring a phase complete — and treat the first
   walk as *part of the work*, not as verification of finished work.
2. **Test at the altitude of the defect, not the altitude of the code.** #4 asserted a return
   value where the bug was in persistence; #5 asserted copy where the bug was in routing. Both
   passed while the bug was live. Prefer asserting *state* (what is in the store, what step
   the machine is in) and *structure* (what is rendered) over values and strings.
3. **Every injected dependency is an untested wire.** If a test supplies `sidecarFetch`,
   `SidecarState`, or a store, then nothing has tested that production supplies it too. Each
   fake is a promise that something, somewhere, provides the real thing — and that promise
   needs its own assertion.
4. **Ask what survives.** For any durable state: what happens if the process restarts
   (#8)? If the flow is interrupted halfway (#6)? A store called `createMemoryStore` in a
   production wiring is a defect the name is telling you about.
5. **A refusal that is total refuses your own callers too** (#2). When adding a guard, name the
   surface that legitimately needs the guarded thing, and test that it still works.
6. **A comment claiming another surface does the work is a pointer to verify, never evidence**
   (#3, and the platform seam's "pairing goes through `sidecarCtl`'s nonce" claim, which
   described a design nobody had built). This repo already had that rule; it was violated four
   times in one feature, which means the rule needs enforcement, not restating.

## The diagnostic lesson

I misdiagnosed the first symptom twice — a too-old Node on the GUI `PATH`, then a stale
binary. Both were **real problems that were not the reported problem**. The tell I missed:
neither prediction was ever *confirmed*, only inferred from plausible evidence, and I shipped a
fix on each inference. The owner clicked the same button three times as a result.

**Reproduce the failure before fixing it.** When a symptom persists after a fix, the first
question is not "what else could cause this" but "did my fix actually run" — and the way to
answer that is to observe it, not to reason about it.
