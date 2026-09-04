/**
 * TASK-20260904-app-sharing, Phase 1.2 — the `shared` admission channel (ADR-0063 §3,
 * AC7). A requirement that arrived inside an app bundle from a third party is admitted
 * on its OWN channel, and every ADR-0016 guard is pinned on that channel explicitly —
 * not inherited by the assumption that "every non-registry channel is strong". The
 * guards ARE keyed on `channel !== 'registry'` today; these tests are what keeps a
 * future exemption from quietly including `shared`.
 */

import { CONNECTION_PROVENANCES } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';
import { ADMISSION_CHANNELS, admitConnectionRequirement } from '../requirement-admission.js';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

const USER_LAYER_SEAT = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
} as const;

describe('the shared channel exists and is structurally the persisted provenance set', () => {
  it('ADMISSION_CHANNELS === CONNECTION_PROVENANCES (a channel and the provenance it writes can never drift)', () => {
    expect([...ADMISSION_CHANNELS]).toEqual([...CONNECTION_PROVENANCES]);
    expect(ADMISSION_CHANNELS).toContain('shared');
  });
});

describe('Guard 1 on shared — userLayer is registry-synthesized only', () => {
  it('refuses a userLayer arriving in a bundle', () => {
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotify' },
        declaredApiHosts: ['api.spotify.com'],
        userLayer: USER_LAYER_SEAT,
      },
      { channel: 'shared' },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe('userLayer');
  });
});

describe('Guard 2 / 2b on shared — the registry-borrow ban', () => {
  const spotify = WELL_KNOWN_PROVIDERS_REGISTRY['spotify'];

  it('a BARE borrower (name + kind + hosts, no prompt seats) is admitted with the registry’s pinned seats substituted', () => {
    const result = admitConnectionRequirement(
      { slot: 'spotify', kind: spotify?.kind ?? 'oauth2_auth_code', provider: { name: 'Spotify' }, declaredApiHosts: ['evil.example'] },
      { channel: 'shared' },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.borrowed).toBe(true);
    expect(result.borrowedFrom).toBe('spotify');
    const admitted = result.requirement as { declaredApiHosts?: string[]; provider: { name: string } };
    expect(admitted.declaredApiHosts).not.toContain('evil.example');
    expect(admitted.provider.name).toBe(spotify?.displayName);
  });

  it('a borrower that AUTHORS fields / headerTemplate / testRequest is refused outright', () => {
    for (const seat of [
      { fields: [{ key: 'password', label: 'Paste your Spotify password', type: 'secret' }] },
      { request: { headerTemplate: { 'X-Token': '{{api_key}}' } } },
      { testRequest: { method: 'GET', pathAndQuery: '/v1/me' } },
    ]) {
      const result = admitConnectionRequirement(
        { kind: 'api_key', provider: { name: 'Spotify' }, declaredApiHosts: ['api.spotify.com'], ...seat },
        { channel: 'shared' },
      );
      expect(result.ok, `authored seat ${Object.keys(seat)[0]} was admitted`).toBe(false);
      expect(result.borrowed).toBe(true);
      // The refused value is still the SUBSTITUTED one — a renderer never shows the attacker's hosts.
      const refused = result.requirement as { declaredApiHosts?: string[] };
      expect(refused.declaredApiHosts).not.toContain('evil.example');
    }
  });

  it('host-intersection borrow catches a renamed brand (the ASCII lookalike the confusable guard does not claim)', () => {
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: '5potify' },
        fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        declaredApiHosts: ['api.spotify.com'],
      },
      { channel: 'shared' },
    );
    expect(result.ok).toBe(false);
    expect(result.borrowedFrom).toBe('spotify');
  });

  it('an unaffiliated provider passes untouched — the ban is scoped to borrows', () => {
    const requirement = {
      slot: 'widgets',
      kind: 'api_key',
      provider: { name: 'Unaffiliated Widgets' },
      fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
      declaredApiHosts: ['api.widgets.example'],
    };
    const result = admitConnectionRequirement(requirement, { channel: 'shared' });
    expect(result.ok).toBe(true);
    expect(result.borrowed).toBeUndefined();
    expect(result.requirement).toBe(requirement);
  });
});

describe('Guard 2c on shared — a LAN-class borrow must carry a LAN-class host', () => {
  it('refuses a public host declared for a LAN-class provider', () => {
    const hue = WELL_KNOWN_PROVIDERS_REGISTRY['hue'];
    expect(hue?.lanHost).toBeDefined();
    const result = admitConnectionRequirement(
      { kind: hue?.kind ?? 'api_key', provider: { name: hue?.displayName ?? 'Philips Hue' }, declaredApiHosts: ['bridge.evil.example'] },
      { channel: 'shared' },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe('declaredApiHosts');
  });
});
