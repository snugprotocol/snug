// Shared helper: a memory-backed user DB injected into the page-wide singleton so
// tests never touch OPFS or sql.js's browser wasm resolution (node locator instead).
//
// IT WIRES THE PRODUCTION `admissionGate`, and that is load-bearing rather than tidy
// (P5). It used to call `openUserDb` WITHOUT one while `state/userdb.ts` passes it on the
// real path, so every playground test ran against a database whose write accessors had no
// admission guard at all. A whole class of defect was therefore structurally invisible to
// this suite — and one had already shipped: substitution added the registry's `fields` in
// the pipeline's admission pass, the db accessor's SECOND pass then read those fields as
// borrower-authored prompt copy and refused the write, so every registry-backed starter
// failed to persist with `write_refused` and rendered no connect card. It took a browser
// journey to see it, because only the browser was running the real wiring.
//
// The rule this encodes: a test double for the user DB must differ from production in its
// BACKEND (memory, not OPFS) and nothing else. Guards are behavior under test, never
// scaffolding to omit.
import { createRequire } from 'node:module';

import { createMemoryBackend, openUserDb, type ConnectionAdmissionGate, type UserDb } from '@snugprotocol/db';
import { admitConnectionRequirement, type AdmissionChannel } from '@snugprotocol/auth';

import { resetLibraryForTests } from '../state/library.js';
import { resetUserDbForTests, setUserDbForTests } from '../state/userdb.js';

/** Byte-for-byte the gate `state/userdb.ts` installs on the production path. */
const admissionGate: ConnectionAdmissionGate = (requirement, context) =>
  admitConnectionRequirement(requirement, { channel: context.channel as AdmissionChannel });

const require = createRequire(import.meta.url);

export const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

/** Fresh memory user DB installed as THE page user DB. Call in beforeEach. */
export async function installTestUserDb(): Promise<UserDb> {
  resetUserDbForTests();
  resetLibraryForTests();
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1, admissionGate });
  if (result.status !== 'ok') throw new Error(`test user db open failed: ${result.status}`);
  setUserDbForTests(result.userDb);
  return result.userDb;
}
