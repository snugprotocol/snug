// artifact.spec.ts — the host kit inside the two Claude artifact runtimes, FAKED on the
// real built page (TASK-20260905-binding-a-artifacts). The fakes record every call; the
// page is the real one, served by the suite's static server and, for the hand-in and the
// seed, re-served with blocks spliced in through `page.route` (never by writing into
// dist/ — check-host-kit refuses a second file). The REAL runtimes are the owner's walk
// (AC13), journaled with the artifact URL.
import fs from 'node:fs';

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';

import { readBundleBlocks, readDbBlock, upsertBundleBlock } from '../../../scripts/lib/page-blocks.mjs';
import { fakeRecord, installChatFake, installHostedFake } from './artifact-helpers';
import { KIT_DIST_FILE, KIT_URL, buildProbeUserFile, capsAppHtml, installRoutePolicy, watchConsole } from './helpers';

const frameElement = (page: Page): Locator => page.locator('[data-testid="frame-wrap"] iframe').first();
const appFrame = (page: Page): FrameLocator => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
const INSTALLED_ROUTE = /#\/run\/(?!starter--)[0-9a-f-]{8,}/;
const LINEAGE = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

const builtPage = (): string => fs.readFileSync(KIT_DIST_FILE, 'utf8');

/** Serve `html` at the kit URL instead of dist/ — the spliced-page shape. */
async function servePage(page: Page, html: string): Promise<void> {
  await page.route(KIT_URL, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html }));
}

async function installChessAndMove(page: Page): Promise<void> {
  await page.goto(KIT_URL);
  await page.getByRole('button', { name: 'open chess' }).click();
  await page.getByTestId('starter-install').click();
  await expect(page).toHaveURL(INSTALLED_ROUTE, { timeout: 20_000 });
  await expect(frameElement(page)).toBeVisible({ timeout: 20_000 });
  const app = appFrame(page);
  await expect(app.getByRole('grid', { name: 'chessboard' })).toBeVisible({ timeout: 30_000 });
  await app.getByRole('button', { name: /^e2 / }).click();
  await app.getByRole('button', { name: /^e4 / }).click();
}

const bundle = (html: string, name = 'Pomodoro'): string =>
  JSON.stringify({ format: 'snug-app-bundle/1', lineage: LINEAGE, sharedAt: '2026-09-05T00:00:00.000Z', app: { displayName: name, usesDb: false }, html, connections: [] });
const appHtml = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Pomodoro</title></head><body><h1 id="body">${body}</h1></body></html>`;

test.describe('A1 — the hosted artifact runtime (faked on the built page)', () => {
  test('AC1/AC10: the brain is Claude via sample — no call on load, ONE call per move on quick with cache off; the app frame cannot reach the page’s claude; net/auth false', async ({ page }) => {
    await installHostedFake(page);
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('Claude · this artifact’s viewer');
    await expect(page.getByTestId('your-file-chip')).toContainText('in this artifact');
    expect((await fakeRecord(page)).sampleCalls).toHaveLength(0); // never on load

    // The caps probe app: honest flags, the CSP signal, and the opaque-origin reach test.
    const file = await buildProbeUserFile();
    await page.goto(`${KIT_URL}#/settings`);
    page.on('dialog', (dialog) => void dialog.accept());
    await page.locator('label.file-btn', { hasText: 'import snug file' }).locator('input[type="file"]').setInputFiles({ name: 'probe.snug', mimeType: 'application/octet-stream', buffer: file });
    await page.goto(`${KIT_URL}#/`);
    await page.getByTestId('installed-tile').filter({ hasText: 'caps probe' }).locator('a.tile-link').click();
    const app = appFrame(page);
    await expect(app.locator('#status')).toHaveText(/done|error/, { timeout: 30_000 });
    const caps = JSON.parse(await app.locator('#caps').textContent().then((t) => t ?? '{}')) as Record<string, unknown>;
    expect(caps.net).toBe(false);
    expect(caps.auth).toBe(false);
    expect(caps.streaming).toBe(true);
    await expect(app.locator('#csp')).toContainText('violation:connect-src');
    await expect(app.locator('#reach')).toHaveText('parent:SecurityError top:SecurityError parent.parent:SecurityError');
    await expect(app.locator('#bridge')).toHaveText('no-reply'); // a runtime-shaped postMessage to top/parent is never answered
    const record = await fakeRecord(page);
    expect(record.sampleCalls).toHaveLength(1);
    const call = record.sampleCalls[0]!;
    expect(typeof call.input).toBe('string');
    expect(call.input as string).toContain('[SNUG_APP_REQUEST]');
    expect(call.options).toMatchObject({ cache: false, modelTier: 'quick', onText: 'fn', signal: 'signal' });
    // C1: nothing but the shaped prompt reached the host.
    for (const forbidden of ['sk-ant-e2e-must-never-be-used', 'Authorization', 'localUrl']) expect(call.input as string).not.toContain(forbidden);
    expect(policy.blocked).toEqual([]);
    // The probe's own blocked fetch logs the CSP refusal — that IS the enforcement signal, not a defect.
    expect(errors.filter((e) => !/connect-src|Refused to connect/.test(e))).toEqual([]);
  });

  test('AC1: chess plays a move answered by the fake viewer', async ({ page }) => {
    await installHostedFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    await installChessAndMove(page);
    const app = appFrame(page);
    await expect(app.getByText(/the fake viewer answers/)).toBeVisible({ timeout: 30_000 });
    const record = await fakeRecord(page);
    expect(record.sampleCalls).toHaveLength(1);
    expect(record.published).toHaveLength(0); // a move saves nothing to the artifact
  });

  test('AC5: "save to this artifact" fetches the served page, verifies it, splices the file in, publishes ONCE; a fresh browser seeds from the published page', async ({ page, browser }) => {
    await installHostedFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    await installChessAndMove(page);
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-status')).toContainText('unsaved changes');
    await page.getByTestId('your-file-save').click();
    await expect.poll(async () => (await fakeRecord(page)).published.length, { timeout: 30_000 }).toBe(1);
    const published = (await fakeRecord(page)).published[0]!;
    expect(published.startsWith('<!doctype html>')).toBe(true);
    const block = readDbBlock(published);
    expect(block?.manifest).toMatchObject({ format: 'snug-db-block/1', saved: 1 });
    expect(block!.manifest!.bytes).toBeGreaterThan(10_000);
    // Strip through the tokenizer, never a regex: the kit's own script carries the literal
    // `<script type="text/plain" id="snug-db">` text (compose.ts), which a regex would start at.
    const stripped = `${published.slice(0, block!.index!)}${published.slice(block!.end! + 1)}`;
    expect(stripped.length).toBe(builtPage().length);
    expect(stripped).toBe(builtPage());
    // The real runtime reloads the view on publish, so the record STASHES the outcome for the
    // page that comes back (the fake does not reload; the stash is what proves it). The chip's
    // own status may already read "unsaved" again — the running chess app keeps flushing its
    // state to the bucket, which is exactly the working-copy design.
    expect(await page.evaluate(() => sessionStorage.getItem('snug-host:custody-note'))).toContain('saved to this artifact (save #1)');

    // A different browser (empty bucket) opening the PUBLISHED page finds the chess app: the seed.
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await installHostedFake(fresh);
    await installRoutePolicy(fresh, { allowJsDelivr: true });
    await servePage(fresh, published);
    await fresh.goto(KIT_URL);
    await expect(fresh.getByTestId('installed-tile').filter({ hasText: /chess/i })).toHaveCount(1, { timeout: 20_000 });
    await fresh.getByTestId('your-file-chip').click();
    await expect(fresh.getByTestId('your-file-status')).toHaveCount(0);
    await context.close();
  });

  test('AC12: not_writer flips the view read-only after the first refusal — the save act disappears, the chip says export', async ({ page }) => {
    await installHostedFake(page, { publish: { reject: 'not_writer' } });
    await installRoutePolicy(page, { allowJsDelivr: true });
    await installChessAndMove(page);
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-save')).toBeVisible(); // present until the first refusal
    await page.getByTestId('your-file-save').click();
    await expect(page.getByTestId('your-file-status')).toContainText('read-only');
    await expect(page.getByTestId('your-file-save')).toHaveCount(0);
  });

  test('AC6: export leaves through downloads.save as snug-user.snug.json — the wrapper the playground imports', async ({ page }) => {
    await installHostedFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    await installChessAndMove(page);
    await page.goto(`${KIT_URL}#/settings`);
    await page.getByRole('button', { name: /export/i }).first().click();
    await expect.poll(async () => (await fakeRecord(page)).saved.length, { timeout: 20_000 }).toBe(1);
    const saved = (await fakeRecord(page)).saved[0]!;
    expect(saved.filename).toBe('snug-user.snug.json');
    expect(saved.data.startsWith('{"format":"snug-user-file/1"')).toBe(true);
    expect((JSON.parse(saved.data) as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('AC8: a bundle block on the page installs the app at boot; a changed block updates it; the same block again installs nothing twice', async ({ page }) => {
    await installHostedFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    const v1 = upsertBundleBlock(builtPage(), LINEAGE, bundle(appHtml('pomodoro v1')));
    expect(readBundleBlocks(v1)).toHaveLength(1);
    await servePage(page, v1);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('installed-tile').filter({ hasText: 'Pomodoro' })).toHaveCount(1, { timeout: 20_000 });
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-note')).toContainText('installed by your agent: Pomodoro');
    // The install is a db write behind the 250 ms persist debounce; a reload that outruns
    // it re-installs from the block on the next boot (idempotence would hide that as "installed"
    // twice). The chip's "unsaved changes" status is the STATE SIGNAL that the flush landed in
    // the bucket (the record flips dirty on the backend write) — wait on that, not on a clock.
    await expect(page.getByTestId('your-file-status')).toContainText('unsaved changes');
    await page.reload();
    await expect(page.getByTestId('installed-tile').filter({ hasText: 'Pomodoro' })).toHaveCount(1, { timeout: 20_000 });
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-note')).toHaveCount(0); // nothing handed in twice

    const v2 = upsertBundleBlock(builtPage(), LINEAGE, bundle(appHtml('pomodoro v2')));
    await page.unroute(KIT_URL);
    await servePage(page, v2);
    // A full reload (a same-URL goto is not one): the boot runs the hand-in over the new block.
    await page.reload();
    await expect(page.getByTestId('installed-tile').filter({ hasText: 'Pomodoro' })).toHaveCount(1, { timeout: 20_000 });
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-note')).toContainText('updated by your agent: Pomodoro · v2', { timeout: 15_000 });
    await page.getByTestId('installed-tile').filter({ hasText: 'Pomodoro' }).locator('a.tile-link').click();
    await expect(appFrame(page).locator('#body')).toHaveText('pomodoro v2', { timeout: 20_000 });
  });

  test('TASK-20260906 AC5: an app BUILT under the tool-free host brain announces and renders — the fake viewer copies the template out of the prompt it was sent', async ({ page }) => {
    await installHostedFake(page, { reply: { templateFromPrompt: true } });
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/build`);
    await expect(page.getByTestId('brain-chip')).toContainText('Claude · this artifact’s viewer');
    await page.getByRole('textbox', { name: 'describe your app' }).fill('build me a tiny app');
    await page.getByRole('button', { name: 'build', exact: true }).click();
    // The builder turn is ONE sample call on `default` (D15) and the artifact landing costs
    // exactly one more (contract synthesis — T4's pinned count); the prompt the builder
    // carried is SELF-SUFFICIENT: the template with the copy-exactly hooks, the persistence
    // rule, no tool it cannot call (the defect the hosted walk found — T4 journal 2026-09-06).
    await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await fakeRecord(page)).sampleCalls.length, { timeout: 15_000 }).toBe(2);
    const record = await fakeRecord(page);
    const call = record.sampleCalls[0]!;
    expect(call.options).toMatchObject({ modelTier: 'default', cache: false });
    const prompt = typeof call.input === 'string' ? call.input : (call.input as { content: string }[]).map((t) => t.content).join('\n');
    expect(prompt).toContain('## Full Template');
    expect(prompt).toContain('snug:app-announce');
    expect(prompt).toContain('## Storage Is Host-Brokered');
    expect(prompt).not.toContain('snug_app_builder');
    expect(prompt).not.toMatch(/Never write an app from memory/);
    // The built app is NOT a white page: the template renders "Connecting…" until the
    // host's ready frame answers its announce, then <main>. <main> in the DOM with the
    // connecting copy gone ⇔ the announce → host-ready round trip completed inside the
    // sandboxed frame. (Attached, not visible: the template's <main> is an empty shell
    // with no box of its own — a rule-following model fills it, the fake copies it bare.)
    await page.getByRole('link', { name: 'run it' }).click();
    await expect(page).toHaveURL(INSTALLED_ROUTE, { timeout: 20_000 });
    const app = appFrame(page);
    await expect(app.locator('main')).toBeAttached({ timeout: 30_000 });
    await expect(app.getByText('Connecting…')).toHaveCount(0);
    expect((await fakeRecord(page)).sampleCalls).toHaveLength(2); // the app itself thinks on nothing at load
    expect(record.sampleCalls[1]!.input as string).toContain("runtime contract"); // the one extra call is the synthesis
  });

  test('AC5 (artifact-static): use() resolves null for everything — nothing saves here, no save act, the demo brain', async ({ page }) => {
    await installHostedFake(page, { nulls: ['sample', 'artifact', 'downloads'] });
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    await expect(page.getByTestId('your-file-chip')).toContainText('not saved here');
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-save')).toHaveCount(0);
    await page.getByTestId('brain-chip').click();
    await expect(page.getByTestId('brain-menu')).toContainText('no host brain');
  });
});

test.describe('A2 — the chat artifact runtime (faked on the built page)', () => {
  test('AC2/AC4/AC7: window.claude.complete is the brain (one string per move, streaming false), window.storage is the file’s home across a reload, export copies', async ({ page }) => {
    await installChatFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('Claude · this chat');
    await expect(page.getByTestId('your-file-chip')).toContainText('in this chat');
    expect((await fakeRecord(page)).completeCalls).toHaveLength(0);

    const file = await buildProbeUserFile();
    await page.goto(`${KIT_URL}#/settings`);
    page.on('dialog', (dialog) => void dialog.accept());
    await page.locator('label.file-btn', { hasText: 'import snug file' }).locator('input[type="file"]').setInputFiles({ name: 'probe.snug', mimeType: 'application/octet-stream', buffer: file });
    await page.goto(`${KIT_URL}#/`);
    await page.getByTestId('installed-tile').filter({ hasText: 'caps probe' }).locator('a.tile-link').click();
    const app = appFrame(page);
    await expect(app.locator('#status')).toHaveText(/done|error/, { timeout: 30_000 });
    const caps = JSON.parse(await app.locator('#caps').textContent().then((t) => t ?? '{}')) as Record<string, unknown>;
    expect(caps.streaming).toBe(false);
    const record = await fakeRecord(page);
    expect(record.completeCalls).toHaveLength(1);
    expect(record.completeCalls[0]).toContain('[SNUG_APP_REQUEST]');
    // The file lives in window.storage: chunks + manifest under the kit's prefix, and a reload
    // finds the app. The write sits behind the persist debounce — poll the fake's record.
    await expect.poll(async () => Object.keys((await fakeRecord(page)).storage).some((k) => k.startsWith('snug-user/user.snug'))).toBe(true);
    await page.goto(`${KIT_URL}#/`);
    await page.reload();
    await expect(page.getByTestId('installed-tile').filter({ hasText: 'caps probe' })).toHaveCount(1, { timeout: 20_000 });

    // Export: no downloads namespace → the copy path, named on the chip.
    await page.goto(`${KIT_URL}#/settings`);
    await page.getByRole('button', { name: /export/i }).first().click();
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-note')).toContainText(/copied \d+ KB/, { timeout: 20_000 });
  });
});
