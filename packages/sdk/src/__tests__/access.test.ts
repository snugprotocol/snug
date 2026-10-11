// Access between apps, app side (TASK-20261010-cross-app-access AC5; ADR-0075 §1, §9). MODULE-ONLY
// rows: the embedded hooks block is UNCHANGED (Q9 — the knowledge base ships a listener snippet
// beside it), so these do not join the shared contract suite. A fake host plays the other side on
// the same jsdom window (app-harness.tsx): it collects the `snug:access-request` frames the hook
// posts — every one PARSED with the protocol's own `accessRequestSchema`, never eyeballed — and
// answers them with `snug:access-response` frames, in any order it likes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_READ_EVENT,
  ACCESS_SOURCE_CHANGED_EVENT,
  DATA_CHANGED_EVENT,
  ERROR_CODES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessRequestSchema,
  type AccessGrantView as ProtocolAccessGrantView,
  type AccessHints,
  type AccessParam,
  type AccessRequestFrame,
  type ResponseError,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { __resetSnugBridgeForTests, accessRequest, bridge } from '../bridge.js';
import { useSnugAccess } from '../access.js';
import { useSnugApp } from '../hooks.js';
import * as sdk from '../index.js';
import type {
  AccessDiscoverResult,
  AccessGrantView,
  AccessListResult,
  AccessQueryResult,
  AccessRefreshResult,
  AccessReleaseResult,
  AccessRequestHints,
  AccessRequestOptions,
  AccessRequestResult,
  AccessWriteResult,
  HostCapabilities,
  SnugAccess,
} from '../index.js';
import { drainMessageQueue, flush, hostStub, renderProbe, type AppFrame, type HostStub, type Probe } from './app-harness.js';

const META = { appId: 'budget', displayName: 'Budget' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GRANT_ID = '3f1c2b9e-8a47-4d21-9c3e-5b6a7d8e9f01';
const OTHER_GRANT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A grant view exactly as a 1.1 host answers it (the protocol's `accessGrantViewSchema`). */
const VIEW: ProtocolAccessGrantView = {
  id: GRANT_ID,
  access: 'read',
  source: { displayName: 'Ledger', iconEmoji: '📒', iconColor: '#335577' },
  tables: [{ name: 'transactions', columns: ['amount', 'category', 'date'] }],
  duration: 'day',
  expiresAt: '2026-10-11T09:00:00.000Z',
  unattended: false,
};

const NOT_CONNECTED = {
  ok: false,
  error: { code: ERROR_CODES.HOST_ERROR, message: 'not connected to host yet', retryable: true },
} as const;

/** What every call resolves on a host that is ready but does not advertise `access: true`. */
const NOT_OFFERED = {
  ok: false,
  error: { code: ERROR_CODES.HOST_ERROR, message: 'this host does not offer access between apps', retryable: false },
} as const;

/** A 1.0 host's capabilities (no `access` key) and a 1.1 host's that routes the access pair. */
const CAPS_1_0 = { streaming: true, db: true, auth: false } as const;
const CAPS_ACCESS = { ...CAPS_1_0, access: true } as const;

/** Parses one collected frame with the protocol's strict request schema — the host's own reading. */
function parsedRequest(frame: AppFrame | undefined): AccessRequestFrame {
  const parsed = accessRequestSchema.safeParse(frame);
  expect(parsed.success, `the posted frame parses as an access-request: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  return parsed.data as AccessRequestFrame;
}

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(promise: Promise<T>): { settled: () => boolean; value: () => T | undefined } {
  let done = false;
  let value: T | undefined;
  void promise.then((v) => {
    done = true;
    value = v;
  });
  return { settled: () => done, value: () => value };
}

describe('useSnugAccess — reading another app’s data through a user-granted access grant (module form)', () => {
  let host: HostStub;
  const probes: Probe<unknown>[] = [];

  const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
    const probe = await renderProbe(body);
    probes.push(probe as Probe<unknown>);
    return probe;
  };

  /**
   * Mounts useSnugApp + useSnugAccess and completes the handshake; answers the hook's surface.
   * The default host ADVERTISES `access: true` — the per-op rows run against a host that routes
   * the pair, never one that did not offer it.
   */
  const connected = async (readyOver: Record<string, unknown> = { capabilities: CAPS_ACCESS }): Promise<SnugAccess> => {
    const probe = await mount(() => {
      useSnugApp(META);
      return useSnugAccess();
    });
    await flush();
    host.ready(readyOver);
    await flush();
    return probe.result.current;
  };

  beforeEach(async () => {
    await drainMessageQueue();
    __resetSnugBridgeForTests();
    host = hostStub();
  });

  afterEach(() => {
    while (probes.length > 0) probes.pop()?.unmount();
    host.dispose();
  });

  it('exposes the eleven — request, query, write, refresh, list, release, discover, onChange, onSourceChanged, onDataChanged, onRead — one stable object across renders (the useConnectedFetch shape; PR-3 adds six, D-PR3-14, DS10)', async () => {
    const probe = await mount(() => useSnugAccess());
    const first = probe.result.current;
    const ELEVEN = ['request', 'query', 'write', 'refresh', 'list', 'release', 'discover', 'onChange', 'onSourceChanged', 'onDataChanged', 'onRead'] as const;
    expect(Object.keys(first).sort()).toEqual([...ELEVEN].sort());
    for (const key of ELEVEN) expect(typeof first[key], key).toBe('function');
    await probe.rerender();
    expect(probe.result.current).toBe(first);
  });

  it('request(purpose, { hints, renew }) posts ONE strict snug:access-request op "request" the protocol schema parses, and resolves { ok: true, grant } on its terminal response', async () => {
    const access = await connected();
    const call = access.request('to show spending by category', {
      hints: { words: ['spending', 'category'], tables: ['transactions'] },
      renew: OTHER_GRANT_ID,
    });
    await flush();
    const posted = host.accessRequests();
    expect(posted).toHaveLength(1);
    const frame = parsedRequest(posted[0]);
    expect(posted[0]).toEqual({
      v: PROTOCOL_VERSION,
      instanceId: 'ins-1',
      type: FRAME_TYPES.accessRequest,
      requestId: frame.requestId,
      op: 'request',
      purpose: 'to show spending by category',
      hints: { words: ['spending', 'category'], tables: ['transactions'] },
      renew: OTHER_GRANT_ID,
    });
    host.accessSucceed(frame.requestId, { op: 'request', grant: VIEW });
    await expect(call).resolves.toEqual({ ok: true, grant: VIEW });
  });

  it('request(purpose) with no options posts no hints/renew keys at all (absent, not undefined) and still parses', async () => {
    const access = await connected();
    void access.request('to show spending by category');
    await flush();
    const [posted] = host.accessRequests();
    parsedRequest(posted);
    expect(Object.keys(posted!).sort()).toEqual(['instanceId', 'op', 'purpose', 'requestId', 'type', 'v']);
  });

  it('query(grantId, sql, params) posts op "query" the schema parses and resolves { ok: true, columns, rows, truncated, totalRows } from the top-level response seats', async () => {
    const access = await connected();
    const call = access.query(GRANT_ID, 'SELECT amount, category FROM transactions WHERE amount > ?', [10, 'x', true, null]);
    await flush();
    const [posted] = host.accessRequests();
    const frame = parsedRequest(posted);
    expect(posted).toEqual({
      v: PROTOCOL_VERSION,
      instanceId: 'ins-1',
      type: FRAME_TYPES.accessRequest,
      requestId: frame.requestId,
      op: 'query',
      grantId: GRANT_ID,
      sql: 'SELECT amount, category FROM transactions WHERE amount > ?',
      params: [10, 'x', true, null],
    });
    host.accessSucceed(frame.requestId, {
      op: 'query',
      columns: ['amount', 'category'],
      rows: [[12.5, 'food'], [40, 'rent']],
      truncated: true,
      totalRows: 812,
    });
    await expect(call).resolves.toEqual({
      ok: true,
      columns: ['amount', 'category'],
      rows: [[12.5, 'food'], [40, 'rent']],
      truncated: true,
      totalRows: 812,
    });
  });

  it('query without params posts no params key, and an untruncated answer resolves without truncated/totalRows keys', async () => {
    const access = await connected();
    const call = access.query(GRANT_ID, 'SELECT 1');
    await flush();
    const [posted] = host.accessRequests();
    const frame = parsedRequest(posted);
    expect('params' in posted!).toBe(false);
    host.accessSucceed(frame.requestId, { op: 'query', columns: ['1'], rows: [[1]] });
    const result = await call;
    expect(result).toEqual({ ok: true, columns: ['1'], rows: [[1]] });
    expect(Object.keys(result).sort()).toEqual(['columns', 'ok', 'rows']);
  });

  it('list() posts op "list" the schema parses and resolves { ok: true, grants }', async () => {
    const access = await connected();
    const call = access.list();
    await flush();
    const [posted] = host.accessRequests();
    const frame = parsedRequest(posted);
    expect(posted).toEqual({ v: PROTOCOL_VERSION, instanceId: 'ins-1', type: FRAME_TYPES.accessRequest, requestId: frame.requestId, op: 'list' });
    host.accessSucceed(frame.requestId, { op: 'list', grants: [VIEW] });
    await expect(call).resolves.toEqual({ ok: true, grants: [VIEW] });
  });

  it('list() keeps a grant the tolerant response admits (a future access: "write" with an unknown key) — the SDK never drops a whole answer', async () => {
    const access = await connected();
    const call = access.list();
    await flush();
    const [posted] = host.accessRequests();
    const future = { ...VIEW, id: OTHER_GRANT_ID, access: 'write', futureSeat: 1 };
    host.accessSucceed(parsedRequest(posted).requestId, { op: 'list', grants: [VIEW, future] });
    const result = await call;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grants.map((g) => [g.id, g.access])).toEqual([
      [GRANT_ID, 'read'],
      [OTHER_GRANT_ID, 'write'],
    ]);
  });

  it('release(grantId) posts op "release" the schema parses and resolves { ok: true }', async () => {
    const access = await connected();
    const call = access.release(GRANT_ID);
    await flush();
    const [posted] = host.accessRequests();
    const frame = parsedRequest(posted);
    expect(posted).toEqual({
      v: PROTOCOL_VERSION,
      instanceId: 'ins-1',
      type: FRAME_TYPES.accessRequest,
      requestId: frame.requestId,
      op: 'release',
      grantId: GRANT_ID,
    });
    host.accessSucceed(frame.requestId, { op: 'release' });
    await expect(call).resolves.toEqual({ ok: true });
  });

  it('every call mints a FRESH requestId (crypto.randomUUID) — even two calls of the same op', async () => {
    const access = await connected();
    void access.request('to show spending');
    void access.query(GRANT_ID, 'SELECT 1');
    void access.query(GRANT_ID, 'SELECT 1');
    void access.list();
    void access.release(GRANT_ID);
    await flush();
    const ids = host.accessRequests().map((f) => parsedRequest(f).requestId);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('two calls in flight answered OUT OF ORDER each resolve with their own answer; answering one leaves the other pending', async () => {
    const access = await connected();
    const first = access.query(GRANT_ID, 'SELECT amount FROM transactions');
    const second = access.query(OTHER_GRANT_ID, 'SELECT name FROM items');
    const firstState = track(first);
    const secondState = track(second);
    await flush();
    const [a, b] = host.accessRequests().map(parsedRequest);
    expect(a!.op === 'query' && a!.grantId).toBe(GRANT_ID);
    expect(b!.op === 'query' && b!.grantId).toBe(OTHER_GRANT_ID);

    host.accessSucceed(b!.requestId, { op: 'query', columns: ['name'], rows: [['rice']] });
    await flush();
    expect(secondState.settled()).toBe(true);
    expect(firstState.settled()).toBe(false);
    expect(bridge.accessPending.size).toBe(1);

    host.accessSucceed(a!.requestId, { op: 'query', columns: ['amount'], rows: [[12.5]] });
    await expect(first).resolves.toEqual({ ok: true, columns: ['amount'], rows: [[12.5]] });
    await expect(second).resolves.toEqual({ ok: true, columns: ['name'], rows: [['rice']] });
    expect(bridge.accessPending.size).toBe(0);
  });

  it('an error response resolves { ok: false, error } for every op — errors as data, never a rejection', async () => {
    const access = await connected();
    const calls = [access.request('to show spending'), access.query(GRANT_ID, 'SELECT 1'), access.list(), access.release(GRANT_ID)];
    await flush();
    const frames = host.accessRequests().map(parsedRequest);
    const errors = [
      { code: 'ACCESS_DECLINED', message: 'not now', retryable: true },
      { code: 'ACCESS_REVOKED', message: 'access was stopped', retryable: false },
      { code: 'ACCESS_RATE_LIMITED', message: 'too many reads', retryable: true },
      { code: 'ACCESS_NOT_GRANTED', message: 'no such access', retryable: false },
    ];
    frames.forEach((frame, i) => host.accessFail(frame.requestId, errors[i]!));
    const results = await Promise.all(calls);
    expect(results).toEqual(errors.map((error) => ({ ok: false, error })));
  });

  it('before host-ready EVERY call resolves HOST_ERROR "not connected to host yet" (retryable) and posts nothing', async () => {
    const probe = await mount(() => useSnugAccess());
    const access = probe.result.current;
    expect(bridge.ready).toBe(false);
    const results = await Promise.all([access.request('to show spending'), access.query(GRANT_ID, 'SELECT 1'), access.list(), access.release(GRANT_ID)]);
    expect(results).toEqual([NOT_CONNECTED, NOT_CONNECTED, NOT_CONNECTED, NOT_CONNECTED]);
    await flush();
    expect(host.accessRequests()).toHaveLength(0);
    expect(bridge.accessPending.size).toBe(0);
  });

  it('the passing twin: the SAME hook instance posts once host-ready arrives (useSnugAccess may be the first and only hook to mount)', async () => {
    const probe = await mount(() => useSnugAccess());
    await flush();
    host.ready({ capabilities: CAPS_ACCESS });
    await flush();
    expect(bridge.ready).toBe(true);
    const call = probe.result.current.list();
    await flush();
    const [posted] = host.accessRequests();
    host.accessSucceed(parsedRequest(posted).requestId, { op: 'list', grants: [] });
    await expect(call).resolves.toEqual({ ok: true, grants: [] });
  });

  for (const [label, capabilities] of [
    ['absent (a 1.0 host)', CAPS_1_0],
    ['false (a 1.1 host with no handler)', { ...CAPS_1_0, access: false }],
  ] as const) {
    it(`ready but access ${label}: EVERY call resolves a non-retryable HOST_ERROR, posts nothing and leaves nothing pending (never a hang)`, async () => {
      const access = await connected({ capabilities });
      expect(bridge.ready).toBe(true);
      const results = await Promise.all([access.request('to show spending'), access.query(GRANT_ID, 'SELECT 1'), access.list(), access.release(GRANT_ID)]);
      expect(results).toEqual([NOT_OFFERED, NOT_OFFERED, NOT_OFFERED, NOT_OFFERED]);
      await flush();
      expect(host.accessRequests()).toHaveLength(0);
      expect(bridge.accessPending.size).toBe(0);
    });
  }

  it('the passing twin: a ready host advertising access: true gets every op posted', async () => {
    const access = await connected({ capabilities: CAPS_ACCESS });
    void access.request('to show spending');
    void access.query(GRANT_ID, 'SELECT 1');
    void access.list();
    void access.release(GRANT_ID);
    await flush();
    expect(host.accessRequests().map((f) => parsedRequest(f).op)).toEqual(['request', 'query', 'list', 'release']);
    expect(bridge.accessPending.size).toBe(4);
  });

  it('a post the browser refuses (postMessage throws DataCloneError on an uncloneable value) RESOLVES a HOST_ERROR result — never a rejection — and leaves nothing pending', async () => {
    const access = await connected();
    const post = vi.spyOn(window.parent, 'postMessage').mockImplementationOnce(() => {
      throw new DOMException('() => 1 could not be cloned.', 'DataCloneError');
    });
    try {
      const uncloneable = [(() => 1) as unknown as string];
      await expect(access.query(GRANT_ID, 'SELECT ?', uncloneable)).resolves.toEqual({
        ok: false,
        error: { code: ERROR_CODES.HOST_ERROR, message: 'the access request could not be posted', retryable: false },
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(bridge.accessPending.size).toBe(0);
    } finally {
      post.mockRestore();
    }
    // The passing twin: the next, cloneable call posts and stays pending for its answer.
    void access.list();
    await flush();
    expect(host.accessRequests()).toHaveLength(1);
    expect(bridge.accessPending.size).toBe(1);
  });

  it('a response is terminal exactly once: an unknown requestId is ignored, a second answer for an answered id changes nothing', async () => {
    const access = await connected();
    const call = access.list();
    const state = track(call);
    await flush();
    const [posted] = host.accessRequests();
    const { requestId } = parsedRequest(posted);
    host.accessSucceed('not-a-pending-id', { op: 'list', grants: [VIEW] });
    await flush();
    expect(state.settled()).toBe(false);
    host.accessSucceed(requestId, { op: 'list', grants: [] });
    host.accessFail(requestId, { code: 'ACCESS_REVOKED' });
    await flush();
    expect(state.value()).toEqual({ ok: true, grants: [] });
    expect(bridge.accessPending.size).toBe(0);
  });

  it('a response the protocol parser rejects (a query answer with no rows) is ignored — the call waits for a valid terminal frame', async () => {
    const access = await connected();
    const call = access.query(GRANT_ID, 'SELECT 1');
    const state = track(call);
    await flush();
    const { requestId } = parsedRequest(host.accessRequests()[0]);
    host.accessSucceed(requestId, { op: 'query', columns: ['1'] }); // no rows — parseFrame refuses it
    await flush();
    expect(state.settled()).toBe(false);
    host.accessSucceed(requestId, { op: 'query', columns: ['1'], rows: [[1]] });
    await expect(call).resolves.toEqual({ ok: true, columns: ['1'], rows: [[1]] });
  });

  it('a success answer for a DIFFERENT op than was asked resolves a HOST_ERROR result (never a mis-shaped success, never a hang); the matching op resolves ok', async () => {
    const access = await connected();
    const mismatched = access.query(GRANT_ID, 'SELECT 1');
    const matched = access.list();
    await flush();
    const [q, l] = host.accessRequests().map(parsedRequest);
    host.accessSucceed(q!.requestId, { op: 'list', grants: [VIEW] });
    host.accessSucceed(l!.requestId, { op: 'list', grants: [VIEW] });
    const answer = await mismatched;
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.code).toBe(ERROR_CODES.HOST_ERROR);
    expect(answer.error.retryable).toBe(false);
    await expect(matched).resolves.toEqual({ ok: true, grants: [VIEW] });
    expect(bridge.accessPending.size).toBe(0);
  });

  it('__resetSnugBridgeForTests clears the access pending map', async () => {
    const access = await connected();
    void access.list();
    expect(bridge.accessPending.size).toBe(1);
    __resetSnugBridgeForTests();
    expect(bridge.accessPending.size).toBe(0);
  });

  describe('onChange — the host-event "access-changed" hint (ids only, R7)', () => {
    const changed = (data?: unknown): void =>
      host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: ACCESS_CHANGED_EVENT, ...(data !== undefined ? { data } : {}) });

    it('fires with { grantId } on access-changed — extra keys on the data seat are dropped', async () => {
      const probe = await mount(() => useSnugAccess());
      const seen: unknown[] = [];
      probe.result.current.onChange((data) => seen.push(data));
      changed({ grantId: GRANT_ID });
      changed({ grantId: OTHER_GRANT_ID, rows: [[1]] });
      expect(seen).toEqual([{ grantId: GRANT_ID }, { grantId: OTHER_GRANT_ID }]);
    });

    it('does not fire on another host-event carrying the same data (schedule-run, theme-change, an unknown one)', async () => {
      const probe = await mount(() => useSnugAccess());
      const seen: unknown[] = [];
      probe.result.current.onChange((data) => seen.push(data));
      for (const event of ['schedule-run', 'theme-change', 'access-changed-v2']) {
        host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event, data: { grantId: GRANT_ID } });
      }
      expect(seen).toEqual([]);
      changed({ grantId: GRANT_ID }); // the passing twin
      expect(seen).toEqual([{ grantId: GRANT_ID }]);
    });

    it('subscribes through onHostEvent under the PROTOCOL constant, and the returned unsubscribe stops it', async () => {
      expect(ACCESS_CHANGED_EVENT).toBe('access-changed');
      const probe = await mount(() => useSnugAccess());
      const seen: unknown[] = [];
      const off = probe.result.current.onChange((data) => seen.push(data));
      expect(bridge.hostEventListeners.get(ACCESS_CHANGED_EVENT)?.size).toBe(1);
      changed({ grantId: GRANT_ID });
      off();
      expect(bridge.hostEventListeners.has(ACCESS_CHANGED_EVENT)).toBe(false);
      changed({ grantId: OTHER_GRANT_ID });
      expect(seen).toEqual([{ grantId: GRANT_ID }]);
    });

    it('a malformed data seat is ignored (none, a string, null, an array, no grantId, a non-string or empty grantId); the well-formed twin fires', async () => {
      const probe = await mount(() => useSnugAccess());
      const seen: unknown[] = [];
      probe.result.current.onChange((data) => seen.push(data));
      changed();
      changed(GRANT_ID);
      changed(null);
      changed([GRANT_ID]);
      changed({ id: GRANT_ID });
      changed({ grantId: 7 });
      changed({ grantId: '' });
      expect(seen).toEqual([]);
      changed({ grantId: GRANT_ID });
      expect(seen).toEqual([{ grantId: GRANT_ID }]);
    });

    it('works before host-ready: a subscription needs no instanceId', async () => {
      const probe = await mount(() => useSnugAccess());
      expect(bridge.ready).toBe(false);
      const seen: unknown[] = [];
      probe.result.current.onChange((data) => seen.push(data));
      changed({ grantId: GRANT_ID });
      expect(seen).toEqual([{ grantId: GRANT_ID }]);
    });
  });

  // TASK-20261010-host-broker PR-3 (AC27; spec 1.2, ADR-0076 §4–§8; D-PR3-14, DS10): the three new
  // ops and the three new hints. Each settler hands back ONLY the seats the protocol defines for its
  // answer (the response is tolerant, so a host may send more); a success for another op is the
  // same `mismatch` HOST_ERROR the 1.1 settlers answer; the three listeners read ids only.
  describe('PR-3 — write, refresh, discover and the three hints (module form)', () => {
    it('write(grantId, sql, params) posts ONE strict op "write" the protocol schema parses, and resolves { ok: true, changes } — nothing else crosses', async () => {
      const access = await connected();
      const call = access.write(GRANT_ID, 'UPDATE transactions SET category = ? WHERE id = ?', ['food', 7]);
      await flush();
      const [posted] = host.accessRequests();
      const frame = parsedRequest(posted);
      expect(posted).toEqual({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        type: FRAME_TYPES.accessRequest,
        requestId: frame.requestId,
        op: 'write',
        grantId: GRANT_ID,
        sql: 'UPDATE transactions SET category = ? WHERE id = ?',
        params: ['food', 7],
      });
      host.accessSucceed(frame.requestId, { op: 'write', changes: 3, undoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
      const result = await call;
      expect(result).toEqual({ ok: true, changes: 3 });
      expect(Object.keys(result).sort()).toEqual(['changes', 'ok']);
    });

    it('write without params posts no params key', async () => {
      const access = await connected();
      void access.write(GRANT_ID, 'DELETE FROM transactions WHERE id = 7');
      await flush();
      const [posted] = host.accessRequests();
      parsedRequest(posted);
      expect(Object.keys(posted!).sort()).toEqual(['grantId', 'instanceId', 'op', 'requestId', 'sql', 'type', 'v']);
    });

    it('refresh(grantId) posts op "refresh" and resolves { ok: true, fresh } — reason only when the host sent one, never a summary', async () => {
      const access = await connected();
      const fresh = access.refresh(GRANT_ID);
      const recent = access.refresh(OTHER_GRANT_ID);
      await flush();
      const [a, b] = host.accessRequests();
      expect(a).toEqual({ v: PROTOCOL_VERSION, instanceId: 'ins-1', type: FRAME_TYPES.accessRequest, requestId: parsedRequest(a).requestId, op: 'refresh', grantId: GRANT_ID });
      host.accessSucceed(parsedRequest(a).requestId, { op: 'refresh', fresh: true, summary: 'fetched 3 new rows' });
      host.accessSucceed(parsedRequest(b).requestId, { op: 'refresh', fresh: false, reason: 'recent' });
      const first = await fresh;
      expect(first).toEqual({ ok: true, fresh: true });
      expect(Object.keys(first).sort()).toEqual(['fresh', 'ok']);
      await expect(recent).resolves.toEqual({ ok: true, fresh: false, reason: 'recent' });
    });

    it('discover(hints) posts op "discover" with the hints (none → no hints key) and resolves { ok: true, candidates }', async () => {
      const access = await connected();
      const withHints = access.discover({ words: ['spending'], tables: ['transactions'] });
      const bare = access.discover();
      await flush();
      const [a, b] = host.accessRequests();
      expect(a).toEqual({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        type: FRAME_TYPES.accessRequest,
        requestId: parsedRequest(a).requestId,
        op: 'discover',
        hints: { words: ['spending'], tables: ['transactions'] },
      });
      expect(Object.keys(b!).sort()).toEqual(['instanceId', 'op', 'requestId', 'type', 'v']);
      expect(parsedRequest(b).op).toBe('discover');
      host.accessSucceed(parsedRequest(a).requestId, { op: 'discover', candidates: 'one', count: 1 });
      host.accessSucceed(parsedRequest(b).requestId, { op: 'discover', candidates: 'none' });
      const first = await withHints;
      expect(first).toEqual({ ok: true, candidates: 'one' });
      expect(Object.keys(first).sort()).toEqual(['candidates', 'ok']);
      await expect(bare).resolves.toEqual({ ok: true, candidates: 'none' });
    });

    it('request(purpose, { access: "write" }) posts the access field (the protocol schema parses it); without it no access key is posted', async () => {
      const access = await connected();
      void access.request('to fix the categories', { hints: { tables: ['transactions'] }, access: 'write' });
      void access.request('to show spending', { hints: { tables: ['transactions'] } });
      await flush();
      const [withAccess, without] = host.accessRequests();
      const frame = parsedRequest(withAccess);
      expect(withAccess).toEqual({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        type: FRAME_TYPES.accessRequest,
        requestId: frame.requestId,
        op: 'request',
        purpose: 'to fix the categories',
        hints: { tables: ['transactions'] },
        access: 'write',
      });
      parsedRequest(without);
      expect('access' in without!).toBe(false);
    });

    it('a write answered to a query (and a query answered to a write, a discover to a refresh) resolves the mismatch HOST_ERROR — never a mis-shaped success, never a hang', async () => {
      const access = await connected();
      const asQuery = track(access.query(GRANT_ID, 'SELECT 1'));
      const asWrite = track(access.write(GRANT_ID, 'DELETE FROM transactions WHERE id = 7'));
      const asRefresh = track(access.refresh(GRANT_ID));
      await flush();
      const [q, w, r] = host.accessRequests().map(parsedRequest);
      host.accessSucceed(q!.requestId, { op: 'write', changes: 3 });
      host.accessSucceed(w!.requestId, { op: 'query', columns: ['n'], rows: [[1]] });
      host.accessSucceed(r!.requestId, { op: 'discover', candidates: 'one' });
      await flush();
      expect(asQuery.settled() && asWrite.settled() && asRefresh.settled()).toBe(true);
      const mismatch = (answered: string, asked: string) => ({
        ok: false,
        error: { code: ERROR_CODES.HOST_ERROR, message: `the host answered an access ${answered} to an access ${asked}`, retryable: false },
      });
      expect(asQuery.value()).toEqual(mismatch('write', 'query'));
      expect(asWrite.value()).toEqual(mismatch('query', 'write'));
      expect(asRefresh.value()).toEqual(mismatch('discover', 'refresh'));
      expect(bridge.accessPending.size).toBe(0);
    });

    it('an error response resolves { ok: false, error } for each new op — the three new codes as data, retryable intact', async () => {
      const access = await connected();
      const calls = [access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'), access.write(GRANT_ID, 'DELETE FROM t WHERE id = 2'), access.refresh(GRANT_ID), access.discover()];
      await flush();
      const frames = host.accessRequests().map(parsedRequest);
      const errors = [
        { code: 'ACCESS_WRITE_REFUSED', message: 'the change was refused', retryable: false },
        { code: 'ACCESS_BUSY', message: 'the other app is in the middle of a change — try again', retryable: true },
        { code: 'ACCESS_REFRESH_FAILED', message: 'the other app does not fetch on request', retryable: false },
        { code: 'ACCESS_UNATTENDED', message: 'not while nobody is looking', retryable: true },
      ];
      frames.forEach((frame, i) => host.accessFail(frame.requestId, errors[i]!));
      await expect(Promise.all(calls)).resolves.toEqual(errors.map((error) => ({ ok: false, error })));
    });

    it('the guards hold for the new ops: before host-ready NOT_CONNECTED, on a host without access NOT_OFFERED — nothing posted, nothing pending', async () => {
      const early = await mount(() => useSnugAccess());
      const before = await Promise.all([early.result.current.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'), early.result.current.refresh(GRANT_ID), early.result.current.discover()]);
      expect(before).toEqual([NOT_CONNECTED, NOT_CONNECTED, NOT_CONNECTED]);
      const access = await connected({ capabilities: CAPS_1_0 });
      const after = await Promise.all([access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'), access.refresh(GRANT_ID), access.discover()]);
      expect(after).toEqual([NOT_OFFERED, NOT_OFFERED, NOT_OFFERED]);
      await flush();
      expect(host.accessRequests()).toHaveLength(0);
      expect(bridge.accessPending.size).toBe(0);
    });

    it('every new call mints a FRESH requestId too', async () => {
      const access = await connected();
      void access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1');
      void access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1');
      void access.refresh(GRANT_ID);
      void access.discover();
      await flush();
      const ids = host.accessRequests().map((f) => parsedRequest(f).requestId);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      for (const id of ids) expect(id).toMatch(UUID_V4);
    });

    /** The three hints, each with the ONE seat its listener receives (ids only, R7). */
    const HINTS = [
      { method: 'onSourceChanged', name: 'access-source-changed', event: ACCESS_SOURCE_CHANGED_EVENT, seat: 'grantId', value: GRANT_ID },
      { method: 'onDataChanged', name: 'data-changed', event: DATA_CHANGED_EVENT, seat: 'table', value: 'transactions' },
      { method: 'onRead', name: 'access-read', event: ACCESS_READ_EVENT, seat: 'grantId', value: GRANT_ID },
    ] as const;
    const hostEvent = (event: string, data?: unknown): void =>
      host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event, ...(data !== undefined ? { data } : {}) });

    for (const { method, name, event, seat, value } of HINTS) {
      it(`${method} receives exactly { ${seat} } on "${name}" — extra keys (a row, a count, a name) are dropped`, async () => {
        expect(event).toBe(name);
        const probe = await mount(() => useSnugAccess());
        const seen: unknown[] = [];
        probe.result.current[method]((data: unknown) => seen.push(data));
        hostEvent(event, { [seat]: value });
        hostEvent(event, { [seat]: value, rows: [[1]], changes: 3, sourceName: 'Ledger' });
        expect(seen).toEqual([{ [seat]: value }, { [seat]: value }]);
      });

      it(`${method} ignores a malformed data seat and every OTHER host-event carrying the same data`, async () => {
        const probe = await mount(() => useSnugAccess());
        const seen: unknown[] = [];
        probe.result.current[method]((data: unknown) => seen.push(data));
        hostEvent(event);
        hostEvent(event, value);
        hostEvent(event, null);
        hostEvent(event, [value]);
        hostEvent(event, { [seat]: 7 });
        hostEvent(event, { [seat]: '' });
        hostEvent(event, { other: value });
        for (const other of [ACCESS_CHANGED_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT, 'schedule-run']) {
          if (other !== event) hostEvent(other, { grantId: GRANT_ID, table: 'transactions' });
        }
        expect(seen).toEqual([]);
        hostEvent(event, { [seat]: value }); // the passing twin
        expect(seen).toEqual([{ [seat]: value }]);
      });

      it(`${method} subscribes through onHostEvent under the PROTOCOL constant, works before host-ready, and its unsubscribe stops it`, async () => {
        const probe = await mount(() => useSnugAccess());
        expect(bridge.ready).toBe(false);
        const seen: unknown[] = [];
        const off = probe.result.current[method]((data: unknown) => seen.push(data));
        expect(bridge.hostEventListeners.get(event)?.size).toBe(1);
        hostEvent(event, { [seat]: value });
        off();
        expect(bridge.hostEventListeners.has(event)).toBe(false);
        hostEvent(event, { [seat]: value });
        expect(seen).toEqual([{ [seat]: value }]);
      });
    }

    it('onChange still hears only access-changed — the three new hints never reach it', async () => {
      const probe = await mount(() => useSnugAccess());
      const seen: unknown[] = [];
      probe.result.current.onChange((data) => seen.push(data));
      for (const event of [ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT]) hostEvent(event, { grantId: GRANT_ID, table: 't' });
      expect(seen).toEqual([]);
    });
  });

  describe('HostCapabilities.access — the host-ready advertisement (optional; the protocol is additive, R2)', () => {
    it('carries access: true from a 1.1 ready frame', async () => {
      await connected({ capabilities: { streaming: true, db: true, auth: false, access: true } });
      const caps: HostCapabilities = bridge.capabilities;
      expect(caps.access).toBe(true);
    });

    it('carries access: false when the host says no', async () => {
      await connected({ capabilities: { streaming: true, db: true, auth: false, access: false } });
      expect(bridge.capabilities.access).toBe(false);
    });

    it('a 1.0 ready frame with no access key still connects, and access reads undefined', async () => {
      await connected({ capabilities: CAPS_1_0 });
      expect(bridge.ready).toBe(true);
      expect(bridge.capabilities.access).toBeUndefined();
    });
  });
});

describe('the public surface — @snugprotocol/sdk index and types (AC5)', () => {
  it('exports useSnugAccess and the event name — the protocol constant itself, never a retyped literal', () => {
    expect(sdk.useSnugAccess).toBe(useSnugAccess);
    expect(sdk.ACCESS_CHANGED_EVENT).toBe(ACCESS_CHANGED_EVENT);
  });

  it('types: AccessGrantView IS the protocol’s inferred view; the result types are errors-as-data unions; SnugAccess has the eleven methods (PR-3: + write, refresh, discover, onSourceChanged, onDataChanged, onRead)', () => {
    expectTypeOf<AccessGrantView>().toEqualTypeOf<ProtocolAccessGrantView>();
    expectTypeOf<AccessRequestHints>().toEqualTypeOf<AccessHints>();
    // The bridge's op is the protocol's AccessOp — a typo is a compile error, not a MALFORMED in production.
    // @ts-expect-error 'relase' is not an AccessOp
    expectTypeOf(() => accessRequest({ op: 'relase', grantId: GRANT_ID }, () => undefined)).toBeFunction();
    expectTypeOf<HostCapabilities['access']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Extract<AccessQueryResult, { ok: true }>>().toEqualTypeOf<{
      ok: true;
      columns: string[];
      rows: unknown[][];
      truncated?: boolean;
      totalRows?: number;
    }>();
    expectTypeOf<Extract<AccessQueryResult, { ok: false }>['error']>().toEqualTypeOf<ResponseError>();
    expectTypeOf<Extract<AccessRequestResult, { ok: true }>>().toEqualTypeOf<{ ok: true; grant: AccessGrantView }>();
    expectTypeOf<Extract<AccessListResult, { ok: true }>>().toEqualTypeOf<{ ok: true; grants: AccessGrantView[] }>();
    expectTypeOf<Extract<AccessReleaseResult, { ok: true }>>().toEqualTypeOf<{ ok: true }>();
    expectTypeOf<SnugAccess['query']>().returns.toEqualTypeOf<Promise<AccessQueryResult>>();
    expectTypeOf<SnugAccess['request']>().returns.toEqualTypeOf<Promise<AccessRequestResult>>();
    expectTypeOf<SnugAccess['list']>().returns.toEqualTypeOf<Promise<AccessListResult>>();
    expectTypeOf<SnugAccess['release']>().returns.toEqualTypeOf<Promise<AccessReleaseResult>>();
    expectTypeOf<SnugAccess['onChange']>().returns.toEqualTypeOf<() => void>();
    // PR-3 — the three new result types are the real exports from '../index.js' (I-W swapped the
    // test lane's LOCAL structural shapes for them, as the lane's note foresaw); each success arm
    // is still pinned structurally, exactly as the 1.1 result types are above.
    expectTypeOf<Extract<AccessWriteResult, { ok: true }>>().toEqualTypeOf<{ ok: true; changes: number }>();
    expectTypeOf<Extract<AccessRefreshResult, { ok: true }>>().toEqualTypeOf<{ ok: true; fresh: boolean; reason?: string }>();
    expectTypeOf<Extract<AccessDiscoverResult, { ok: true }>>().toEqualTypeOf<{ ok: true; candidates: 'none' | 'one' | 'several' }>();
    expectTypeOf<Extract<AccessWriteResult, { ok: false }>['error']>().toEqualTypeOf<ResponseError>();
    expectTypeOf<SnugAccess['write']>().parameters.toEqualTypeOf<[grantId: string, sql: string, params?: AccessParam[]]>();
    expectTypeOf<SnugAccess['write']>().returns.toEqualTypeOf<Promise<AccessWriteResult>>();
    expectTypeOf<SnugAccess['refresh']>().parameters.toEqualTypeOf<[grantId: string]>();
    expectTypeOf<SnugAccess['refresh']>().returns.toEqualTypeOf<Promise<AccessRefreshResult>>();
    expectTypeOf<SnugAccess['discover']>().parameters.toEqualTypeOf<[hints?: AccessRequestHints]>();
    expectTypeOf<SnugAccess['discover']>().returns.toEqualTypeOf<Promise<AccessDiscoverResult>>();
    expectTypeOf<SnugAccess['onSourceChanged']>().parameters.toEqualTypeOf<[listener: (data: { grantId: string }) => void]>();
    expectTypeOf<SnugAccess['onDataChanged']>().parameters.toEqualTypeOf<[listener: (data: { table: string }) => void]>();
    expectTypeOf<SnugAccess['onRead']>().parameters.toEqualTypeOf<[listener: (data: { grantId: string }) => void]>();
    expectTypeOf<SnugAccess['onSourceChanged']>().returns.toEqualTypeOf<() => void>();
    expectTypeOf<SnugAccess['onDataChanged']>().returns.toEqualTypeOf<() => void>();
    expectTypeOf<SnugAccess['onRead']>().returns.toEqualTypeOf<() => void>();
    expectTypeOf<AccessRequestOptions['access']>().toEqualTypeOf<'read' | 'write' | undefined>();
  });

  it('PR-3: exports the three new event names — the protocol constants themselves, never retyped literals', () => {
    expect((sdk as Record<string, unknown>).ACCESS_SOURCE_CHANGED_EVENT).toBe(ACCESS_SOURCE_CHANGED_EVENT);
    expect((sdk as Record<string, unknown>).DATA_CHANGED_EVENT).toBe(DATA_CHANGED_EVENT);
    expect((sdk as Record<string, unknown>).ACCESS_READ_EVENT).toBe(ACCESS_READ_EVENT);
    expect([ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT]).toEqual(['access-source-changed', 'data-changed', 'access-read']);
  });

  it('the embedded hooks block is UNCHANGED by access (Q9): it posts no access frame and names no access hook', () => {
    const embedded = readFileSync(path.resolve(process.cwd(), 'embedded/snug-hooks.js'), 'utf8');
    expect(embedded).not.toContain(FRAME_TYPES.accessRequest);
    expect(embedded).not.toContain('useSnugAccess');
    expect(embedded).not.toContain(ACCESS_CHANGED_EVENT);
  });
});
