// @snugprotocol/sdk — the in-app side of the Snug protocol, two forms with ONE contract:
// - embedded/snug-hooks.js: the copy-exactly plain-JS hooks generated apps embed
//   (byte-locked to the knowledge base template by the KB≡SDK sync test), and
// - this module form: typed ESM hooks for bundler-built apps.
// Browser-safe: protocol constants + react peer dependency only, no node: imports.

export { useAppDB, useConnectedFetch, usePersistedState, useSnugApp } from './hooks.js';

export type {
  AppDb,
  ConnectedFetch,
  ConnectedFetchOptions,
  ConnectedFetchResult,
  DbExecResult,
  HostCapabilities,
  SendMessageOptions,
  SendMessageResult,
  SnugAppMeta,
  SnugTheme,
  UseSnugAppResult,
} from './types.js';
