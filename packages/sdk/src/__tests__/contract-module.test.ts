// Contract suite × MODULE form: the typed ESM hooks imported normally (task AC-2).
//
// TASK-20261010-host-broker PR-6 (D-PR6-14): the factory also returns the section-6/7 twins and the
// module `bridge`, and resets BOTH the bridge and the schedule module's page state (answered runIds,
// the one-per-page proposal) — each row starts from a fresh page. The PR-6 names are read off the
// index namespace, so a name the index does not export yet is `undefined` and only the rows that
// need it are red (a literal named import of a missing export would fail the type check of the
// whole package).
import { __resetSnugBridgeForTests, bridge } from '../bridge.js';
import * as sdk from '../index.js';
import { useAppDB, useConnectedFetch, usePersistedState, useSnugApp } from '../index.js';
import { __resetSnugScheduleForTests } from '../schedule.js';
import { registerAccessContract } from './contract-access.js';
import { PR6_NAMES, registerHostEventsContract, type ContractForm } from './contract-host-events.js';
import { registerScheduleContract } from './contract-schedule.js';
import { registerContractSuite } from './contract-suite.js';

const exported = sdk as unknown as Record<string, unknown>;

function moduleForm(): ContractForm {
  __resetSnugBridgeForTests(); // each test starts from a fresh, unconnected bridge
  __resetSnugScheduleForTests(); // … and a page that has answered no run and proposed nothing
  const named = Object.fromEntries(PR6_NAMES.map((name) => [name, typeof exported[name] === 'function' ? exported[name] : undefined]));
  return { useSnugApp, usePersistedState, useAppDB, useConnectedFetch, ...named, bridge, form: 'module' } as ContractForm;
}

const FORM = 'module form (typed ESM imports)';
registerContractSuite(FORM, moduleForm);
registerHostEventsContract(FORM, moduleForm);
registerScheduleContract(FORM, moduleForm);
registerAccessContract(FORM, 'module', moduleForm);
