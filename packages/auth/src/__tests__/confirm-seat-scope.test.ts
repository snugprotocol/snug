/**
 * WHAT THE EXECUTOR TELLS ITS CONFIRM SEAT (ADR-0033 §3).
 *
 * The standing gate has to answer a question about a THREAD, but the executor's confirm seat
 * historically carried `{appId, host, method, url}` — enough to identify a host, not enough
 * to identify what is being sent or to which conversation. ADR-0033 is explicit that the
 * thread must be derived from the request, and that a send whose body JID disagrees with its
 * path JID must REFUSE rather than pick one; neither is possible without the body.
 *
 * So the seat gains two OPTIONAL fields, `slot` and `body`. Optional is the whole design:
 * every existing caller — including the wizard's probe, which shares that gate as a
 * module-level singleton — keeps its current behaviour byte-for-byte, and the ABSENCE of
 * `slot` on the probe path is precisely what keeps a standing grant off it.
 *
 * The gate's own logic lives in `standing-approval.test.ts`. What is asserted HERE is that
 * the executor actually hands over what that logic needs — the cross-layer seam that
 * otherwise ships green on both sides while nothing connects them (lessons.md 2026-08-13).
 */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUS,
  type ConnectionRequirement,
  type ConnectionStatus,
} from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';
import { createConnectedFetch, type NetConnectionRow } from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';
import type { NetConfirmRequest } from '../session-confirm.js';

const APP = 'app-1';
const SLOT = 'example';

/** The in-memory secret quartet each executor suite defines locally (not a shared export). */
function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

const spec: ConnectionRequirement = {
  slot: SLOT,
  kind: 'api_key',
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

const row: NetConnectionRow = {
  appId: APP,
  slot: SLOT,
  requirement: spec,
  status: CONNECTION_STATUS.approved as ConnectionStatus,
  allowedHosts: ['api.example.com'],
};

function harness() {
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), 'k-123');
  const seen: NetConfirmRequest[] = [];
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: () => [row] },
    fetchImpl: async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    confirmGate: {
      confirm(request) {
        seen.push(request);
        return true;
      },
    },
  });
  return { executor, seen };
}

describe('the confirm seat carries what a thread decision needs', () => {
  it('a mutating request hands the confirm gate its BODY', async () => {
    const { executor, seen } = harness();
    await executor.execute(APP, {
      url: 'https://api.example.com/chats/thread-a/messages',
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('a bodiless mutating request leaves `body` undefined rather than inventing one', async () => {
    const { executor, seen } = harness();
    await executor.execute(APP, {
      url: 'https://api.example.com/chats/thread-a/messages',
      method: 'POST',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBeUndefined();
  });

  it('an absolute-URL request carries NO slot — the property that keeps grants off the probe', async () => {
    // The wizard's probe reaches the executor by absolute URL, never by `snug-connection://`,
    // so its confirm request has no slot and the standing gate refuses to answer for it.
    const { executor, seen } = harness();
    await executor.execute(APP, {
      url: 'https://api.example.com/chats/thread-a/messages',
      method: 'POST',
      body: '{}',
    });

    expect(seen[0]!.slot).toBeUndefined();
  });

  it('a GET never reaches the confirm seat at all', async () => {
    const { executor, seen } = harness();
    await executor.execute(APP, { url: 'https://api.example.com/chats' });
    expect(seen).toHaveLength(0);
  });
});
