// @snugprotocol/sdk — the in-app side of the Snug protocol, two forms with ONE contract:
// - embedded/snug-hooks.js: the copy-exactly plain-JS hooks generated apps embed
//   (byte-locked to the knowledge base template by the KB≡SDK sync test), and
// - this module form: typed ESM hooks for bundler-built apps.
// Browser-safe: protocol constants + react peer dependency only, no node: imports.

export { useAppDB, useConnectedFetch, usePersistedState, useSnugApp } from './hooks.js';
// Scheduled runs (TASK-20261009, ADR-0074 §3/§4): the module-form hook over the host-event
// subscription, and the one way an app suggests a schedule. The embedded form carries the
// same shape as a knowledge-base snippet beside the copy-exactly block, not as a hook (Q7).
export {
  SCHEDULE_REQUEST_EVENT,
  SCHEDULE_RESULT_EVENT,
  SCHEDULE_RUN_EVENT,
  proposeSchedule,
  scheduleInputKey,
  useSnugSchedule,
} from './schedule.js';
export { onHostEvent } from './bridge.js';
// Access between apps (TASK-20261010-cross-app-access, ADR-0075; spec 1.1 Part VI): the
// module-form hook and the host-event name (the protocol's constant, re-exported). The embedded
// form carries the same shape as a knowledge-base snippet beside the copy-exactly block (Q9).
export { ACCESS_CHANGED_EVENT, useSnugAccess } from './access.js';

export type { HostEventListener } from './bridge.js';
export type { SnugScheduleHandler, SnugScheduleNotify, SnugScheduleResult, SnugScheduledRun } from './schedule.js';
/** The proposal shape `proposeSchedule` posts — the protocol's `scheduleProposalSchema`, inferred. */
export type { ScheduleProposal } from '@snugprotocol/protocol';
/** The scalar a `query` param may be — the protocol's `accessParamSchema`, inferred. */
export type { AccessParam } from '@snugprotocol/protocol';
export type {
  AccessChange,
  AccessFailure,
  AccessGrantView,
  AccessListResult,
  AccessQueryResult,
  AccessReleaseResult,
  AccessRequestHints,
  AccessRequestOptions,
  AccessRequestResult,
  AppDb,
  ConnectedFetch,
  ConnectedFetchOptions,
  ConnectedFetchResult,
  DbExecResult,
  HostCapabilities,
  SendMessageOptions,
  SendMessageResult,
  SnugAccess,
  SnugAppMeta,
  SnugTheme,
  UseSnugAppResult,
} from './types.js';
