// Capability reveal (task AC-3): the header/tiles start anonymous and upgrade when
// the app announces; announce metadata persists for the hub's gradient tiles.

import { FRAME_TYPES, PROTOCOL_VERSION, type AppAnnounceFrame } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { revealReduce, initialRevealState } from '../run/capability.js';
import { appMetaStore, getAppMeta, recordAppMeta } from '../state/appMeta.js';

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
    localStorage.clear();
    appMetaStore.set({});
  });

  it('persists announce metadata per library id and merges partial updates', () => {
    recordAppMeta('art-1', { displayName: 'chess coach', iconEmoji: '♞', iconColor: '#8b5cf6' });
    recordAppMeta('art-1', { usesDb: true });
    expect(getAppMeta('art-1')).toEqual({ displayName: 'chess coach', iconEmoji: '♞', iconColor: '#8b5cf6', usesDb: true });
    const persisted = JSON.parse(localStorage.getItem('snug:app-meta') ?? '{}') as Record<string, unknown>;
    expect(persisted['art-1']).toMatchObject({ iconColor: '#8b5cf6', usesDb: true });
  });
});
