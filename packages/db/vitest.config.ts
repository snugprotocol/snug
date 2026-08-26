import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    // 30 s, because the crypto suites are CPU-BOUND BY DESIGN and 5000 ms is not enough
    // on a contended machine.
    //
    // `KDF_ITERATIONS` is 600_000 (userdb-schema.ts) — an OWASP-grade PBKDF2 cost chosen
    // so that guessing a passphrase is expensive. Every test that opens, converts or
    // re-wraps an encrypted container pays it, sometimes several times. That cost is the
    // security property working; making the tests fast would mean weakening the KDF or
    // mocking away the thing under test.
    //
    // MEASURED, not guessed (2026-08-26). Isolated on a quiet machine the whole db suite
    // is ~14 s and green 419/419. Under a full `turbo run test --force` fan-out the three
    // crypto suites take 16.6 s / 16.3 s / 10.0 s and individual tests cross the 5000 ms
    // default — which is exactly what reddened `@snugprotocol/db` on loaded local runs
    // (2-in-2 red, a different set each time, 0-in-3 isolated) and what the first CI run
    // after the flip hit on GitHub's 4-core shared runners.
    //
    // This ceiling absorbs a contended runner; it does not hide a regression. A real
    // break in this code is a wrong answer — a container that will not open, a slot that
    // unwraps with the wrong key — and those fail immediately, whatever the timeout. The
    // old 5000 ms was only ever buying a red X whose cause was the scheduler.
    //
    // NOT the playground's flake (apps/playground/vitest.config.ts): that one was tests
    // waiting on a fixed wall-clock instead of on their condition, where raising timeouts
    // was MEASURED not to help and was correctly reverted. These suites have no timer and
    // no async race — straight-line CPU work that got starved. Same symptom, opposite
    // cause. Check which you have before copying either fix.
    testTimeout: 30_000,
  },
});
