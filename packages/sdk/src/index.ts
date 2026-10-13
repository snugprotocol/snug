// @snugprotocol/sdk — the in-app side of the Snug protocol, two forms with ONE contract:
// - embedded/snug-hooks.js: the copy-exactly plain-JS hooks generated apps embed
//   (byte-locked to the knowledge base template by the KB≡SDK sync test), and
// - this module form: typed ESM hooks for bundler-built apps.
// Browser-safe: protocol constants + react peer dependency only, no node: imports.

export { useAppDB, useConnectedFetch, usePersistedState, useSnugApp } from './hooks.js';
// Scheduled runs (TASK-20261009, ADR-0074 §3/§4): the module-form hook over the host-event
// subscription, and the one way an app suggests a schedule. Both forms carry it: section 6 of
// the embedded copy-exactly block is the same hook (Q7 landed in TASK-20261010-host-broker PR-6).
export {
  SCHEDULE_REQUEST_EVENT,
  SCHEDULE_RESULT_EVENT,
  SCHEDULE_RUN_EVENT,
  proposeSchedule,
  scheduleInputKey,
  useSnugSchedule,
} from './schedule.js';
// The host's named events (ADR-0034; TASK-20261010-host-broker PR-6): the primitive and the hook
// that subscribes a component to several by name. Both forms carry them (embedded section 6).
export { onHostEvent } from './bridge.js';
export { useHostEvents } from './hostEvents.js';
// Access between apps (TASK-20261010-cross-app-access, ADR-0075; spec 1.1 Part VI; the 1.2
// ops and hints of TASK-20261010-host-broker PR-3, ADR-0076 §4–§8): the module-form hook and
// the four host-event names (the protocol's constants, re-exported). Both forms carry it: section 7
// of the embedded copy-exactly block is the same hook (Q9 landed in TASK-20261010-host-broker PR-6).
export { ACCESS_CHANGED_EVENT, ACCESS_READ_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, useSnugAccess } from './access.js';

export type { HostEventListener } from './bridge.js';
export type { HostEventHandlers } from './hostEvents.js';
export type { SnugScheduleHandler, SnugScheduleNotify, SnugScheduleResult, SnugScheduledRun } from './schedule.js';
/** The proposal shape `proposeSchedule` posts — the protocol's `scheduleProposalSchema`, inferred. */
export type { ScheduleProposal } from '@snugprotocol/protocol';
/** The scalar a `query` param may be — the protocol's `accessParamSchema`, inferred. */
export type { AccessParam } from '@snugprotocol/protocol';
export type {
  AccessChange,
  AccessDataChange,
  AccessDiscoverResult,
  AccessFailure,
  AccessGrantView,
  AccessListResult,
  AccessQueryResult,
  AccessRefreshResult,
  AccessReleaseResult,
  AccessRequestHints,
  AccessRequestOptions,
  AccessRequestResult,
  AccessWriteResult,
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
