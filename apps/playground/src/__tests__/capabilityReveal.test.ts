// Capability reveal (task AC-3): the header/tiles start anonymous and upgrade when
// the app announces; announce metadata persists for the hub's gradient tiles.

import { FRAME_TYPES, PROTOCOL_VERSION, type AppAnnounceFrame } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { revealReduce, initialRevealState } from '../run/capability.js';
import { appMetaStore, getAppMeta, recordAppMeta } from '../state/appMeta.js';
import { installTestUserDb } from './userdbTestHelper.js';

const announce: AppAnnounceFrame = {
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.announce,
  appId: 'chess-coach',
  displayName: 'chess coach',
  description: 'plays you, politely',
  iconEmoji: '♞',
  iconColor: '#8b5cf6',
};

describe('revealReduce', () => {
  it('starts connecting and goes live on announce with display metadata', () => {
    expect(initialRevealState.phase).toBe('connecting');
    const next = revealReduce(initialRevealState, announce);
    expect(next).toEqual({
      phase: 'live',
      meta: { displayName: 'chess coach', description: 'plays you, politely', iconEmoji: '♞', iconColor: '#8b5cf6' },
    });
  });

  it('omits absent optional fields instead of carrying undefined', () => {
    const bare: AppAnnounceFrame = { v: PROTOCOL_VERSION, type: FRAME_TYPES.announce, appId: 'x', displayName: 'bare' };
    const next = revealReduce(initialRevealState, bare);
    expect(next.phase).toBe('live');
    if (next.phase === 'live') expect(Object.keys(next.meta)).toEqual(['displayName']);
  });
});

describe('recordAppMeta', () => {
  beforeEach(() => {
    appMetaStore.set({});
  });

  it('merges partial updates in the store and persists them onto the app row in the user DB', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ appId: 'art-1', displayName: 'untitled app', html: '<html></html>' });
    recordAppMeta(app.appId, { displayName: 'chess coach', iconEmoji: '♞', iconColor: '#8b5cf6' });
    recordAppMeta(app.appId, { usesDb: true });
    expect(getAppMeta(app.appId)).toEqual({
      displayName: 'chess coach',
      iconEmoji: '♞',
      iconColor: '#8b5cf6',
      usesDb: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain the async DB write
    const row = db.getApp(app.appId);
    expect(row).toMatchObject({ displayName: 'chess coach', iconColor: '#8b5cf6', usesDb: true });
  });
});
