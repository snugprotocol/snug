// The app side of ACCESS BETWEEN APPS (TASK-20261010-cross-app-access AC5; ADR-0075; spec 1.1
// Part VI — and the 1.2 ops and hints of TASK-20261010-host-broker PR-3, ADR-0076 §4–§8; spec
// 1.2 §24.5–§24.7).
//
// WHY THIS EXISTS. Every Snug app's data is its own: no frame lets one app see another's rows
// unless the USER grants it. A reader app asks over `snug:access-request` (strict; `op ∈ request
// | query | write | refresh | list | release | discover`, the seven of `ACCESS_OPS`) and the host
// answers ONE terminal `snug:access-response` (tolerant) per requestId. The reader never names a
// source — it states a purpose (and optional hints, and at 1.2 whether it asks to WRITE), the
// host shows the user a consent sheet the app cannot draw over, and the app learns only what was
// granted: the source's display name, the tables with their columns (and which may be changed),
// the duration. Every read is a single read-only SELECT on a scoped copy, logged on the source; a
// write is ONE plain literal-valued INSERT/UPDATE/DELETE on a table the user ticked, bounded,
// journaled on the source and undoable by the user from the source's history (the app learns only
// the row count — no undo id reaches the wire, DS16); a refresh asks the source to fetch through
// its own connections before the next read (`fresh`, and a machine `reason` when nothing ran —
// never the source handler's words, S10/DS17); a discover answers a class, never a count or a
// name. The user can stop a grant at any moment, and the host then rings `host-event
// 'access-changed' { grantId }` (ids only, R7). Three more id-only hints at 1.2: `access-source-
// changed { grantId }` (the source's data moved — read again), `data-changed { table? }` (another
// app, or the chat, changed one of THIS app's tables — re-read it; `table` absent when the host
// could not name it) and `access-read { grantId }`
// (one of this app's tables was read under an access it is the source of).
//
// `useSnugAccess()` is that exchange, typed, in the `useConnectedFetch` shape: one memoised
// object, every call ALWAYS resolves (errors as data), every call mints a fresh requestId,
// before host-ready every call answers the retryable HOST_ERROR with nothing posted, and on a
// host that does not advertise `capabilities.access === true` every call answers a
// non-retryable HOST_ERROR with nothing posted (a 1.0 host would never answer the frame). A 1.1
// host answers the three 1.2 ops — and an ask carrying `access` — MALFORMED with the requestId
// recovered (D-PR3-5): no capability key announces them, so the app shows the same fallback and
// asks again without `access`.
//
// Each settler hands back ONLY the seats the protocol defines for its answer: the response is
// tolerant, so a host may send more (an undo id, a summary, a count), and none of it crosses.
//
// Both forms carry the hook (Q9 landed in TASK-20261010-host-broker PR-6): section 7 of the
// embedded copy-exactly block is the same `useSnugAccess()` — the eleven methods, the same guards
// and settlers — under one contract (contract-access.ts runs against each). Where they differ the
// module has zod: it ignores a response frame the protocol refuses and the call waits, and strips
// unknown keys inside a grant; the embedded settler answers such a frame as a HOST_ERROR.
import { useMemo } from 'react';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_READ_EVENT,
  ACCESS_SOURCE_CHANGED_EVENT,
  DATA_CHANGED_EVENT,
  ERROR_CODES,
  type AccessParam,
  type AccessResponseFrame,
} from '@snugprotocol/protocol';
import { accessRequest, ensureListener, onHostEvent } from './bridge.js';
import type {
  AccessChange,
  AccessDataChange,
  AccessDiscoverResult,
  AccessFailure,
  AccessListResult,
  AccessQueryResult,
  AccessRefreshResult,
  AccessReleaseResult,
  AccessRequestHints,
  AccessRequestOptions,
  AccessRequestResult,
  AccessWriteResult,
  SnugAccess,
} from './types.js';

/**
 * The host-events the hook subscribes to — the protocol's constants, re-exported: `access-changed`
 * (a grant was stopped or paused: `{ grantId }`), `access-source-changed` (the source of a grant
 * changed its data: `{ grantId }`), `data-changed` (one of THIS app's tables was changed through
 * an access, or an undo: `{ table }`, or `{}` when the host could not name it) and `access-read` (one of this app's tables was read under
 * an access it is the source of: `{ grantId }`).
 */
export { ACCESS_CHANGED_EVENT, ACCESS_READ_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT };

type AccessSuccess = Extract<AccessResponseFrame, { ok: true }>;
type AccessOpName = AccessSuccess['op'];

/**
 * A success answer for a different op than the one asked is a host fault: resolve a
 * non-retryable HOST_ERROR rather than hand the caller a mis-shaped success (or hang).
 */
function mismatch(asked: AccessOpName, answered: AccessOpName): AccessFailure {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.HOST_ERROR,
      message: `the host answered an access ${answered} to an access ${asked}`,
      retryable: false,
    },
  };
}

function settleRequest(frame: AccessResponseFrame): AccessRequestResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'request') return mismatch('request', frame.op);
  return { ok: true, grant: frame.grant };
}

function settleQuery(frame: AccessResponseFrame): AccessQueryResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'query') return mismatch('query', frame.op);
  // Result seats live at the TOP LEVEL of the frame (the db/net response shape).
  return {
    ok: true,
    columns: frame.columns,
    rows: frame.rows,
    ...(frame.truncated !== undefined ? { truncated: frame.truncated } : {}),
    ...(frame.totalRows !== undefined ? { totalRows: frame.totalRows } : {}),
  };
}

/** `write` → the row count alone: a host's extra seat (an undo id, rows) never crosses (DS16). */
function settleWrite(frame: AccessResponseFrame): AccessWriteResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'write') return mismatch('write', frame.op);
  return { ok: true, changes: frame.changes };
}

/** `refresh` → `fresh`, and `reason` only when the host sent one; a summary never crosses (S10/DS17). */
function settleRefresh(frame: AccessResponseFrame): AccessRefreshResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'refresh') return mismatch('refresh', frame.op);
  return { ok: true, fresh: frame.fresh, ...(frame.reason !== undefined ? { reason: frame.reason } : {}) };
}

function settleList(frame: AccessResponseFrame): AccessListResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'list') return mismatch('list', frame.op);
  return { ok: true, grants: frame.grants };
}

function settleRelease(frame: AccessResponseFrame): AccessReleaseResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'release') return mismatch('release', frame.op);
  return { ok: true };
}

/** `discover` → the class alone: a count or a name a host might add never crosses. */
function settleDiscover(frame: AccessResponseFrame): AccessDiscoverResult {
  if (!frame.ok) return { ok: false, error: frame.error };
  if (frame.op !== 'discover') return mismatch('discover', frame.op);
  return { ok: true, candidates: frame.candidates };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `access-changed` / `access-source-changed` / `access-read` data seat, validated: an object with a non-empty string `grantId`, reduced to exactly that. */
function readChange(data: unknown): AccessChange | undefined {
  if (!isRecord(data)) return undefined;
  const { grantId } = data;
  if (typeof grantId !== 'string' || grantId === '') return undefined;
  return { grantId };
}

/**
 * The `data-changed` data seat, validated and reduced: `{}` when the host could not name the
 * table (an own-mode batch over several tables, a statement whose text does not say — the hint
 * still means "re-read"; Gate-5 SEC-5), `{ table }` when it is a non-empty string; a record whose
 * `table` is anything else is dropped.
 */
function readDataChange(data: unknown): AccessDataChange | undefined {
  if (!isRecord(data)) return undefined;
  const { table } = data;
  if (table === undefined) return {};
  if (typeof table !== 'string' || table === '') return undefined;
  return { table };
}

/** One listener recipe for the three `{ grantId }` hints (Gate-5 W-7): the event's data through `readChange`, a malformed one dropped. */
const grantHint =
  (event: string) =>
  (listener: (data: AccessChange) => void): (() => void) =>
    onHostEvent(event, (data) => {
      const change = readChange(data);
      if (change !== undefined) listener(change);
    });

/**
 * Reads — and, where the user ticked it, changes — ANOTHER app's tables through a user-granted,
 * logged, revocable access grant.
 *
 * - `request(purpose, { hints, renew, access })` — ask, after a user act (never on load). The
 *   host shows a strip, the user reviews and picks the source and duration (and, on a write
 *   ask, which tables may be changed); resolves the granted view, or `ACCESS_DECLINED` /
 *   `ACCESS_PENDING` / `ACCESS_NO_SOURCES` / … as data.
 * - `query(grantId, sql, params)` — ONE read-only SELECT on the granted tables.
 * - `write(grantId, sql, params)` — ONE plain INSERT/UPDATE/DELETE on a table whose view says
 *   `write: true`; resolves `changes`, the row count (`ACCESS_WRITE_REFUSED`, `ACCESS_BUSY`,
 *   `ACCESS_NOT_GRANTED` as data).
 * - `refresh(grantId)` — ask the source to fetch new data first (`refresh: true` on the view);
 *   resolves `fresh`, and `reason: 'recent'` inside the cooldown.
 * - `list()` — this app's live grants. `release(grantId)` — give one back.
 * - `discover(hints)` — a class (`none` | `one` | `several`) of what the user holds; nothing recorded.
 * - `onChange(listener)` — a grant was stopped or paused on the host; re-`list()` (an expiry is not announced: the next `query` answers `ACCESS_EXPIRED`).
 * - `onSourceChanged(listener)` — the source of a grant changed its data; read again.
 * - `onDataChanged(listener)` — one of THIS app's tables was changed through an access (or an undo); re-read it.
 * - `onRead(listener)` — one of THIS app's tables was read under an access it is the source of.
 *
 * Every call ALWAYS resolves. Before host-ready it answers the retryable HOST_ERROR; on a host
 * without `capabilities.access === true` it answers a non-retryable HOST_ERROR (show the fallback).
 */
export function useSnugAccess(): SnugAccess {
  return useMemo<SnugAccess>(() => {
    ensureListener(); // useSnugAccess may be the first hook to mount
    return {
      request(purpose, opts?: AccessRequestOptions) {
        return accessRequest(
          {
            op: 'request',
            purpose,
            ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
            ...(opts?.renew !== undefined ? { renew: opts.renew } : {}),
            ...(opts?.access !== undefined ? { access: opts.access } : {}),
          },
          settleRequest,
        );
      },
      query(grantId, sql, params?: AccessParam[]) {
        return accessRequest({ op: 'query', grantId, sql, ...(params !== undefined ? { params } : {}) }, settleQuery);
      },
      write(grantId, sql, params?: AccessParam[]) {
        return accessRequest({ op: 'write', grantId, sql, ...(params !== undefined ? { params } : {}) }, settleWrite);
      },
      refresh(grantId) {
        return accessRequest({ op: 'refresh', grantId }, settleRefresh);
      },
      list() {
        return accessRequest({ op: 'list' }, settleList);
      },
      release(grantId) {
        return accessRequest({ op: 'release', grantId }, settleRelease);
      },
      discover(hints?: AccessRequestHints) {
        return accessRequest({ op: 'discover', ...(hints !== undefined ? { hints } : {}) }, settleDiscover);
      },
      onChange: grantHint(ACCESS_CHANGED_EVENT),
      onSourceChanged: grantHint(ACCESS_SOURCE_CHANGED_EVENT),
      onDataChanged(listener) {
        return onHostEvent(DATA_CHANGED_EVENT, (data) => {
          const change = readDataChange(data);
          if (change !== undefined) listener(change);
        });
      },
      onRead: grantHint(ACCESS_READ_EVENT),
    };
  }, []);
}
