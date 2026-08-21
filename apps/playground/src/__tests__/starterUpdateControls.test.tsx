// starterUpdateControls.test.tsx — TASK-20260820-starter-updates (ADR-0045), AC4/AC5/AC6.
//
// The run-header surface of the update channel: the version chip and "release notes"
// link for every installed starter (AC4), the update button when the bundle is ahead
// (AC5), and the edited-copy confirm dialog (AC6 — cancel writes NOTHING, asserted as a
// version COUNT per lessons.md 2026-08-20 "count the writes, do not trust the status").

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { starterVersionSettingKey } from '@snugprotocol/db';

import { StarterUpdateControls } from '../run/StarterUpdateControls.js';
import {
  __resetDeclarationManifestsForTests,
  __setDeclarationManifestsForTests,
} from '../starter/starterDeclaration.js';
import { __resetStarterMetaFixturesForTests, __setStarterMetaFixturesForTests } from '../starter/starterMeta.js';
import {
  __resetStarterUpdateFixturesForTests,
  __setStarterUpdateFixturesForTests,
} from '../starter/starterUpdate.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FOLDER = 'weather';
const SOURCE = `starter:${FOLDER}`;
const HTML_V1 = '<html><body>v1</body></html>';
const HTML_V2 = '<html><body>v2</body></html>';

const meta = (version: number): string =>
  JSON.stringify({
    version,
    appHash: 'unused',
    changelog: Array.from({ length: version }, (_, i) => ({
      version: version - i,
      date: '2026-08-21',
      title: version - i === 2 ? 'Sharper forecasts' : 'Initial release',
      sections: [{ title: "What's new", items: [`Notes for v${version - i}.`] }],
    })),
  });

function setBundle(html: string, version: number): void {
  __setStarterMetaFixturesForTests({ [FOLDER]: meta(version) });
  __setStarterUpdateFixturesForTests({ [FOLDER]: html });
  __setDeclarationManifestsForTests({});
}

let container: HTMLDivElement;
let root: Root;
let db: UserDb;
let updatedWith: number[];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/** Wait for a CONDITION, not a fixed delay — the update act chains several awaits. */
async function settleUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await settle();
    if (cond()) return;
  }
  throw new Error(`timed out waiting for ${what} — page: ${container.textContent ?? ''}`);
}

async function render(appId: string): Promise<void> {
  await act(async () => {
    root.render(<StarterUpdateControls appId={appId} refreshToken={0} onUpdated={(v) => updatedWith.push(v)} />);
  });
  await settle();
}

function installAt(html: string, version: number): string {
  const app = db.installApp({ displayName: 'Weather', html, installSource: SOURCE });
  db.setSetting(starterVersionSettingKey(app.appId), version);
  return app.appId;
}

beforeEach(async () => {
  db = await installTestUserDb();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  updatedWith = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetStarterMetaFixturesForTests();
  __resetStarterUpdateFixturesForTests();
  __resetDeclarationManifestsForTests();
});

const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);

describe('the version chip and release notes link (AC4)', () => {
  it('an up-to-date installed starter shows its version and the release notes link — no update button', async () => {
    setBundle(HTML_V1, 1);
    await render(installAt(HTML_V1, 1));
    expect(container.textContent).toContain('v1');
    expect(button('show release notes')).toBeDefined();
    expect(button('update this app to v1')).toBeUndefined();
  });

  it('a non-starter app renders nothing', async () => {
    setBundle(HTML_V1, 1);
    const app = db.installApp({ displayName: 'Hand-built', html: HTML_V1 });
    await render(app.appId);
    expect(container.textContent).toBe('');
  });

  it('the release notes sheet renders the changelog, Tesla-style sections included', async () => {
    setBundle(HTML_V2, 2);
    await render(installAt(HTML_V1, 1));
    act(() => button('show release notes')!.click());
    await settle();
    const sheet = container.querySelector('.release-notes-card');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain('Sharper forecasts');
    expect(sheet!.textContent).toContain('Notes for v2.');
    expect(sheet!.textContent).toContain('Notes for v1.');
    // The version the user is ON is marked; the newer one reads as new.
    expect(sheet!.querySelector('[data-testid="release-installed-v1"]')).not.toBeNull();
    expect(sheet!.querySelector('[data-testid="release-new-v2"]')).not.toBeNull();
    act(() => button('close release notes')!.click());
    await settle();
    expect(container.querySelector('.release-notes-card')).toBeNull();
  });
});

describe('the update button (AC5)', () => {
  it('an unedited copy updates in ONE click and reloads', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAt(HTML_V1, 1);
    await render(appId);
    const update = button('update this app to v2');
    expect(update).toBeDefined();
    act(() => update!.click());
    // Wait on the CALLBACK, not the html: the act writes html → connections → docs → key
    // before reporting, and observing the first write mid-act would race the rest.
    await settleUntil(() => updatedWith.length > 0, 'the one-click update to complete');
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(db.getSetting(starterVersionSettingKey(appId))).toBe(2);
    expect(updatedWith).toEqual([2]);
    // No confirm dialog was involved:
    expect(container.querySelector('.net-confirm-card')).toBeNull();
  });
});

describe('the edited-copy confirm (AC6)', () => {
  it('cancel writes nothing — version count unchanged, no reload', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAt(HTML_V1, 1);
    db.saveAppVersion(appId, '<html>my remix</html>', 'user edit');
    const versionsBefore = db.listAppVersions(appId).length;
    await render(appId);
    act(() => button('update this app to v2')!.click());
    await settle();
    const card = container.querySelector('.net-confirm-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('customized');
    act(() => button('keep my version')!.click());
    await settle();
    expect(db.listAppVersions(appId)).toHaveLength(versionsBefore);
    expect(db.getAppHtml(appId)).toBe('<html>my remix</html>');
    expect(updatedWith).toEqual([]);
  });

  it('confirm applies the update; the edited version stays in history', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAt(HTML_V1, 1);
    db.saveAppVersion(appId, '<html>my remix</html>', 'user edit');
    await render(appId);
    act(() => button('update this app to v2')!.click());
    await settle();
    act(() => button('update and keep my edits in history')!.click());
    await settleUntil(() => updatedWith.length > 0, 'the confirmed update to complete');
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(updatedWith).toEqual([2]);
    expect(db.listAppVersions(appId).some((v) => v.note === 'user edit')).toBe(true);
  });
});
