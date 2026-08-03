// Shared helper: a memory-backed user DB injected into the page-wide singleton so
// tests never touch OPFS or sql.js's browser wasm resolution (node locator instead).
import { createRequire } from 'node:module';

import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';

import { resetLibraryForTests } from '../state/library.js';
import { resetUserDbForTests, setUserDbForTests } from '../state/userdb.js';

const require = createRequire(import.meta.url);

export const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

/** Fresh memory user DB installed as THE page user DB. Call in beforeEach. */
export async function installTestUserDb(): Promise<UserDb> {
  resetUserDbForTests();
  resetLibraryForTests();
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`test user db open failed: ${result.status}`);
  setUserDbForTests(result.userDb);
  return result.userDb;
}
