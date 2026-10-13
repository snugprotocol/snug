// The ONE access-between-apps contract for both SDK forms (TASK-20261010-host-broker PR-6, AC40b;
// ADR-0075/0076; D-PR6-4). Registered twice: contract-module.test.ts (the typed `access.ts` over
// `bridge.ts`'s `accessRequest`) and contract-embedded.test.ts (section 7 of embedded/snug-hooks.js:
// `snugAccessCall` + the settlers, over section 1's access-response arm). A fake host plays the other
// side on the same jsdom window: every posted `snug:access-request` is PARSED with the protocol's
// own `accessRequestSchema` (the host's reading, never eyeballed) and answered with
// `snug:access-response` frames in any order it likes.
//
// Where the forms legitimately differ (D-PR6-4) the row is ONE form's only, and the other form's
// behaviour is never asserted here:
// - a success frame the protocol parser REJECTS (no result seat, a non-string `op`, a discover class
//   outside the three, `ok: false` with no error object): the embedded settler answers a HOST_ERROR
//   naming it ('…without its result', '…with no error'); the module ignores the frame and waits for
//   a valid one (`access.test.ts`, module-only — the reversal word "wait");
// - the module's zod strips unknown keys INSIDE `grant` / `grants[]` / `error`; the embedded form
//   hands those objects back raw — so the shared rows use objects exactly in the protocol's shape.
import {
  ACCESS_CANDIDATE_CLASSES,
  ACCESS_CHANGED_EVENT,
  ACCESS_READ_EVENT,
  ACCESS_SOURCE_CHANGED_EVENT,
  DATA_CHANGED_EVENT,
  ERROR_CODES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessRequestSchema,
  type AccessGrantView,
  type AccessRequestFrame,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneFaithfulPostMessage, drainMessageQueue, flush, hostStub, renderProbe, type AppFrame, type HostStub, type Probe } from './app-harness.js';
import {
  accessPendingOf,
  hostEventFrame,
  hostEventListenersOf,
  need,
  type ContractAccess,
  type ContractForm,
  type ContractFormName,
} from './contract-host-events.js';
import type { ContractMeta } from './contract-suite.js';

const META: ContractMeta = { appId: 'budget', displayName: 'Budget' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GRANT_ID = '3f1c2b9e-8a47-4d21-9c3e-5b6a7d8e9f01';
const OTHER_GRANT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A grant view exactly in the protocol's `accessGrantViewSchema` shape (both forms hand it back equal). */
const VIEW: AccessGrantView = {
  id: GRANT_ID,
  access: 'read',
  source: { displayName: 'Ledger', iconEmoji: '📒', iconColor: '#335577' },
  tables: [{ name: 'transactions', columns: ['amount', 'category', 'date'] }],
  duration: 'day',
  expiresAt: '2026-10-11T09:00:00.000Z',
  unattended: false,
};

const CAPS_1_0 = { streaming: true, db: true, auth: false } as const;
const CAPS_ACCESS = { ...CAPS_1_0, access: true } as const;

const hostError = (message: string, retryable: boolean) => ({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, message, retryable } });
const NOT_CONNECTED = hostError('not connected to host yet', true);
const NOT_OFFERED = hostError('this host does not offer access between apps', false);
const NOT_POSTED = hostError('the access request could not be posted', false);

type OpName = 'request' | 'query' | 'write' | 'refresh' | 'list' | 'release' | 'discover';

/** Each op: one call, a valid success answer (the result seats only), and what the call resolves. */
const OPS: ReadonlyArray<{ op: OpName; call: (a: ContractAccess) => Promise<unknown>; answer: Record<string, unknown>; result: Record<string, unknown> }> = [
  { op: 'request', call: (a) => a.request('to show spending'), answer: { op: 'request', grant: VIEW }, result: { ok: true, grant: VIEW } },
  { op: 'query', call: (a) => a.query(GRANT_ID, 'SELECT 1'), answer: { op: 'query', columns: ['1'], rows: [[1]] }, result: { ok: true, columns: ['1'], rows: [[1]] } },
  { op: 'write', call: (a) => a.write(GRANT_ID, 'DELETE FROM transactions WHERE id = 7'), answer: { op: 'write', changes: 1 }, result: { ok: true, changes: 1 } },
  { op: 'refresh', call: (a) => a.refresh(GRANT_ID), answer: { op: 'refresh', fresh: true }, result: { ok: true, fresh: true } },
  { op: 'list', call: (a) => a.list(), answer: { op: 'list', grants: [VIEW] }, result: { ok: true, grants: [VIEW] } },
  { op: 'release', call: (a) => a.release(GRANT_ID), answer: { op: 'release' }, result: { ok: true } },
  { op: 'discover', call: (a) => a.discover(), answer: { op: 'discover', candidates: 'several' }, result: { ok: true, candidates: 'several' } },
];

/** The four id-only hints and the methods that answer them. */
const GRANT_HINTS = [
  { method: 'onChange', event: ACCESS_CHANGED_EVENT, name: 'access-changed' },
  { method: 'onSourceChanged', event: ACCESS_SOURCE_CHANGED_EVENT, name: 'access-source-changed' },
  { method: 'onRead', event: ACCESS_READ_EVENT, name: 'access-read' },
] as const;

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

export function registerAccessContract(formName: string, form: ContractFormName, fresh: () => ContractForm): void {
  describe(`SDK access contract — ${formName}`, () => {
    let host: HostStub;
    const probes: Probe<unknown>[] = [];

    const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
      const probe = await renderProbe(body);
      probes.push(probe as Probe<unknown>);
      return probe;
    };

    /** Mounts useSnugAccess alone (no handshake) and answers its object. */
    const accessOf = async (api: ContractForm) => {
      const useSnugAccess = need(api, 'useSnugAccess');
      return mount(() => useSnugAccess());
    };

    /**
     * Mounts useSnugApp + useSnugAccess and completes the handshake. The default host ADVERTISES
     * `access: true` (D-PR6-14) — the per-op rows run against a host that routes the pair.
     */
    const connected = async (api: ContractForm, capabilities: object = CAPS_ACCESS): Promise<ContractAccess> => {
      const useSnugAccess = need(api, 'useSnugAccess');
      const probe = await mount(() => {
        api.useSnugApp(META);
        return useSnugAccess();
      });
      await flush();
      host.ready({ capabilities });
      await flush();
      return probe.result.current;
    };

    const hostEvent = (event: string, data?: unknown): void => host.post(hostEventFrame(event, data));
    const foreignEvent = (event: string, data?: unknown): void => host.foreign(hostEventFrame(event, data));
    const posted = (): AccessRequestFrame[] => host.accessRequests().map(parsedRequest);

    // RC-1 (Gate 5): jsdom CATCHES an exception thrown inside a message listener (the bridge's),
    // reports it as a window 'error' event and carries on — so a guard that throws would pass any
    // row asserting only "nothing happened". Every such report fails the row that caused it.
    const errors: string[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(String(e.error ?? e.message));
      e.preventDefault();
    };

    beforeEach(async () => {
      await drainMessageQueue();
      host = hostStub();
      errors.length = 0;
      window.addEventListener('error', onError);
    });

    afterEach(() => {
      while (probes.length > 0) probes.pop()?.unmount();
      host.dispose();
      vi.restoreAllMocks();
      window.removeEventListener('error', onError);
      expect(errors, 'an exception thrown inside a listener (jsdom reported it and carried on)').toEqual([]);
    });

    it(`the factory says which form it is (${form})`, () => {
      expect(fresh().form).toBe(form);
    });

    it('exposes the eleven — request, query, write, refresh, list, release, discover, onChange, onSourceChanged, onDataChanged, onRead — on ONE stable object across renders', async () => {
      const api = fresh();
      const probe = await accessOf(api);
      const first = probe.result.current;
      const ELEVEN = ['request', 'query', 'write', 'refresh', 'list', 'release', 'discover', 'onChange', 'onSourceChanged', 'onDataChanged', 'onRead'];
      expect(Object.keys(first).sort()).toEqual([...ELEVEN].sort());
      for (const key of ELEVEN) expect(typeof (first as unknown as Record<string, unknown>)[key], key).toBe('function');
      await probe.rerender();
      expect(probe.result.current).toBe(first);
    });

    it('each op posts the STRICT shape accessRequestSchema parses — every absent optional key ABSENT, never undefined', async () => {
      const api = fresh();
      const access = await connected(api);
      const cases: ReadonlyArray<{ label: string; call: () => Promise<unknown>; fields: Record<string, unknown> }> = [
        {
          label: 'request with every option',
          call: () => access.request('to fix the categories', { hints: { words: ['spending'], tables: ['transactions'] }, renew: OTHER_GRANT_ID, access: 'write' }),
          fields: { op: 'request', purpose: 'to fix the categories', hints: { words: ['spending'], tables: ['transactions'] }, renew: OTHER_GRANT_ID, access: 'write' },
        },
        { label: 'request bare', call: () => access.request('to show spending'), fields: { op: 'request', purpose: 'to show spending' } },
        {
          label: 'request with options all undefined',
          call: () => access.request('to show spending', { hints: undefined, renew: undefined, access: undefined }),
          fields: { op: 'request', purpose: 'to show spending' },
        },
        {
          label: 'query with params',
          call: () => access.query(GRANT_ID, 'SELECT amount FROM transactions WHERE amount > ?', [10, 'x', true, null]),
          fields: { op: 'query', grantId: GRANT_ID, sql: 'SELECT amount FROM transactions WHERE amount > ?', params: [10, 'x', true, null] },
        },
        { label: 'query without params', call: () => access.query(GRANT_ID, 'SELECT 1'), fields: { op: 'query', grantId: GRANT_ID, sql: 'SELECT 1' } },
        {
          label: 'write with params',
          call: () => access.write(GRANT_ID, 'UPDATE transactions SET category = ? WHERE id = ?', ['food', 7]),
          fields: { op: 'write', grantId: GRANT_ID, sql: 'UPDATE transactions SET category = ? WHERE id = ?', params: ['food', 7] },
        },
        {
          label: 'write without params',
          call: () => access.write(GRANT_ID, 'DELETE FROM transactions WHERE id = 7'),
          fields: { op: 'write', grantId: GRANT_ID, sql: 'DELETE FROM transactions WHERE id = 7' },
        },
        { label: 'refresh', call: () => access.refresh(GRANT_ID), fields: { op: 'refresh', grantId: GRANT_ID } },
        { label: 'list', call: () => access.list(), fields: { op: 'list' } },
        { label: 'release', call: () => access.release(GRANT_ID), fields: { op: 'release', grantId: GRANT_ID } },
        {
          label: 'discover with hints',
          call: () => access.discover({ words: ['spending'], tables: ['transactions'] }),
          fields: { op: 'discover', hints: { words: ['spending'], tables: ['transactions'] } },
        },
        { label: 'discover bare', call: () => access.discover(), fields: { op: 'discover' } },
      ];
      for (const { call } of cases) void call();
      await flush();
      const frames = host.accessRequests();
      expect(frames).toHaveLength(cases.length);
      cases.forEach(({ label, fields }, i) => {
        const raw = frames[i]!;
        const frame = parsedRequest(raw);
        expect(raw, label).toEqual({ v: PROTOCOL_VERSION, instanceId: 'ins-1', type: FRAME_TYPES.accessRequest, requestId: frame.requestId, ...fields });
        expect(Object.keys(raw).sort(), label).toEqual(['instanceId', 'requestId', 'type', 'v', ...Object.keys(fields)].sort());
      });
    });

    it('each success hands back ONLY the seats the protocol defines for its op — a host’s extra seat never crosses', async () => {
      const api = fresh();
      const access = await connected(api);
      const cases: ReadonlyArray<{ call: () => Promise<unknown>; answer: Record<string, unknown>; result: Record<string, unknown> }> = [
        { call: () => access.request('p'), answer: { op: 'request', grant: VIEW, sourceAppId: 'ledger' }, result: { ok: true, grant: VIEW } },
        {
          call: () => access.query(GRANT_ID, 'SELECT 1'),
          answer: { op: 'query', columns: ['a'], rows: [[1]], truncated: true, totalRows: 812, sql: 'SELECT 1' },
          result: { ok: true, columns: ['a'], rows: [[1]], truncated: true, totalRows: 812 },
        },
        { call: () => access.query(GRANT_ID, 'SELECT 1'), answer: { op: 'query', columns: ['a'], rows: [] }, result: { ok: true, columns: ['a'], rows: [] } },
        {
          call: () => access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'),
          answer: { op: 'write', changes: 3, undoId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
          result: { ok: true, changes: 3 },
        },
        { call: () => access.refresh(GRANT_ID), answer: { op: 'refresh', fresh: true, summary: 'fetched 3 new rows' }, result: { ok: true, fresh: true } },
        { call: () => access.refresh(GRANT_ID), answer: { op: 'refresh', fresh: false, reason: 'recent' }, result: { ok: true, fresh: false, reason: 'recent' } },
        { call: () => access.list(), answer: { op: 'list', grants: [VIEW], total: 1 }, result: { ok: true, grants: [VIEW] } },
        { call: () => access.release(GRANT_ID), answer: { op: 'release', released: GRANT_ID }, result: { ok: true } },
        { call: () => access.discover(), answer: { op: 'discover', candidates: 'one', count: 1, names: ['Ledger'] }, result: { ok: true, candidates: 'one' } },
      ];
      const calls = cases.map(({ call }) => call());
      await flush();
      posted().forEach((frame, i) => host.accessSucceed(frame.requestId, cases[i]!.answer));
      const results = await Promise.all(calls);
      results.forEach((result, i) => {
        expect(result).toEqual(cases[i]!.result);
        expect(Object.keys(result as object).sort()).toEqual(Object.keys(cases[i]!.result).sort());
      });
      expect(accessPendingOf(api).size).toBe(0);
    });

    it('every call mints a FRESH requestId (a v4 UUID) — even two calls of the same op', async () => {
      const api = fresh();
      const access = await connected(api);
      for (const { call } of OPS) void call(access);
      for (const { call } of OPS) void call(access);
      await flush();
      const ids = posted().map((f) => f.requestId);
      expect(ids).toHaveLength(OPS.length * 2);
      expect(new Set(ids).size).toBe(OPS.length * 2);
      for (const id of ids) expect(id).toMatch(UUID_V4);
    });

    it('two calls in flight answered OUT OF ORDER each resolve with their own answer; answering one leaves the other pending', async () => {
      const api = fresh();
      const access = await connected(api);
      const first = access.query(GRANT_ID, 'SELECT amount FROM transactions');
      const second = access.query(OTHER_GRANT_ID, 'SELECT name FROM items');
      const firstState = track(first);
      const secondState = track(second);
      await flush();
      const [a, b] = posted();
      expect(a!.op === 'query' && a!.grantId).toBe(GRANT_ID);
      expect(b!.op === 'query' && b!.grantId).toBe(OTHER_GRANT_ID);
      expect(accessPendingOf(api).size).toBe(2);

      host.accessSucceed(b!.requestId, { op: 'query', columns: ['name'], rows: [['rice']] });
      await flush();
      expect(secondState.settled()).toBe(true);
      expect(firstState.settled()).toBe(false);
      expect(accessPendingOf(api).size).toBe(1);

      host.accessSucceed(a!.requestId, { op: 'query', columns: ['amount'], rows: [[12.5]] });
      await expect(first).resolves.toEqual({ ok: true, columns: ['amount'], rows: [[12.5]] });
      await expect(second).resolves.toEqual({ ok: true, columns: ['name'], rows: [['rice']] });
      expect(accessPendingOf(api).size).toBe(0);
    });

    it('an error response resolves { ok: false, error } for EVERY op — errors as data, never a rejection', async () => {
      const api = fresh();
      const access = await connected(api);
      const errors = [
        { code: 'ACCESS_DECLINED', message: 'not now', retryable: true },
        { code: 'ACCESS_REVOKED', message: 'access was stopped', retryable: false },
        { code: 'ACCESS_WRITE_REFUSED', message: 'the change was refused', retryable: false },
        { code: 'ACCESS_REFRESH_FAILED', message: 'the other app does not fetch on request', retryable: false },
        { code: 'ACCESS_RATE_LIMITED', message: 'too many reads', retryable: true },
        { code: 'ACCESS_NOT_GRANTED', message: 'no such access', retryable: false },
        { code: 'ACCESS_UNATTENDED', message: 'not while nobody is looking', retryable: true },
      ];
      const calls = OPS.map(({ call }) => call(access));
      await flush();
      posted().forEach((frame, i) => host.accessFail(frame.requestId, errors[i]!));
      await expect(Promise.all(calls)).resolves.toEqual(errors.map((error) => ({ ok: false, error })));
      expect(accessPendingOf(api).size).toBe(0);
    });

    it('a success for a DIFFERENT op answers the mismatch HOST_ERROR — for EVERY (asked, answered) pair; never a mis-shaped success, never a hang', async () => {
      const api = fresh();
      const access = await connected(api);
      const pairs = OPS.flatMap((asked) => OPS.filter((answered) => answered.op !== asked.op).map((answered) => ({ asked, answered })));
      expect(pairs).toHaveLength(42);
      const calls = pairs.map(({ asked }) => asked.call(access));
      await flush();
      const frames = posted();
      expect(frames.map((f) => f.op)).toEqual(pairs.map(({ asked }) => asked.op));
      frames.forEach((frame, i) => host.accessSucceed(frame.requestId, pairs[i]!.answered.answer));
      const results = await Promise.all(calls);
      results.forEach((result, i) => {
        const { asked, answered } = pairs[i]!;
        expect(result, `${answered.op} answered to ${asked.op}`).toEqual(hostError(`the host answered an access ${answered.op} to an access ${asked.op}`, false));
      });
      expect(accessPendingOf(api).size).toBe(0);
    });

    it('the matching op, answered with its seats, resolves ok for every op (the passing twin of the mismatch row)', async () => {
      const api = fresh();
      const access = await connected(api);
      const calls = OPS.map(({ call }) => call(access));
      await flush();
      posted().forEach((frame, i) => host.accessSucceed(frame.requestId, OPS[i]!.answer));
      await expect(Promise.all(calls)).resolves.toEqual(OPS.map(({ result }) => result));
    });

    it('before host-ready EVERY op resolves the retryable HOST_ERROR "not connected to host yet" — nothing posted, nothing pending', async () => {
      const api = fresh();
      const probe = await accessOf(api);
      const access = probe.result.current;
      expect(api.bridge.ready).toBe(false);
      const results = await Promise.all(OPS.map(({ call }) => call(access)));
      expect(results).toEqual(OPS.map(() => NOT_CONNECTED));
      await flush();
      expect(host.accessRequests()).toHaveLength(0);
      expect(accessPendingOf(api).size).toBe(0);
    });

    for (const [label, capabilities] of [
      ['absent (a 1.0 host)', CAPS_1_0],
      ['false (a host with no handler)', { ...CAPS_1_0, access: false }],
    ] as const) {
      it(`ready but access ${label}: EVERY op resolves the non-retryable "this host does not offer access between apps" — nothing posted, nothing pending`, async () => {
        const api = fresh();
        const access = await connected(api, capabilities);
        expect(api.bridge.ready).toBe(true);
        const results = await Promise.all(OPS.map(({ call }) => call(access)));
        expect(results).toEqual(OPS.map(() => NOT_OFFERED));
        await flush();
        expect(host.accessRequests()).toHaveLength(0);
        expect(accessPendingOf(api).size).toBe(0);
      });
    }

    it('a post the browser refuses (DataCloneError on an uncloneable param) RESOLVES "the access request could not be posted" and leaves nothing pending; the next cloneable call posts', async () => {
      const api = fresh();
      const access = await connected(api);
      cloneFaithfulPostMessage();
      const uncloneable = [() => 1];
      await expect(access.query(GRANT_ID, 'SELECT ?', uncloneable)).resolves.toEqual(NOT_POSTED);
      await expect(access.write(GRANT_ID, 'UPDATE t SET a = ?', uncloneable)).resolves.toEqual(NOT_POSTED);
      expect(accessPendingOf(api).size).toBe(0);
      await flush();
      expect(host.accessRequests()).toHaveLength(0);

      void access.list(); // the passing twin
      await flush();
      expect(host.accessRequests()).toHaveLength(1);
      expect(accessPendingOf(api).size).toBe(1);
    });

    it('a response is terminal exactly once: an unknown requestId is ignored, a second answer for an answered id changes nothing', async () => {
      const api = fresh();
      const access = await connected(api);
      const call = access.list();
      const state = track(call);
      await flush();
      const [{ requestId }] = posted() as [AccessRequestFrame];
      host.accessSucceed('not-a-pending-id', { op: 'list', grants: [VIEW] });
      await flush();
      expect(state.settled()).toBe(false);
      expect(accessPendingOf(api).size).toBe(1);
      host.accessSucceed(requestId, { op: 'list', grants: [] });
      host.accessFail(requestId, { code: 'ACCESS_REVOKED', message: 'too late', retryable: false });
      host.accessSucceed(requestId, { op: 'list', grants: [VIEW] });
      await flush();
      expect(state.value()).toEqual({ ok: true, grants: [] });
      expect(accessPendingOf(api).size).toBe(0);
    });

    it('discover admits ONLY the protocol’s three classes — none, one, several — and never answers another class as a success', async () => {
      const api = fresh();
      const access = await connected(api);
      expect([...ACCESS_CANDIDATE_CLASSES]).toEqual(['none', 'one', 'several']);
      const valid = ACCESS_CANDIDATE_CLASSES.map(() => access.discover());
      const invalid = track(access.discover());
      await flush();
      const frames = posted();
      ACCESS_CANDIDATE_CLASSES.forEach((candidates, i) => host.accessSucceed(frames[i]!.requestId, { op: 'discover', candidates }));
      host.accessSucceed(frames[3]!.requestId, { op: 'discover', candidates: 'many' });
      await flush();
      await expect(Promise.all(valid)).resolves.toEqual(ACCESS_CANDIDATE_CLASSES.map((candidates) => ({ ok: true, candidates })));
      // The forms differ on HOW (embedded: a HOST_ERROR, below; module: ignore and wait) — never a success.
      if (invalid.settled()) expect((invalid.value() as { ok?: unknown }).ok).toBe(false);
    });

    describe('the four hints — ids only, validated, each with its unsubscribe', () => {
      for (const { method, event, name } of GRANT_HINTS) {
        it(`${method} receives exactly { grantId } on "${name}" — extra keys dropped, a malformed seat and every other event ignored`, async () => {
          expect(event).toBe(name);
          const api = fresh();
          const probe = await accessOf(api);
          const seen: unknown[] = [];
          probe.result.current[method]((data) => seen.push(data));
          hostEvent(event, { grantId: GRANT_ID });
          hostEvent(event, { grantId: OTHER_GRANT_ID, rows: [[1]], changes: 3, sourceName: 'Ledger' });
          for (const malformed of [undefined, GRANT_ID, null, [GRANT_ID], { id: GRANT_ID }, { grantId: 7 }, { grantId: '' }, {}]) hostEvent(event, malformed);
          for (const other of [ACCESS_CHANGED_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT, 'schedule-run', 'theme-change']) {
            if (other !== event) hostEvent(other, { grantId: GRANT_ID, table: 'transactions' });
          }
          expect(seen).toEqual([{ grantId: GRANT_ID }, { grantId: OTHER_GRANT_ID }]);
        });

        it(`${method} works before host-ready, subscribes under "${name}", and its unsubscribe stops it and deletes the empty set`, async () => {
          const api = fresh();
          const probe = await accessOf(api);
          expect(api.bridge.ready).toBe(false);
          const seen: unknown[] = [];
          const off = probe.result.current[method]((data) => seen.push(data));
          expect(hostEventListenersOf(api).get(event)?.size).toBe(1);
          hostEvent(event, { grantId: GRANT_ID });
          off();
          expect(hostEventListenersOf(api).has(event)).toBe(false);
          hostEvent(event, { grantId: GRANT_ID });
          expect(seen).toEqual([{ grantId: GRANT_ID }]);
        });
      }

      it('onDataChanged receives exactly { table } — and {} when the host omits table; a table that is not a non-empty string and a non-record seat are dropped', async () => {
        const api = fresh();
        const probe = await accessOf(api);
        const seen: unknown[] = [];
        probe.result.current.onDataChanged((data) => seen.push(data));
        hostEvent(DATA_CHANGED_EVENT, { table: 'transactions' });
        hostEvent(DATA_CHANGED_EVENT, { table: 'transactions', rows: [[1]], changes: 3 });
        hostEvent(DATA_CHANGED_EVENT, {});
        hostEvent(DATA_CHANGED_EVENT, { other: 'transactions', grantId: GRANT_ID });
        for (const malformed of [{ table: 7 }, { table: '' }, { table: null }, undefined, 'transactions', null, ['transactions']]) hostEvent(DATA_CHANGED_EVENT, malformed);
        for (const other of [ACCESS_CHANGED_EVENT, ACCESS_SOURCE_CHANGED_EVENT, ACCESS_READ_EVENT]) hostEvent(other, { table: 'transactions' });
        expect(seen).toEqual([{ table: 'transactions' }, { table: 'transactions' }, {}, {}]);
        expect(seen[2]).not.toHaveProperty('table');
      });

      it('onDataChanged works before host-ready, subscribes under "data-changed", and its unsubscribe stops it and deletes the empty set', async () => {
        expect(DATA_CHANGED_EVENT).toBe('data-changed');
        const api = fresh();
        const probe = await accessOf(api);
        const seen: unknown[] = [];
        const off = probe.result.current.onDataChanged((data) => seen.push(data));
        expect(hostEventListenersOf(api).get(DATA_CHANGED_EVENT)?.size).toBe(1);
        hostEvent(DATA_CHANGED_EVENT, { table: 'transactions' });
        off();
        expect(hostEventListenersOf(api).has(DATA_CHANGED_EVENT)).toBe(false);
        hostEvent(DATA_CHANGED_EVENT, { table: 'transactions' });
        expect(seen).toEqual([{ table: 'transactions' }]);
      });
    });

    // D-PR6-2 (security S1): a sibling frame in the same document settles no call and rings no hint.
    describe('the source guard — a SIBLING frame settles nothing and rings nobody (D-PR6-2)', () => {
      it('an access hint from a sibling reaches no listener (all four) — the twins from window.parent do', async () => {
        const api = fresh();
        const probe = await accessOf(api);
        const seen: unknown[] = [];
        const access = probe.result.current;
        access.onChange((data) => seen.push(['onChange', data]));
        access.onSourceChanged((data) => seen.push(['onSourceChanged', data]));
        access.onRead((data) => seen.push(['onRead', data]));
        access.onDataChanged((data) => seen.push(['onDataChanged', data]));
        foreignEvent(ACCESS_CHANGED_EVENT, { grantId: GRANT_ID });
        foreignEvent(ACCESS_SOURCE_CHANGED_EVENT, { grantId: GRANT_ID });
        foreignEvent(ACCESS_READ_EVENT, { grantId: GRANT_ID });
        foreignEvent(DATA_CHANGED_EVENT, { table: 'transactions' });
        foreignEvent(DATA_CHANGED_EVENT, {});
        expect(seen).toEqual([]);
        hostEvent(ACCESS_CHANGED_EVENT, { grantId: GRANT_ID });
        hostEvent(ACCESS_SOURCE_CHANGED_EVENT, { grantId: GRANT_ID });
        hostEvent(ACCESS_READ_EVENT, { grantId: GRANT_ID });
        hostEvent(DATA_CHANGED_EVENT, { table: 'transactions' });
        expect(seen).toEqual([
          ['onChange', { grantId: GRANT_ID }],
          ['onSourceChanged', { grantId: GRANT_ID }],
          ['onRead', { grantId: GRANT_ID }],
          ['onDataChanged', { table: 'transactions' }],
        ]);
      });

      it('an access-response from a sibling carrying the LIVE requestId settles nothing — the real one still settles, once', async () => {
        const api = fresh();
        const access = await connected(api);
        const call = access.query(GRANT_ID, 'SELECT amount FROM transactions');
        const state = track(call);
        await flush();
        const [{ requestId }] = posted() as [AccessRequestFrame];
        host.foreign({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId, ok: true, op: 'query', columns: ['amount'], rows: [[999]] });
        host.foreign({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId, ok: false, error: { code: 'ACCESS_REVOKED', message: 'forged', retryable: false } });
        await flush();
        expect(state.settled()).toBe(false);
        expect(accessPendingOf(api).size).toBe(1);

        host.accessSucceed(requestId, { op: 'query', columns: ['amount'], rows: [[12.5]] }); // the positive twin
        await flush();
        expect(state.value()).toEqual({ ok: true, columns: ['amount'], rows: [[12.5]] });
        expect(accessPendingOf(api).size).toBe(0);
        host.accessSucceed(requestId, { op: 'query', columns: ['amount'], rows: [[1]] });
        await flush();
        expect(state.value()).toEqual({ ok: true, columns: ['amount'], rows: [[12.5]] });
      });
    });

    // D-PR6-4 — the EMBEDDED settler answers a host fault as data where the module's parser drops the
    // frame and waits (module-only twin rows: access.test.ts). Registered for the embedded form only.
    if (form === 'embedded') {
      describe('embedded only — a success frame the protocol would refuse is a HOST_ERROR, never a hang (D-PR6-4)', () => {
        it('a success with no result seat (or a seat of the wrong kind) answers "the host answered an access <op> without its result"', async () => {
          const api = fresh();
          const access = await connected(api);
          const cases: ReadonlyArray<{ op: OpName; call: () => Promise<unknown>; answer: Record<string, unknown> }> = [
            { op: 'request', call: () => access.request('p'), answer: { op: 'request' } },
            { op: 'request', call: () => access.request('p'), answer: { op: 'request', grant: 'grant-1' } },
            { op: 'query', call: () => access.query(GRANT_ID, 'SELECT 1'), answer: { op: 'query', columns: ['1'] } },
            { op: 'query', call: () => access.query(GRANT_ID, 'SELECT 1'), answer: { op: 'query', rows: [[1]] } },
            { op: 'write', call: () => access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'), answer: { op: 'write' } },
            { op: 'write', call: () => access.write(GRANT_ID, 'DELETE FROM t WHERE id = 1'), answer: { op: 'write', changes: '3' } },
            { op: 'refresh', call: () => access.refresh(GRANT_ID), answer: { op: 'refresh' } },
            { op: 'refresh', call: () => access.refresh(GRANT_ID), answer: { op: 'refresh', fresh: 'yes' } },
            { op: 'list', call: () => access.list(), answer: { op: 'list' } },
            { op: 'list', call: () => access.list(), answer: { op: 'list', grants: VIEW } },
            { op: 'discover', call: () => access.discover(), answer: { op: 'discover' } },
            { op: 'discover', call: () => access.discover(), answer: { op: 'discover', candidates: 'many' } },
          ];
          const calls = cases.map(({ call }) => call());
          await flush();
          posted().forEach((frame, i) => host.accessSucceed(frame.requestId, cases[i]!.answer));
          const results = await Promise.all(calls);
          results.forEach((result, i) => {
            expect(result, JSON.stringify(cases[i]!.answer)).toEqual(hostError(`the host answered an access ${cases[i]!.op} without its result`, false));
          });
          expect(accessPendingOf(api).size).toBe(0);
        });

        it('a success whose op is NOT a string answers "…without its result"; ok:false with no error object answers "…with no error"', async () => {
          const api = fresh();
          const access = await connected(api);
          const noOp = access.query(GRANT_ID, 'SELECT 1');
          const numberOp = access.list();
          const noError = access.query(GRANT_ID, 'SELECT 1');
          const stringError = access.release(GRANT_ID);
          await flush();
          const [a, b, c, d] = posted();
          host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: a!.requestId, ok: true, columns: ['1'], rows: [[1]] });
          host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: b!.requestId, ok: true, op: 5, grants: [] });
          host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: c!.requestId, ok: false });
          host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: d!.requestId, ok: false, error: 'nope' });
          await expect(noOp).resolves.toEqual(hostError('the host answered an access query without its result', false));
          await expect(numberOp).resolves.toEqual(hostError('the host answered an access list without its result', false));
          await expect(noError).resolves.toEqual(hostError('the host answered an access query with no error', false));
          await expect(stringError).resolves.toEqual(hostError('the host answered an access release with no error', false));
          expect(accessPendingOf(api).size).toBe(0);
        });
      });
    }
  });
}
