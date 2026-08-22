import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Playwright specs live in e2e/ and run through `pnpm test:e2e`, never vitest.
    exclude: ['e2e/**', 'node_modules/**'],

    // THE PARALLELISM FLAKE, actually diagnosed (classified 2026-08-19, fixed 2026-08-22).
    //
    // The 2026-08-19 note blamed contention and proposed raising `testTimeout` and capping
    // `maxThreads`. Both were tried here and measured: the failure rate did not move (2 of 6
    // before, 2 of 8 after), so that hypothesis is WRONG and the knobs are not kept — an
    // ineffective config change is worse than none, because it reads as a fix that holds.
    //
    // The real cause was two individual tests synchronizing on a FIXED wall-clock wait
    // instead of on their condition (`sidecarLive.test.ts`'s backoff assertion, and
    // `starterInstall.test.tsx`'s attempt-counted `settleUntil` budget, whose interleaved
    // `act()` calls made the real budget shrink under load). Both now wait for what they
    // assert on, with deadlines that still fail a genuinely stuck subject. Load only ever
    // set the odds; the races were in the tests.
    //
    // If a rendering-suite flake reappears, look for another fixed `setTimeout` standing in
    // for a condition before reaching for pool knobs.
  },
});
