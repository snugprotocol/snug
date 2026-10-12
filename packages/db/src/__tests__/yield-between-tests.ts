// yield-between-tests.ts — a db-package vitest setup file: give the event loop one turn after
// every test.
//
// WHY. Vitest runs a file's tests back to back through promise chains (microtasks). When the
// tests are synchronous — sql.js work, as most of this package's are — the worker's event loop
// never reaches its poll phase until the whole FILE ends. The worker reports progress to the
// main process over an RPC whose reply is read in that poll phase, and that RPC has a fixed
// 60 s timeout (birpc's default; vitest exposes no option for it). Measured 2026-10-11 on a
// quiet machine: `userdb/__tests__/access.test.ts` held the loop for 9.1 s and
// `userdb/__tests__/schedules.test.ts` for 6.9 s, while no single test took more than 1.3 s.
// CI's `turbo run test --force` fan-out runs this suite ≈ 10× slower (108 s vs 11 s), so the
// 9 s stretch became ≈ 90 s and CI failed with `[vitest-worker]: Timeout calling
// "onTaskUpdate"` after all 910 tests had PASSED (snug#202's and snug#203's runs).
//
// THE FIX yields after each test, so the longest stretch without a turn is ONE test, not one
// file. It changes no test and no timeout. `setImmediate` is captured at load — before any
// test can install fake timers (sync/loop.test.ts does) — so a faked clock can never stall it.
import { afterEach } from 'vitest';

const realSetImmediate = globalThis.setImmediate;

afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())));
