// wholeSurfaceP6.test.tsx — the three defects the P6 WHOLE-SURFACE review found, each
// at a handoff no single phase owned, each invisible to every phase's own green suite.
//
// T3-1 (BLOCKER, prompt-to-row trace): P3 added `request.queryTemplate` as a co-equal
//   credential-PLACEMENT seat and wired it through schema, Guard 2b, lint, injection and
//   scrubbing — but not through the human REVIEW screen, which ADR-0017 names as the
//   price of admitting these seats ("the lint bounds WHAT a template may do; the review
//   is where the user sees WHERE their secret goes"). A queryTemplate-only requirement —
//   i.e. both shipped P4 entries, openweather and coingecko — was approved with NO
//   placement disclosure at all.
//
// HUE-DISPLAYNAME-MIGRATION-BLIND (MAJOR, silent-failure trace): the drift migration
//   resolves the registry with `lookupWellKnownProvider(provider.name)` (exact key on a
//   normalized name), but rows persist the entry's DISPLAY name. 'Philips Hue' normalizes
//   to 'philipshue', which is not the key 'hue' — so migration returns 'none' at its
//   first branch for EVERY hue row. The same file's `lanPairingExchangeFor` uses
//   `resolveRegistryEntryByName` and documents why, 120 lines above. The migration did
//   not follow it, which re-opens amendment 3's seat-migration-gap for the one provider
//   this task introduced.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRequire } from 'node:module';

import {
  admitConnectionRequirement,
  lookupWellKnownProvider,
  resolveRegistryEntryByName,
  type AdmissionChannel,
} from '@snugprotocol/auth';
import { createMemoryBackend, openUserDb, type ConnectionAdmissionGate, type UserDb } from '@snugprotocol/db';

import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
import {
  __resetConnectionWizardForTests,
  migrateConnectionRegistryDrift,
  openConnectionWizard,
} from '../state/connectionWizard.js';
import { resetLibraryForTests } from '../state/library.js';
import { resetUserDbForTests, setUserDbForTests } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

/** Byte-for-byte the production gate (mirrors userdbTestHelper). */
const productionGate: ConnectionAdmissionGate = (requirement, context) =>
  admitConnectionRequirement(requirement, { channel: context.channel as AdmissionChannel });

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-p6';

let db: UserDb;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderSheet(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ConnectionWizardSheet />);
  });
  await settle();
  await settle();
}

beforeEach(async () => {
  __resetConnectionWizardForTests();
  db = await installTestUserDb();
  db.installApp({ appId: APP, displayName: 'P6 App', html: '<p>p6</p>' });
});

afterEach(async () => {
  if (root !== undefined) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
  }
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('T3-1 — the review screen discloses QUERY credential placement, not just headers', () => {
  it('a queryTemplate-only requirement shows the user where their secret goes', async () => {
    // BARE, exactly as the shipped starter manifest is — Guard 2b refuses a borrower
    // that authors credential-prompt seats, so admission SUBSTITUTES the registry's
    // pinned queryTemplate. This is the stronger fixture: it proves the disclosure
    // against the real substituted shape a user actually gets, not a hand-built row.
    db.putDeclaredConnection(
      APP,
      'openweather',
      {
        slot: 'openweather',
        provider: { name: 'OpenWeather' },
        kind: 'api_key',
        declaredApiHosts: ['api.openweathermap.org'],
      },
      'starter',
    );

    openConnectionWizard({ appId: APP, slot: 'openweather', source: 'settings' });
    await renderSheet();

    const text = container!.textContent ?? '';
    // The parameter NAME and the field it carries must both be visible: a user cannot
    // consent to a placement they were never shown.
    expect(text, 'the review screen must name the query parameter').toContain('appid');
    expect(text, 'the review screen must name the field that fills it').toContain('api_key');
  });

  it('still discloses header placement (the pre-existing path is not traded away)', async () => {
    db.putDeclaredConnection(
      APP,
      'coinbase',
      {
        slot: 'coinbase',
        provider: { name: 'Coinbase' },
        kind: 'api_key',
        fields: [
          { key: 'api_key', label: 'API key name', type: 'text', required: true },
          { key: 'private_key', label: 'EC private key (PEM)', type: 'secret', required: true },
        ],
        request: { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}}' } },
        declaredApiHosts: ['api.coinbase.com'],
      },
      'registry',
    );

    openConnectionWizard({ appId: APP, slot: 'coinbase', source: 'settings' });
    await renderSheet();

    expect(container!.textContent ?? '').toContain('Authorization');
  });
});

describe('HUE-DISPLAYNAME-MIGRATION-BLIND — drift migration reaches an entry whose displayName is not its key', () => {
  it('a hue row resolves the registry (Philips Hue → the `hue` entry), so seat drift can be repaired', async () => {
    // A hue row minted WITHOUT the pinned request seat — exactly the shape amendment 3
    // exists to repair. `provider.name` is the persisted DISPLAY name, which is what
    // makes the exact-key resolver miss.
    // Bare borrow (Guard 2b again) — admission substitutes the pinned LAN shape, and the
    // row persists the DISPLAY name 'Philips Hue', which is precisely what made the
    // exact-key resolver miss.
    db.putDeclaredConnection(
      APP,
      'hue',
      {
        slot: 'hue',
        provider: { name: 'Philips Hue' },
        kind: 'api_key',
        lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
        declaredApiHosts: ['192.168.1.50'],
      },
      'starter',
    );
    db.approveConnection(APP, 'hue');

    // Admission already substitutes the pinned seats for a BARE borrow, so this row has
    // no drift to repair and 'none' is the honest answer — the assertion that matters is
    // that the entry was RESOLVED rather than missed. Prove that at the altitude where
    // the defect lived: the resolver the migration now uses reaches `hue` from the
    // persisted display name, while the exact-key lookup it used before does not.
    expect(await migrateConnectionRegistryDrift(APP, 'hue')).toBe('none');
    expect(lookupWellKnownProvider('Philips Hue'), 'exact-key resolution MISSES by contract').toBeUndefined();
    expect(
      resolveRegistryEntryByName('Philips Hue')?.key,
      'the resolver the migration uses must reach the entry — the whole defect',
    ).toBe('hue');

    // And the shape a user actually ends up with carries the pinned LAN header, so a hue
    // row that DID drift has somewhere to be repaired to.
    const after = db.getConnection(APP, 'hue')!;
    expect(after.requirement.request?.headerTemplate?.['hue-application-key']).toBe('{{application_key}}');
  });

  it('a genuinely SEAT-DRIFTED hue row is repaired — the migration path runs, not just the resolver', async () => {
    // The real amendment-3 shape: a row minted before the registry pinned its request
    // seat. Guard 2b refuses a borrower that AUTHORS seats, so the only way to hold a
    // seatless hue row is the same way a real one arises — an older hub admitted it — and
    // `userdbTestHelper` mints through the permissive default gate for exactly this.
    resetUserDbForTests();
    resetLibraryForTests();
    const backend = createMemoryBackend();
    const older = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (older.status !== 'ok') throw new Error(`older-hub open failed: ${older.status}`);
    const legacy = older.userDb;
    legacy.installApp({ appId: APP, displayName: 'P6 App', html: '<p>p6</p>' });
    legacy.putDeclaredConnection(
      APP,
      'hue',
      {
        slot: 'hue',
        provider: { name: 'Philips Hue' },
        kind: 'api_key',
        fields: [{ key: 'application_key', label: 'Application key', type: 'secret', required: true }],
        lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
        declaredApiHosts: ['192.168.1.50'],
      },
      'starter',
    );
    legacy.approveConnection(APP, 'hue');
    await legacy.close();

    // Reopen the SAME bytes under the production gate — "an older hub wrote this row".
    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1, admissionGate: productionGate });
    if (reopened.status !== 'ok') throw new Error(`gated reopen failed: ${reopened.status}`);
    setUserDbForTests(reopened.userDb);
    expect(
      reopened.userDb.getConnection(APP, 'hue')!.requirement.request,
      'the fixture must genuinely lack the seat, or this test proves nothing',
    ).toBeUndefined();

    // Before the fix this returned 'none' at the first branch and the row stayed broken
    // forever — a hue connection that can never send its key.
    const outcome = await migrateConnectionRegistryDrift(APP, 'hue');
    expect(outcome, 'the drifted hue row must be repaired, not skipped').not.toBe('none');

    const row = reopened.userDb.getConnection(APP, 'hue')!;
    const repaired = (row.pendingRequirement ?? row.requirement).request;
    expect(repaired?.headerTemplate?.['hue-application-key']).toBe('{{application_key}}');
  });
});
