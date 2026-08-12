/**
 * TASK-20260811-lean-runtime-data-chat, P2 — starter runtime contracts land on v1
 * (ADR-0018, AC-F1-2).
 *
 * WHY STARTERS NEED THIS. A starter is installed, not built: no authoring turn runs, so
 * neither `runtime_contract_write` nor the synthesis fallback ever fires. Without an
 * install-time copy the reference apps — the ones users meet first, and the ones the KB
 * points at as exemplars — would be exactly the apps with no contract.
 *
 * SAME SHAPE AS `installStarterConnections`, deliberately: read the bundled file, validate
 * it with the REAL schema, write it onto the app, and degrade to "no contract" on anything
 * unexpected. A starter that ships a malformed contract must install fine and simply run
 * on the generic layers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { runtimeContractSchema } from '@snugprotocol/protocol';

import {
  __resetRuntimeContractFixturesForTests,
  __setRuntimeContractFixturesForTests,
  installStarterRuntimeContract,
} from '../starter/starterRuntimeContract.js';
import { installTestUserDb } from './userdbTestHelper.js';

const html = `<!DOCTYPE html><html><body><script>sendMessage('x',{})</script></body></html>`;

const CHESS_CONTRACT = {
  overview: 'A chess app. The user plays white; you play black.',
  responseGuidance: 'Reply {"from":"e7","to":"e5"}.',
};

afterEach(() => {
  __resetRuntimeContractFixturesForTests();
});

describe('installStarterRuntimeContract', () => {
  it('writes the bundled contract onto the installed app’s v1', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html, installSource: 'starter:chess' });
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify(CHESS_CONTRACT) });

    await installStarterRuntimeContract(db, app.appId);

    expect(db.getRuntimeContract(app.appId)).toEqual(CHESS_CONTRACT);
    expect(db.getRuntimeContract(app.appId, 1)).toEqual(CHESS_CONTRACT);
  });

  it('does nothing for an app that is not a starter install', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Handmade', html });
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify(CHESS_CONTRACT) });

    await installStarterRuntimeContract(db, app.appId);

    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('does nothing when the starter ships no contract (LLM-free starters)', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Ledger', html, installSource: 'starter:pocket-ledger' });
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify(CHESS_CONTRACT) });

    await installStarterRuntimeContract(db, app.appId);

    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('DEGRADES: a malformed contract file leaves the app contract-less rather than failing the install', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html, installSource: 'starter:chess' });
    __setRuntimeContractFixturesForTests({ chess: '{not json' });

    await expect(installStarterRuntimeContract(db, app.appId)).resolves.toBeUndefined();
    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('DEGRADES: an over-bound contract is refused by the real schema, not truncated', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html, installSource: 'starter:chess' });
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify({ overview: 'x'.repeat(5000) }) });

    await installStarterRuntimeContract(db, app.appId);

    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('never overwrites a contract the app already has', async () => {
    // Re-installing or re-running the act must not clobber a user's re-authored contract.
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html, installSource: 'starter:chess' });
    const mine = runtimeContractSchema.parse({ overview: 'My own re-authored contract.' });
    db.putRuntimeContract(app.appId, app.currentVersion, mine);
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify(CHESS_CONTRACT) });

    await installStarterRuntimeContract(db, app.appId);

    expect(db.getRuntimeContract(app.appId)).toEqual(mine);
  });

  it('an unknown app is a no-op, never a throw', async () => {
    const db = await installTestUserDb();
    __setRuntimeContractFixturesForTests({ chess: JSON.stringify(CHESS_CONTRACT) });
    await expect(installStarterRuntimeContract(db, 'no-such-app')).resolves.toBeUndefined();
  });
});

describe('the shipped starter contracts are real', () => {
  it('every bundled starter contract satisfies the schema', async () => {
    // The examples suite validates the FILES; this asserts the BUNDLE the playground
    // actually reads resolves and parses — the two can drift if a glob is wrong.
    __resetRuntimeContractFixturesForTests();
    const { bundledStarterContracts } = await import('../starter/starterRuntimeContract.js');
    const bundle = await bundledStarterContracts();
    expect(Object.keys(bundle).length).toBeGreaterThan(0);
    for (const [folder, raw] of Object.entries(bundle)) {
      const parsed = runtimeContractSchema.safeParse(JSON.parse(raw));
      expect(parsed.success, `${folder} ships an invalid runtime contract`).toBe(true);
    }
  });
});
