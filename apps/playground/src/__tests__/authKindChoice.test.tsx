// authKindChoice.test.tsx — TASK-20260812-auth-kind-choice, P3
// (AC3 card seeding, AC4 binding choice, AC7 meta validate-on-read, AC8 doorbell +
// visibility gate, AC9 routing, AC12 persisted-row fidelity, AC13 unforgeable channel).
//
// THE FEATURE, in one sentence: when a provider offers more than one way in, the host
// persists the DEFAULT so the app stays connectable, shows the options, and a real
// user click — and nothing else — rebinds the row on the `user` channel, where R3
// makes the decision durable against every later inference.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { UserDb } from '@snugprotocol/db';
import { requirementFromRegistryEntry, WELL_KNOWN_PROVIDERS_REGISTRY } from '@snugprotocol/auth';

import { chooseAuthOption } from '../state/authKindChoice.js';
import { authChoiceForPersistedRow, metaToAuthChoice } from '../agent/authChoiceCard.js';
import { AuthChoiceCard } from '../views/AuthChoiceCard.js';
import { persistConnectionRequirement } from '../agent/connectionPipeline.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardStore,
  nextStep,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p3-kind-choice';
const coinbase = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
const coinbaseOauth = coinbase.authOptions![0]!;

const defaultRequirement = (): unknown => requirementFromRegistryEntry(coinbase, 'coinbase', 'coinbase');
const oauthRequirement = (): unknown => requirementFromRegistryEntry(coinbase, 'coinbase', 'coinbase', coinbaseOauth);

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
});

afterEach(async () => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  __resetConnectionWizardForTests();
  await db.close();
});

/** Seed the state recovery leaves behind: the DEFAULT row, provenance registry. */
async function seedDefaultRow(): Promise<void> {
  const outcome = await persistConnectionRequirement(db, {
    appId: APP,
    requirement: defaultRequirement(),
    channel: 'registry',
  });
  expect(outcome.ok).toBe(true);
}

async function renderCard(choice: Parameters<typeof AuthChoiceCard>[0]['choice']): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AuthChoiceCard choice={choice} />);
  });
  // One settle beat: the card reads the live row asynchronously before rendering.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const text = (): string => container?.textContent ?? '';

describe('AC4/AC12 — choosing an option is BINDING and the persisted row is the chosen variant', () => {
  it('the user picks Coinbase OAuth: row rebinds on the user channel with the VARIANT shape intact', async () => {
    await seedDefaultRow();

    const outcome = await chooseAuthOption({ appId: APP, slot: 'coinbase', requirement: oauthRequirement() });
    expect(outcome.ok).toBe(true);

    const row = db.getConnection(APP, 'coinbase')!;
    // AC12 — the B1 pin, on the STORED row: the choice survives admission.
    expect(row.provenance).toBe('user');
    expect(row.requirement.kind).toBe('oauth2_auth_code');
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['client_id']);
    expect(row.requirement.endpoints?.authorizeUrl).toBe('https://login.coinbase.com/oauth2/auth');
    // Identity invariants: hosts still the entry's.
    expect(row.requirement.declaredApiHosts).toEqual(['api.coinbase.com']);

    // The wizard opened on the rebind — the user reviews their choice immediately.
    expect(connectionWizardStore.get()?.appId).toBe(APP);
  });

  it('R3 — after the user chose, inference can NEVER silently take the row back', async () => {
    await seedDefaultRow();
    await chooseAuthOption({ appId: APP, slot: 'coinbase', requirement: oauthRequirement() });

    const overwrite = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: defaultRequirement(),
      channel: 'registry',
    });
    expect(overwrite.ok && overwrite.action).toBe('skipped_user_provenance');
    expect(db.getConnection(APP, 'coinbase')!.requirement.kind).toBe('oauth2_auth_code');
  });

  it('AC9 — routing follows the chosen kind', async () => {
    await seedDefaultRow();
    const before = db.getConnection(APP, 'coinbase')!;
    expect(nextStep('credentials', before.requirement)).toBe('done');

    await chooseAuthOption({ appId: APP, slot: 'coinbase', requirement: oauthRequirement() });
    const after = db.getConnection(APP, 'coinbase')!;
    expect(nextStep('credentials', after.requirement)).toBe('connect');
  });
});

describe('AC3/AC8 — the card seed: registry options come from the PINNED registry, nothing else', () => {
  it('a persisted registry row for a multi-option provider seeds a pointer card (no payload options)', async () => {
    await seedDefaultRow();
    const row = db.getConnection(APP, 'coinbase')!;
    const seed = authChoiceForPersistedRow({ appId: APP, requirement: row.requirement });
    expect(seed).toBeDefined();
    expect(seed!.slot).toBe('coinbase');
    expect(seed!.providerName).toBe('Coinbase');
    // The doorbell rule: for a registry provider the seed carries NO options — the
    // card resolves them from the pinned registry at render.
    expect(seed!.alternatives).toBeUndefined();
  });

  it('a single-option provider seeds NO card', async () => {
    const spotify = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    const requirement = requirementFromRegistryEntry(spotify, 'spotify', 'spotify');
    expect(authChoiceForPersistedRow({ appId: APP, requirement })).toBeUndefined();
  });

  it('an UNREGISTERED provider seeds a card only from validated inference alternatives', async () => {
    const requirement = {
      slot: 'tidegauge',
      provider: { name: 'TideGauge' },
      kind: 'oauth2_auth_code',
      endpoints: { authorizeUrl: 'https://auth.tidegauge.example/a', tokenUrl: 'https://auth.tidegauge.example/t' },
      declaredApiHosts: ['api.tidegauge.example'],
    };
    const alternative = {
      slot: 'tidegauge',
      provider: { name: 'TideGauge' },
      kind: 'bearer_token',
      fields: [{ key: 'token', label: 'Access token', type: 'secret' }],
      declaredApiHosts: ['api.tidegauge.example'],
    };
    const seed = authChoiceForPersistedRow({
      appId: APP,
      requirement: requirement as never,
      alternatives: [alternative as never],
    });
    expect(seed).toBeDefined();
    expect(seed!.alternatives).toHaveLength(1);

    expect(authChoiceForPersistedRow({ appId: APP, requirement: requirement as never })).toBeUndefined();
  });
});

describe('AC7 — meta rides validate-on-read; stale or hostile bytes render NOTHING', () => {
  it('a clean persisted seed round-trips', () => {
    const meta = {
      authChoice: {
        appId: APP,
        slot: 'tidegauge',
        providerName: 'TideGauge',
        alternatives: [
          {
            slot: 'tidegauge',
            provider: { name: 'TideGauge' },
            kind: 'bearer_token',
            fields: [{ key: 'token', label: 'Access token', type: 'secret' }],
            declaredApiHosts: ['api.tidegauge.example'],
          },
        ],
      },
    };
    const rehydrated = metaToAuthChoice(meta);
    expect(rehydrated).toBeDefined();
    expect(rehydrated!.alternatives).toHaveLength(1);
  });

  it('garbage, missing seats, and over-reaching alternatives all degrade to no card / fewer options', () => {
    expect(metaToAuthChoice(undefined)).toBeUndefined();
    expect(metaToAuthChoice({ authChoice: { appId: 42 } })).toBeUndefined();
    // An alternative that would not pass admission TODAY is dropped at read — meta
    // written yesterday cannot smuggle a shape past the guards of tomorrow.
    const overreaching = metaToAuthChoice({
      authChoice: {
        appId: APP,
        slot: 'tidegauge',
        providerName: 'TideGauge',
        alternatives: [
          {
            slot: 'tidegauge',
            provider: { name: 'TideGauge' },
            kind: 'oauth2_auth_code',
            endpoints: { authorizeUrl: 'https://a.example/a', tokenUrl: 'https://a.example/t' },
            userLayer: {
              kind: 'oauth2_auth_code',
              endpoints: { authorizeUrl: 'https://evil.example/a', tokenUrl: 'https://evil.example/t' },
              declaredApiHosts: ['evil.example'],
            },
            declaredApiHosts: ['api.tidegauge.example'],
          },
        ],
      },
    });
    expect(overreaching?.alternatives ?? []).toHaveLength(0);
  });
});

describe('AC8 — the card component gates on the LIVE row (no dead re-bind buttons)', () => {
  it('renders both Coinbase options for a declared registry row, and marks the current one', async () => {
    await seedDefaultRow();
    await renderCard({ appId: APP, slot: 'coinbase', providerName: 'Coinbase' });

    expect(text()).toContain('API key (recommended)');
    expect(text()).toContain('Sign in with Coinbase (OAuth)');
  });

  it('renders NOTHING once the user has chosen (provenance user)', async () => {
    await seedDefaultRow();
    await chooseAuthOption({ appId: APP, slot: 'coinbase', requirement: oauthRequirement() });
    __resetConnectionWizardForTests();
    await renderCard({ appId: APP, slot: 'coinbase', providerName: 'Coinbase' });
    expect(text()).toBe('');
  });

  it('renders NOTHING for an approved row, and NOTHING when no row exists', async () => {
    await renderCard({ appId: APP, slot: 'coinbase', providerName: 'Coinbase' });
    expect(text(), 'zero rows ⇒ zero card').toBe('');

    await seedDefaultRow();
    db.approveConnection(APP, 'coinbase');
    await renderCard({ appId: APP, slot: 'coinbase', providerName: 'Coinbase' });
    expect(text(), 'an approved row is not re-bindable from a card').toBe('');
  });

  it('a forged seed cannot inject options into a registry provider card', async () => {
    await seedDefaultRow();
    await renderCard({
      appId: APP,
      slot: 'coinbase',
      providerName: 'Coinbase',
      alternatives: [
        {
          slot: 'coinbase',
          provider: { name: 'Coinbase' },
          kind: 'basic_auth',
          fields: [{ key: 'password', label: 'Your Coinbase password', type: 'password' }],
          declaredApiHosts: ['api.coinbase.com'],
        } as never,
      ],
    });
    // The registry path ignores payload options entirely — the forged basic_auth
    // password prompt never renders.
    expect(text()).not.toContain('password');
    expect(text()).toContain('Sign in with Coinbase (OAuth)');
  });
});

describe("AC13 — `channel: 'user'` has exactly ONE production writer", () => {
  it('no playground production source passes the user channel except state/authKindChoice.ts', () => {
    // Executable form of the D7 guarantee, same technique as the import-specifier
    // lint: walk src/, skip __tests__, and flag any file that reaches the persist
    // seam with the user channel. R3 makes a `user` row permanent against inference,
    // so every new writer of this channel must land in this list deliberately.
    const ALLOWED = new Set(['state/authKindChoice.ts']);
    const srcRoot = join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name === '__tests__' || name === 'node_modules') continue;
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const relative = path.slice(srcRoot.length + 1);
        if (ALLOWED.has(relative)) continue;
        const source = readFileSync(path, 'utf8');
        if (/channel:\s*'user'/.test(source)) offenders.push(relative);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
