// Contract suite × EMBEDDED form: embedded/snug-hooks.js is plain browser JS that
// expects React on the global scope (generated apps load React as a UMD script), so it
// is evaluated with `new Function('React', …)` against the real React in jsdom. A fresh
// evaluation per test gives each test its own isolated SnugBridge (task AC-2).
//
// TASK-20261010-host-broker PR-6 (D-PR6-14): the factory also returns the section-6/7 names and
// the block's own `SnugBridge` (LOCAL to the evaluated function — the only way a row can read its
// subscriber and access-pending maps). A name the block does not define yet is `undefined` (a
// `typeof` guard, never a ReferenceError), so the four-hook rows stay green and only the rows
// that need a missing name are red.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { registerAccessContract } from './contract-access.js';
import { PR6_NAMES, registerHostEventsContract, type ContractForm } from './contract-host-events.js';
import { registerScheduleContract } from './contract-schedule.js';
import { registerContractSuite } from './contract-suite.js';

const code = readFileSync(path.resolve(process.cwd(), 'embedded/snug-hooks.js'), 'utf8');

const tolerant = PR6_NAMES.map((name) => `${name}: typeof ${name} === 'function' ? ${name} : undefined`).join(', ');

function evalEmbedded(): ContractForm {
  const factory = new Function(
    'React',
    `${code}\nreturn { useSnugApp, usePersistedState, useAppDB, useConnectedFetch, ${tolerant}, bridge: SnugBridge, form: 'embedded' };`,
  );
  return factory(React) as ContractForm;
}

const FORM = 'embedded form (embedded/snug-hooks.js via new Function)';
registerContractSuite(FORM, evalEmbedded);
registerHostEventsContract(FORM, evalEmbedded);
registerScheduleContract(FORM, evalEmbedded);
registerAccessContract(FORM, 'embedded', evalEmbedded);
