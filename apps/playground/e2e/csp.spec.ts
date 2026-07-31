// csp.spec.ts — the C2 REAL-BROWSER GATE (umbrella AC-2, ADR-0006 obligation).
//
// Executes every entry of the runner's BROWSER_CSP_CHECKS against a real
// sandbox="allow-scripts" srcdoc iframe in Chromium. The check pages are built
// IN THE BROWSER by e2e/fixtures/csp.html importing the runner's production dist —
// injectCsp runs on Chromium's own parser, exactly as the playground does at runtime
// (jsdom cannot enforce CSP, and its serializer is not the shipping parser).
//
// Per the template's header contract (packages/runner/src/browser-csp.spec.template.ts):
//   - the verdict is a message of { type: CSP_VERDICT_MESSAGE_TYPE, id, pass, detail };
//   - a MISSING verdict within check.timeoutMs is a FAILURE — the form-action check
//     navigates away instead of reporting when the policy does not hold.
//
// Node-side import note: injectCsp needs DOMParser at module load, so test GENERATION
// polyfills it with jsdom purely to enumerate ids/timeouts; the html actually executed
// comes from the in-browser import above.
//
// `allowlisted-cdn-and-eval-work` is the positive control and loads a script from the
// real jsdelivr CDN — the one check that needs outbound network access.

import { expect, test } from '@playwright/test';
import { JSDOM } from 'jsdom';
import { FIXTURE_URL } from './helpers';

if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM('').window.DOMParser;
}
const { BROWSER_CSP_CHECKS } = await import('@snugprotocol/runner');

interface Verdict {
  pass: boolean;
  detail: string;
}

test.describe('BROWSER_CSP_CHECKS — production injectCsp enforced in Chromium', () => {
  test('template sanity: all 14 checks present, page harness agrees', async ({ page }) => {
    // The runner review fixed the suite at 14 checks; a shrink here would silently
    // weaken the C2 gate.
    expect(BROWSER_CSP_CHECKS.length).toBe(14);
    expect(new Set(BROWSER_CSP_CHECKS.map((c) => c.id)).size).toBe(BROWSER_CSP_CHECKS.length);
    await page.goto(`${FIXTURE_URL}/csp.html`);
    await page.waitForFunction(() => (window as { __cspReady?: boolean }).__cspReady === true);
    const pageIds = await page.evaluate(() => (window as unknown as { __cspCheckIds: string[] }).__cspCheckIds);
    expect(pageIds).toEqual(BROWSER_CSP_CHECKS.map((c) => c.id));
  });

  for (const check of BROWSER_CSP_CHECKS) {
    test(`${check.id} — ${check.description}`, async ({ page }) => {
      test.setTimeout(check.timeoutMs + 30_000);
      await page.goto(`${FIXTURE_URL}/csp.html`);
      await page.waitForFunction(() => (window as { __cspReady?: boolean }).__cspReady === true);
      const verdict = await page.evaluate<Verdict | null, string>(
        (id) => (window as unknown as { __runCspCheck: (id: string) => Promise<Verdict | null> }).__runCspCheck(id),
        check.id,
      );
      // Missing verdict = FAIL: for form-action-blocked a successful hostile submission
      // would navigate the document and no message would ever arrive.
      expect(verdict, `no snug-csp-verdict within ${check.timeoutMs}ms — treated as FAIL`).not.toBeNull();
      expect(verdict?.pass, `check "${check.id}" failed: ${verdict?.detail}`).toBe(true);
    });
  }
});
