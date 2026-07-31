// Contract suite × EMBEDDED form: embedded/snug-hooks.js is plain browser JS that
// expects React on the global scope (generated apps load React as a UMD script), so it
// is evaluated with `new Function('React', …)` against the real React in jsdom. A fresh
// evaluation per test gives each test its own isolated SnugBridge (task AC-2).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { registerContractSuite, type ContractHookApi } from './contract-suite.js';

const code = readFileSync(path.resolve(process.cwd(), 'embedded/snug-hooks.js'), 'utf8');

function evalEmbedded(): ContractHookApi {
  const factory = new Function('React', `${code}\nreturn { useSnugApp, usePersistedState, useAppDB };`);
  return factory(React) as ContractHookApi;
}

registerContractSuite('embedded form (embedded/snug-hooks.js via new Function)', evalEmbedded);
