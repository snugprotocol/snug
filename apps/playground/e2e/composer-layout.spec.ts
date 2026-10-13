// composer-layout.spec.ts — TASK-20261013-rail-chat-access AC6/AC7: the *fetch new data first*
// toggle in the rail chat's composer, measured in a real layout (inspector-layout.spec.ts's way:
// the shipped tokens.css + app.css around RailChat's composer markup — the class names RailChat
// renders are pinned in src/__tests__/railChatComposer.test.tsx).
//
// THE OWNER'S REPORT: the toggle sat between the input and *send*, "practically squeezing it so
// much that it is unusable" — a long label in the composer's flex row beside a `flex: 1` textarea;
// and "clicking on the button does nothing" — the press arms the next send (D-PR5-20), and the
// armed look was a ghost button turning a barely lighter grey.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const tokens = readFileSync(resolve(appRoot, 'src/theme/tokens.css'), 'utf8');
const app = readFileSync(resolve(appRoot, 'src/theme/app.css'), 'utf8');

/** The longest label the toggle can carry: two sources by name, the rest counted. */
const LABEL = 'fetch new data from Weather Station and Inbox Copilot first (+1 not asked)';

const pageHtml = (railWidth: number, pressed: boolean): string => `<!doctype html>
<html data-theme="dark" style="--rail-width:${railWidth}px"><head><style>
${tokens}
${app}
</style></head><body>
<div class="run-layout" style="height:640px">
  <div class="run-stage"><div class="frame-wrap"></div></div>
  <aside class="rail"><div class="rail-body"><div class="rail-chat">
    <div class="chat-log"></div>
    <div class="composer rail-composer">
      <div class="chat-fetch">
        <button type="button" class="btn${pressed ? '' : ' btn-ghost'} chat-fetch-toggle" aria-pressed="${pressed}" id="toggle">${LABEL}</button>
        ${pressed ? '<p class="hint chat-fetch-armed" role="status">your next message asks Weather Station and Inbox Copilot for new data first</p>' : ''}
      </div>
      <textarea rows="1" id="input" placeholder="ask for a change…"></textarea>
      <button type="button" class="btn btn-primary" id="send">send</button>
    </div>
  </div></div></aside>
</div></body></html>`;

test.describe('AC6 — the fetch toggle never squeezes the input', () => {
  for (const railWidth of [280, 340, 520]) {
    test(`at a ${railWidth}px rail the input keeps most of the row and the toggle sits on its own row above it`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 700 });
      await page.setContent(pageHtml(railWidth, false));
      const composer = (await page.locator('.rail-composer').boundingBox())!;
      const input = (await page.locator('#input').boundingBox())!;
      const toggle = (await page.locator('#toggle').boundingBox())!;
      const send = (await page.locator('#send').boundingBox())!;
      expect(input.width / composer.width, `the input is ${Math.round(input.width)}px of a ${Math.round(composer.width)}px row`).toBeGreaterThan(0.6);
      expect(toggle.y + toggle.height, 'the toggle ends above the input').toBeLessThanOrEqual(input.y + 1);
      expect(Math.abs(send.y + send.height - (input.y + input.height)), 'send stays on the input’s row').toBeLessThan(2);
      const overflow = await page.locator('.rail-body').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(1);
    });
  }
});

test.describe('AC7 — pressed reads at a glance', () => {
  test('the pressed toggle differs from the unpressed one in its border and its mark, and the armed line shows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    const look = async (pressed: boolean) => {
      await page.setContent(pageHtml(340, pressed));
      return page.locator('#toggle').evaluate((el) => ({
        border: getComputedStyle(el).borderTopColor,
        mark: getComputedStyle(el, '::before').content,
      }));
    };
    const off = await look(false);
    const on = await look(true);
    expect(on.border).not.toBe(off.border);
    expect(on.mark).not.toBe(off.mark);
    await expect(page.locator('.chat-fetch-armed')).toBeVisible();
  });
});
