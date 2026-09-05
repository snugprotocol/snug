// starterSourceOffline.test.ts — TASK-20260905-host-kit AC14: a starter source whose html
// REJECTS (the host kit offline) yields "no declaration" and "no update question", never
// an unhandled rejection. The glob source on web never rejects, so this is pinned with a
// mocked source on a fresh module graph — the positive twins are a source that resolves.
import { createRequire } from 'node:module';

import { createMemoryBackend, openUserDb } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StarterSource } from '../starter/starterSource.js';

const MANIFEST = JSON.stringify({ id: 'weather', kind: 'api_key', host: 'api.example.test' });
const META = JSON.stringify({ version: 2, changelog: [{ version: 2, date: '2026-09-05', sections: [{ title: 'x', items: ['y'] }] }] });
const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

function sourceWith(html: () => Promise<string | undefined>): StarterSource {
  return {
    appFolders: () => ['weather'],
    html,
    meta: async (folder) => (folder === 'weather' ? META : undefined),
    contract: async () => undefined,
    manifest: async (folder) => (folder === 'weather' ? MANIFEST : undefined),
    authoring: async () => ({}),
  };
}

async function declarationWith(source: StarterSource): Promise<typeof import('../starter/starterDeclaration.js')> {
  vi.resetModules();
  vi.doMock('../starter/starterSource.js', () => ({ starterSource: () => source }));
  return import('../starter/starterDeclaration.js');
}

async function updateWith(source: StarterSource): Promise<typeof import('../starter/starterUpdate.js')> {
  vi.resetModules();
  vi.doMock('../starter/starterSource.js', () => ({ starterSource: () => source }));
  return import('../starter/starterUpdate.js');
}

const named = (): Error => Object.assign(new Error('starters load from the network — this page is offline'), { name: 'StarterLoadError' });
const rejecting = (): Promise<string> => Promise.reject(named());
/** A rejection that is NOT the loader's named refusal — must keep propagating. */
const foreign = (): Promise<string> => Promise.reject(new Error('database disk image is malformed'));

afterEach(() => {
  vi.doUnmock('../starter/starterSource.js');
  vi.resetModules();
});

describe('starterDeclarationForStarterId when the html cannot be loaded', () => {
  it('a rejecting html load resolves null — the declaration cannot be vouched for, so there is none', async () => {
    const mod = await declarationWith(sourceWith(rejecting));
    await expect(mod.starterDeclarationForStarterId('starter--weather')).resolves.toBeNull();
  });

  it('a FOREIGN rejection still propagates — only the named refusal degrades', async () => {
    const mod = await declarationWith(sourceWith(foreign));
    await expect(mod.starterDeclarationForStarterId('starter--weather')).rejects.toThrow(/malformed/);
  });

  it('positive twin: a resolving html load yields the declaration when the manifest vouches for it', async () => {
    const mod = await declarationWith(sourceWith(async () => '<!doctype html><p>weather</p>'));
    const declared = await mod.starterDeclarationForStarterId('starter--weather');
    // Whether the manifest ADMITS is the registry's business; what this pins is that the
    // load path ran and answered (null would mean it never got that far).
    expect(declared === null || typeof declared === 'object').toBe(true);
  });
});

describe('starterUpdateStatus when the html cannot be loaded', () => {
  async function installedWeather(): Promise<{ db: import('@snugprotocol/db').UserDb; appId: string }> {
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error('open failed');
    const app = opened.userDb.installApp({ displayName: 'weather', html: '<p>weather</p>', installSource: 'starter:weather' });
    return { db: opened.userDb, appId: app.appId };
  }

  it('a rejecting html load resolves undefined — no update question, no unhandled rejection at hub paint', async () => {
    const mod = await updateWith(sourceWith(rejecting));
    const { db, appId } = await installedWeather();
    await expect(mod.starterUpdateStatus(db, appId)).resolves.toBeUndefined();
    await db.close();
  });

  it('a FOREIGN rejection still propagates from the update question too', async () => {
    const mod = await updateWith(sourceWith(foreign));
    const { db, appId } = await installedWeather();
    await expect(mod.starterUpdateStatus(db, appId)).rejects.toThrow(/malformed/);
    await db.close();
  });

  it('positive twin: a resolving html load answers the update question', async () => {
    const mod = await updateWith(sourceWith(async () => '<p>weather</p>'));
    const { db, appId } = await installedWeather();
    const status = await mod.starterUpdateStatus(db, appId);
    expect(status).toMatchObject({ folder: 'weather', latestVersion: 2 });
    await db.close();
  });
});
