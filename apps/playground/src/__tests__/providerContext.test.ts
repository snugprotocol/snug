/**
 * TASK-20260815-provider-chat-lane AC3 (ADR-0031 §2) — the provider lane's context
 * assembly.
 *
 * THE ONE RULE: connection FACTS travel, credentials and private network facts never do.
 * The fixture is deliberately hostile (plan-review F10): a credential holding `+`, `=`,
 * and a space (URL-safe-looking values once made four C1 scrub tests decorative), an
 * approved LAN-class row whose collected bridge address sits in the frozen ceiling, and
 * declared/revoked rows that must be ABSENT rather than merely unlabeled.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import { installTestUserDb } from './userdbTestHelper.js';
import {
  buildProviderContextBlock,
  connectionSummaries,
  listProviderConnectionFacts,
} from '../agent/providerContext.js';
import { getUserDb } from '../state/userdb.js';

const APP = 'app-provider-context';
const HOSTILE_SECRET = 'sk+live/rotate= trailing';
const BRIDGE = '192.168.1.50';

async function seed(): Promise<Awaited<ReturnType<typeof getUserDb>>> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Party Deck', html: '<p>deck</p>' });

  // Approved OAuth row — MULTI-host ceiling (api + token-endpoint hosts), scopes present.
  db.putDeclaredConnection(
    APP,
    'melodine',
    {
      slot: 'melodine',
      kind: 'oauth2_auth_code' as const,
      provider: { name: 'Melodine Streaming' },
      endpoints: {
        authorizeUrl: 'https://accounts.melodine.example/authorize',
        tokenUrl: 'https://accounts.melodine.example/token',
      },
      scopes: ['read-history', 'control-playback'],
      declaredApiHosts: ['api.melodine.example'],
    },
    'inference',
  );
  db.approveConnection(APP, 'melodine');

  // Approved LAN-class row — collected bridge address frozen into the ceiling.
  db.setSecret(authConnectionCredentialSecretKey(APP, 'bridge', 'application_key'), HOSTILE_SECRET);
  db.putDeclaredConnection(
    APP,
    'bridge',
    {
      slot: 'bridge',
      kind: 'api_key' as const,
      provider: { name: 'Glow Bridge' },
      fields: [{ key: 'application_key', label: 'Application key', type: 'secret' as const }],
      request: { headerTemplate: { 'glow-application-key': '{{application_key}}' } },
      lanHost: { class: 'rfc1918-ipv4-literal' as const, label: 'Bridge IP address' },
      declaredApiHosts: [BRIDGE],
    },
    'inference',
  );
  db.approveConnection(APP, 'bridge');

  // Declared-only and revoked rows — must be absent from every provider-lane surface.
  db.putDeclaredConnection(
    APP,
    'declared-only',
    {
      slot: 'declared-only',
      kind: 'none' as const,
      provider: { name: 'Declared Only Service' },
      declaredApiHosts: ['api.declared.example'],
    },
    'inference',
  );
  db.putDeclaredConnection(
    APP,
    'revoked-slot',
    {
      slot: 'revoked-slot',
      kind: 'none' as const,
      provider: { name: 'Revoked Service' },
      declaredApiHosts: ['api.revoked.example'],
    },
    'inference',
  );
  db.approveConnection(APP, 'revoked-slot');
  db.revokeConnection(APP, 'revoked-slot');
  return db;
}

beforeEach(async () => {
  await installTestUserDb();
});

describe('listProviderConnectionFacts — approved rows only, facts only', () => {
  it('returns the two approved rows with provider names, public hosts, scopes, and LAN classification', async () => {
    const db = await seed();
    const facts = listProviderConnectionFacts(db, APP);
    expect(facts.map((fact) => fact.slot).sort()).toEqual(['bridge', 'melodine']);

    const melodine = facts.find((fact) => fact.slot === 'melodine');
    expect(melodine?.providerName).toBe('Melodine Streaming');
    // The ceiling is the DERIVED union: api host + the OAuth endpoint host (multi-host —
    // exactly why literal addressing must be taught, plan-review F2).
    expect(melodine?.publicHosts).toContain('api.melodine.example');
    expect(melodine?.lan).toBe(false);
    expect(melodine?.scopes).toEqual(['read-history', 'control-playback']);

    const bridge = facts.find((fact) => fact.slot === 'bridge');
    expect(bridge?.lan).toBe(true);
    // The collected private address is a ceiling fact, never a lane fact.
    expect(bridge?.publicHosts).toEqual([]);
  });

  it('excludes declared-only and revoked rows entirely', async () => {
    const db = await seed();
    const slots = listProviderConnectionFacts(db, APP).map((fact) => fact.slot);
    expect(slots).not.toContain('declared-only');
    expect(slots).not.toContain('revoked-slot');
  });
});

describe('connectionSummaries — the classifier seat', () => {
  it('renders `slot (Provider Name)` for approved rows only', async () => {
    const db = await seed();
    const summaries = connectionSummaries(db, APP);
    expect(summaries).toContain('melodine (Melodine Streaming)');
    expect(summaries).toContain('bridge (Glow Bridge)');
    expect(summaries.join('\n')).not.toContain('Declared Only Service');
    expect(summaries.join('\n')).not.toContain('Revoked Service');
  });
});

describe('buildProviderContextBlock — C1 at the assembly altitude (AC3)', () => {
  it('teaches literal addressing for public rows and symbolic addressing for LAN rows', async () => {
    const db = await seed();
    const block = buildProviderContextBlock(db, APP) ?? '';
    expect(block).toContain('api.melodine.example');
    expect(block).toContain('snug-connection://bridge/');
    expect(block).toContain('read-history');
  });

  it('NEVER carries a credential value, an auth: KV key, or a private network literal', async () => {
    const db = await seed();
    const block = buildProviderContextBlock(db, APP) ?? '';
    expect(block).not.toContain(HOSTILE_SECRET);
    // Fragments too: a partial leak through a template render would evade the full-string check.
    expect(block).not.toContain('sk+live');
    expect(block).not.toContain('auth:');
    expect(block).not.toContain(BRIDGE);
    expect(block).not.toMatch(/\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('omits declared/revoked rows and returns undefined when nothing is approved', async () => {
    const db = await seed();
    const block = buildProviderContextBlock(db, APP) ?? '';
    expect(block).not.toContain('declared-only');
    expect(block).not.toContain('api.revoked.example');

    db.installApp({ appId: 'bare-app', displayName: 'Bare', html: '<p>x</p>' });
    expect(buildProviderContextBlock(db, 'bare-app')).toBeUndefined();
  });
});
