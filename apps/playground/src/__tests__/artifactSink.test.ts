// Child-3 AC1/AC2 (TASK-20260803-versions-chat): host-side target pinning (F9) —
// builder threads install-then-version; per-app chats version the pinned app; the
// model never chooses the target.

import { describe, expect, it } from 'vitest';

import { createAppTargetSink } from '../agent/artifactSink.js';
import { installTestUserDb } from './userdbTestHelper.js';

const html = (v: string): string => `<!DOCTYPE html><html><head><title>App ${v}</title></head></html>`;

describe('createAppTargetSink — builder thread rule', () => {
  it('first write installs a new app; later writes version the SAME app', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const first = await sink.write(html('one'), 'Tic Tac Toe');
    expect(first.version).toBe(1);
    const second = await sink.write(html('two'));
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(db.listApps()).toHaveLength(1);
    expect(db.getAppHtml(first.id)).toBe(html('two'));
    expect(db.listAppVersions(first.id).map((v) => v.version)).toEqual([2, 1]);
  });

  it('a NEW sink (new thread) installs a new app — the escape hatch', async () => {
    const db = await installTestUserDb();
    const a = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const b = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const first = await a.write(html('a'));
    const second = await b.write(html('b'));
    expect(second.id).not.toBe(first.id);
    expect(db.listApps()).toHaveLength(2);
  });
});

describe('createAppTargetSink — pinned per-app chat', () => {
  it('every write versions the pinned app, never a new one', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: html('v1') });
    const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
    const write = await sink.write(html('v2'));
    expect(write).toMatchObject({ id: app.appId, displayName: 'Chess', version: 2 });
    expect(db.listApps()).toHaveLength(1);
    expect(db.getAppHtml(app.appId)).toBe(html('v2'));
  });

  it('a pinned id with no row installs UNDER the pinned id', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ pinnedAppId: 'preview-1', getDb: () => Promise.resolve(db) });
    const write = await sink.write(html('p'));
    expect(write).toMatchObject({ id: 'preview-1', version: 1 });
    expect(db.getApp('preview-1')).toBeDefined();
  });
});
