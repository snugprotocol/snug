// openurl.spec.ts — TASK-20260818-ledger-starter Phase C (ADR-0038 D5): the open-url
// chain in a REAL browser, on production runner bytes.
//
// THE CLAIM ONLY THIS FILE CAN CARRY (review SF8): window.open called synchronously
// inside a real click handler ESCAPES the popup blocker — a jsdom stub proves ordering,
// never escape. The chain under test: sandboxed app posts `snug:open-url-request` →
// production runner routes it to the host handler → host renders a confirm → a REAL
// click opens the tab with 'noopener,noreferrer' → the app hears `opened`. Negative:
// with no handler, the app hears a NAMED `refused` — never silence.
import { expect, test } from '@playwright/test';
import { FIXTURE_URL, NET_STUB_PORT } from './helpers';

// An https popup target the open-url schema ACCEPTS: the self-signed stub, resolved and
// cert-allowed only inside this spec's own project.
const POPUP_TARGET = `https://stub.snug.test:${NET_STUB_PORT}/data`;

/** A minimal app: one button that posts an open-url request and renders the result. */
function openUrlAppHtml(url: string): string {
  return `<!DOCTYPE html><html><body>
    <button id="ask">open the page</button><div id="result">none</div>
    <script>
      let instanceId = null;
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.v !== 1) return;
        if (data.type === 'snug:host-ready') { instanceId = data.instanceId; return; }
        if (data.type === 'snug:open-url-result') {
          document.getElementById('result').textContent = data.status + (data.reason ? ':' + data.reason : '');
        }
      });
      window.parent.postMessage({ v: 1, type: 'snug:app-announce', appId: 'openurl-e2e', displayName: 'OpenUrl E2E' }, '*');
      document.getElementById('ask').onclick = () => {
        window.parent.postMessage({ v: 1, type: 'snug:open-url-request', requestId: 'ou-1', instanceId, url: ${JSON.stringify(url)} }, '*');
      };
    </script></body></html>`;
}

async function mountHarness(page: import('@playwright/test').Page, opts: Record<string, unknown>): Promise<void> {
  await page.goto(`${FIXTURE_URL}/open-url-harness.html`);
  await page.waitForFunction(() => (window as { __harnessReady?: boolean }).__harnessReady === true);
  await page.evaluate((o) => (window as unknown as { __mount: (x: object) => void }).__mount(o), opts);
}

test.describe('open-url in a real browser (production runner bytes)', () => {
  test('confirm click OPENS A REAL TAB (popup-blocker escape) and the app hears opened', async ({ page, context }) => {
    await mountHarness(page, { html: openUrlAppHtml(POPUP_TARGET) });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await app.locator('#ask').click();

    // The host confirm renders; a REAL click opens the tab synchronously.
    const popupPromise = context.waitForEvent('page');
    await page.locator('#host-open-confirm').click();
    const popup = await popupPromise;
    await popup.waitForURL(/stub\.snug\.test/);
    // noopener: the popup has no window.opener handle back into the host.
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();

    await expect(app.locator('#result')).toHaveText('opened');
  });

  test('with NO handler the app hears a NAMED refused — never silence', async ({ page }) => {
    await mountHarness(page, { html: openUrlAppHtml('https://example.com/'), withHandler: false });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await app.locator('#ask').click();
    await expect(app.locator('#result')).toHaveText(/^refused:.*capability/);
  });
});
