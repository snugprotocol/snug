// Contract suite × MODULE form: the typed ESM hooks imported normally (task AC-2).
import { __resetSnugBridgeForTests } from '../bridge.js';
import { useAppDB, usePersistedState, useSnugApp } from '../index.js';
import { registerContractSuite, type ContractHookApi } from './contract-suite.js';

registerContractSuite('module form (typed ESM imports)', (): ContractHookApi => {
  __resetSnugBridgeForTests(); // each test starts from a fresh, unconnected bridge
  return { useSnugApp, usePersistedState, useAppDB };
});
