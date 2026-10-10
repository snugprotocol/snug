// The app side of ACCESS BETWEEN APPS (TASK-20261010-cross-app-access AC5; ADR-0075; spec 1.1
// Part VI).
//
// WHY THIS EXISTS. Every Snug app's data is its own: no frame lets one app see another's rows
// unless the USER grants it. A reader app asks over `snug:access-request` (strict; `op ∈ request
// | query | list | release`) and the host answers ONE terminal `snug:access-response` (tolerant)
// per requestId. The reader never names a source — it states a purpose (and optional hints), the
// host shows the user a consent sheet the app cannot draw over, and the app learns only what was
// granted: the source's display name, the tables with their columns, the duration. Every read is
// a single read-only SELECT on a scoped copy, logged on the source; the user can stop a grant at
// any moment, and the host then rings `host-event 'access-changed' { grantId }` (ids only, R7).
//
// `useSnugAccess()` is that exchange, typed, in the `useConnectedFetch` shape: one memoised
// object, every call ALWAYS resolves (errors as data), every call mints a fresh requestId,
// before host-ready every call answers the retryable HOST_ERROR with nothing posted, and on a
// host that does not advertise `capabilities.access === true` every call answers a
// non-retryable HOST_ERROR with nothing posted (a 1.0 host would never answer the frame).
//
// The EMBEDDED form has no hook (Q9: the copy-exactly block changes in the starter release
// wave); the knowledge base ships this same shape as a snippet beside the block.
import { useMemo } from 'react';
import { ACCESS_CHANGED_EVENT, ERROR_CODES, type AccessParam, type AccessResponseFrame } from '@snugprotocol/protocol';
import { accessRequest, ensureListener, onHostEvent } from './bridge.js';
import type {
  AccessChange,
  AccessFailure,
  AccessListResult,
  AccessQueryResult,
  AccessReleaseResult,
  AccessRequestOptions,
  AccessRequestResult,
  SnugAccess,
} from './types.js';

/** The host-event that hints a grant changed: `{ grantId }` — the protocol's constant, re-exported. */
export { ACCESS_CHANGED_EVENT };

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `access-changed` data seat, validated: an object with a non-empty string `grantId`, reduced to exactly that. */
function readChange(data: unknown): AccessChange | undefined {
  if (!isRecord(data)) return undefined;
  const { grantId } = data;
  if (typeof grantId !== 'string' || grantId === '') return undefined;
  return { grantId };
}

/**
 * Reads ANOTHER app's tables through a user-granted, logged, revocable access grant.
 *
 * - `request(purpose, { hints, renew })` — ask, after a user act (never on load). The host
 *   shows a strip, the user reviews and picks the source and duration; resolves the granted
 *   view, or `ACCESS_DECLINED` / `ACCESS_PENDING` / `ACCESS_NO_SOURCES` / … as data.
 * - `query(grantId, sql, params)` — ONE read-only SELECT on the granted tables.
 * - `list()` — this app's live grants. `release(grantId)` — give one back.
 * - `onChange(listener)` — a grant was stopped, paused or expired on the host; re-`list()`.
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
          },
          settleRequest,
        );
      },
      query(grantId, sql, params?: AccessParam[]) {
        return accessRequest({ op: 'query', grantId, sql, ...(params !== undefined ? { params } : {}) }, settleQuery);
      },
      list() {
        return accessRequest({ op: 'list' }, settleList);
      },
      release(grantId) {
        return accessRequest({ op: 'release', grantId }, settleRelease);
      },
      onChange(listener) {
        return onHostEvent(ACCESS_CHANGED_EVENT, (data) => {
          const change = readChange(data);
          if (change !== undefined) listener(change);
        });
      },
    };
  }, []);
}
