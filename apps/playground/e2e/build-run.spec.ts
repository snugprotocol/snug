// build-run.spec.ts — umbrella AC-7: chat → build → artifact → run → bridge round-trip,
// all on the mock adapter, no model network.
//
// Split in two so the round-trip half of AC-7 is proven on production runner bytes even
// before the app shell (workstream A) lands:
//
//   Part A (app flow)      — /build composer → mock adapter streams deltas → SSE
//                            `artifact` event → artifact card → "run it" → the demo app
//                            renders inside the sandboxed frame. Skips (with reason)
//                            until the vite app exists. NOTE: the server's default mock
//                            script (apps/server/src/adapter.ts demoMockScript) is a
//                            2-turn artifact-write flow whose demo app does not call
//                            sendMessage, and it ships no SNUG_MOCK_SCRIPT override —
//                            so the server-mode HTTP bridge round-trip stays pending
//                            until either that env hook or the app's BYOK-mock mode
//                            exposes a scriptable turn (tracked in Part B instead).
//
//   Part B (bridge round-trip) — the PRODUCTION SnugAppFrame + runner host with a
//                            scripted in-page transport: canned app HTML announces,
//                            sends an app-message, the scripted agent turn streams then
//                            resolves canned JSON, and the app RENDERS the agent data.
//                            Every hop is the production postMessage bridge.

import { expect, test } from '@playwright/test';
import { AWAITS_INTEGRATION, FIXTURE_URL, echoAppHtml } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('AC-7 part A — build → artifact → run in the playground app', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('composer request streams, artifact card appears, run renders the app — serverless default', async ({ page }) => {
    // The portable-hub default is byok+demo-brain: the whole build runs in-page and
    // the app lands in the USER DB (ADR-0007/0008). No hub server involvement at all.
    await page.goto('/build');

    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('build me tic-tac-toe');
    await composer.press('Enter');

    // Demo brain turn 1 streams "let me check the app template first…" then writes the artifact.
    await expect(page.getByText(/check the app template/i)).toBeVisible({ timeout: 20_000 });
    const card = page.getByTestId('artifact-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(/the oracle \(demo\)/i);

    await card.getByRole('link', { name: /run it/i }).click();
    await expect(page).toHaveURL(/\/run\//);

    // The app iframe is sandboxed exactly per C2 and executes under the injected CSP.
    const iframe = page.getByTestId('frame-wrap').locator('iframe[sandbox="allow-scripts"]');
    await expect(iframe).toBeVisible({ timeout: 20_000 });
    const app = page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
    // DEMO_APP_HTML (the tiny oracle) boots and reaches host-ready inside the sandbox.
    await expect(app.locator('#ask')).toBeEnabled({ timeout: 20_000 });
  });
});

test.describe('AC-7 part B — bridge round-trip on the production runner', () => {
  test('app-message → scripted agent turn (streamed) → JSON reply rendered by the app', async ({ page }) => {
    await page.goto(`${FIXTURE_URL}/harness.html`);
    await page.waitForFunction(() => (window as { __harnessReady?: boolean }).__harnessReady === true);

    const replyJson = '{"answer":"tic-tac-toe","message":"scripted reply"}';
    await page.evaluate(
      ({ html, replyJson }) =>
        (window as unknown as { __mount: (o: object) => void }).__mount({
          html,
          replyJson,
          // Two deltas so a cumulative streaming frame reaches the app before the terminal.
          deltas: ['{"answer":"tic-', 'tac-toe","message":"scripted reply"}'],
          delayMs: 50,
        }),
      { html: echoAppHtml(), replyJson },
    );

    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');

    // 1. Capability reveal: the app announced with its metadata.
    await page.waitForFunction(() => (window as unknown as { __announces: unknown[] }).__announces.length >= 1);
    const announce = await page.evaluate(
      () => (window as unknown as { __announces: Array<Record<string, unknown>> }).__announces[0],
    );
    expect(announce).toMatchObject({ appId: 'e2e-echo', displayName: 'e2e echo', iconColor: '#e8853b' });

    // 2. Terminal reply parsed by the host and RENDERED by the app.
    await expect(app.locator('#status')).toHaveText('done');
    await expect(app.locator('#out')).toContainText('tic-tac-toe');
    await expect(app.locator('#out')).toContainText('scripted reply');

    // 3. The transport saw exactly one host-built envelope carrying the app's action.
    const wires = await page.evaluate(() => (window as unknown as { __wires: string[] }).__wires);
    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain('"action":"probe"');
    expect(wires[0]).toContain('"snug":1'); // tagged envelope marker (buildAppRequest)

    // 4. Frame timeline: inbound announce + app-message, outbound streaming + ok terminal.
    const frames = await page.evaluate(
      () => (window as unknown as { __frames: Array<{ dir: string; type: string; streaming?: boolean; ok?: boolean }> }).__frames,
    );
    expect(frames).toContainEqual(expect.objectContaining({ dir: 'inbound', type: 'snug:app-announce' }));
    expect(frames).toContainEqual(expect.objectContaining({ dir: 'inbound', type: 'snug:app-message' }));
    expect(frames.some((f) => f.dir === 'outbound' && f.type === 'snug:app-response' && f.streaming === true)).toBe(true);
    expect(frames.some((f) => f.dir === 'outbound' && f.type === 'snug:app-response' && f.streaming === false && f.ok === true)).toBe(true);

    // 5. No false navigation cutoff anywhere in the flow.
    expect(await page.evaluate(() => (window as unknown as { __navigatedAway: number }).__navigatedAway)).toBe(0);
  });

  test('theme-change host-event reaches the running app live', async ({ page }) => {
    await page.goto(`${FIXTURE_URL}/harness.html`);
    await page.waitForFunction(() => (window as { __harnessReady?: boolean }).__harnessReady === true);
    await page.evaluate(
      ({ html }) => (window as unknown as { __mount: (o: object) => void }).__mount({ html, theme: 'dark' }),
      { html: echoAppHtml() },
    );
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#theme')).toHaveText('dark'); // from host-ready
    await page.evaluate(() => (window as unknown as { __setTheme: (t: string) => void }).__setTheme('light'));
    await expect(app.locator('#theme')).toHaveText('light'); // snug:host-event live (AC-6's runner half)
  });
});
