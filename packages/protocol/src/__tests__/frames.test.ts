import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  createResponder,
  hostReadySchema,
  parseFrame,
  type AppAnnounceFrame,
  type AppMessageFrame,
  type HostReadyFrame,
} from '../index.js';

const announce = (over: Record<string, unknown> = {}): unknown => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.announce,
  appId: 'chess-v1',
  displayName: 'Chess',
  description: 'Play chess against the host agent',
  iconEmoji: '♟️',
  iconColor: '#9891CE',
  ...over,
});

const appMessage = (over: Record<string, unknown> = {}): unknown => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.appMessage,
  requestId: 'req-8c1f2ab0',
  instanceId: 'ins-1',
  appId: 'chess-v1',
  action: 'player_move',
  payload: { from: 'e2', to: 'e4' },
  ...over,
});

describe('parseFrame — happy paths', () => {
  it('parses a valid announce frame', () => {
    const result = parseFrame(announce());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = result.frame as AppAnnounceFrame;
    expect(frame.type).toBe(FRAME_TYPES.announce);
    expect(frame.displayName).toBe('Chess');
  });

  it('parses host-ready with instanceId, protocolVersions, capabilities, theme', () => {
    const result = parseFrame({
      v: 1,
      type: FRAME_TYPES.hostReady,
      instanceId: 'ins-42',
      protocolVersions: [1],
      capabilities: { streaming: true, db: true, auth: false },
      theme: 'dark',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = result.frame as HostReadyFrame;
    expect(frame.instanceId).toBe('ins-42');
    expect(frame.capabilities.db).toBe(true);
    expect(frame.theme).toBe('dark');
  });

  it('parses app-message and preserves structured payload', () => {
    const result = parseFrame(appMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = result.frame as AppMessageFrame;
    expect(frame.payload).toEqual({ from: 'e2', to: 'e4' });
    expect(frame.requestId).toBe('req-8c1f2ab0');
    expect(frame.instanceId).toBe('ins-1');
  });

  it('parses app-cancel, db-request, db-response, host-event, app-event', () => {
    const frames: unknown[] = [
      { v: 1, type: FRAME_TYPES.appCancel, requestId: 'r1', instanceId: 'i1' },
      { v: 1, type: FRAME_TYPES.dbRequest, requestId: 'r2', instanceId: 'i1', op: 'exec', sql: 'select 1' },
      { v: 1, type: FRAME_TYPES.dbRequest, requestId: 'r3', instanceId: 'i1', op: 'kvSet', key: 'score', value: 42 },
      { v: 1, type: FRAME_TYPES.dbResponse, requestId: 'r2', ok: true, rows: [[1]] },
      { v: 1, type: FRAME_TYPES.hostEvent, event: 'theme-change', data: { theme: 'light' } },
      { v: 1, type: FRAME_TYPES.appEvent, event: 'resize', data: { height: 480 } },
    ];
    for (const f of frames) {
      const result = parseFrame(f);
      expect(result.ok, `frame ${JSON.stringify(f)} should parse`).toBe(true);
    }
  });

  it('parses all three app-response variants', () => {
    const streaming = parseFrame({ v: 1, type: FRAME_TYPES.appResponse, requestId: 'r', ok: true, streaming: true, text: 'thinking…', seq: 1 });
    const final = parseFrame({ v: 1, type: FRAME_TYPES.appResponse, requestId: 'r', ok: true, streaming: false, data: { message: 'Nc3' } });
    const err = parseFrame({
      v: 1, type: FRAME_TYPES.appResponse, requestId: 'r', ok: false,
      error: { code: ERROR_CODES.PARSE_FAILED, message: 'not json', rawExcerpt: 'x', attemptsRemaining: 2, retryable: true },
    });
    expect(streaming.ok && final.ok && err.ok).toBe(true);
  });

  // TASK-20261010-cross-app-access (AC1): the access pair joins the frame inventory (15 frames).
  // TASK-20261010-host-broker PR-3 (AC17, spec 1.2): + write/refresh/discover on each side (7 ops, 8 variants).
  it('parses snug:access-request (every op) and snug:access-response (every variant)', () => {
    const grantId = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
    const req = { v: 1, type: FRAME_TYPES.accessRequest, requestId: 'a1', instanceId: 'i1' } as const;
    const resp = { v: 1, type: FRAME_TYPES.accessResponse, requestId: 'a1' } as const;
    const grant = {
      id: grantId,
      access: 'read',
      source: { displayName: 'Ledger' },
      tables: [{ name: 'transactions', columns: ['amount'] }],
      duration: 'session',
      unattended: false,
    };
    const frames: unknown[] = [
      { ...req, op: 'request', purpose: 'to show spending by category', hints: { words: ['spending'], tables: ['transactions'] } },
      { ...req, op: 'query', grantId, sql: 'SELECT amount FROM transactions', params: [] },
      { ...req, op: 'list' },
      { ...req, op: 'release', grantId },
      { ...req, op: 'write', grantId, sql: 'UPDATE transactions SET amount = ? WHERE id = ?', params: [12.5, 7] },
      { ...req, op: 'refresh', grantId },
      { ...req, op: 'discover', hints: { words: ['spending'] } },
      { ...resp, ok: true, op: 'request', grant },
      { ...resp, ok: true, op: 'query', columns: ['amount'], rows: [[1]], truncated: false, totalRows: 1 },
      { ...resp, ok: true, op: 'list', grants: [grant] },
      { ...resp, ok: true, op: 'release' },
      { ...resp, ok: true, op: 'write', changes: 1 },
      { ...resp, ok: true, op: 'refresh', fresh: false, reason: 'recent' },
      { ...resp, ok: true, op: 'discover', candidates: 'several' },
      { ...resp, ok: false, error: { code: 'ACCESS_NOT_GRANTED', message: 'no such access', retryable: false } },
    ];
    for (const f of frames) {
      const result = parseFrame(f);
      expect(result.ok, `frame ${JSON.stringify(f)} should parse`).toBe(true);
    }
    // The request is strict (an unknown key is MALFORMED); the response is tolerant.
    const strict = parseFrame({ ...req, op: 'list', appId: 'evil' });
    expect(!strict.ok && !strict.ignored && strict.code).toBe('MALFORMED');
    expect(parseFrame({ ...resp, ok: true, op: 'release', future: 1 }).ok).toBe(true);
  });

  // TASK-20261010-host-broker PR-3 (AC17 negative; D-PR3-4/5): additive — a 1.1 app's frames are unchanged.
  it('PR-3: a 1.1-shaped access-request of every 1.1 op still parses; request.access is optional and only "read" | "write"', () => {
    const grantId = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
    const req = { v: 1, type: FRAME_TYPES.accessRequest, requestId: 'a1', instanceId: 'i1' } as const;
    for (const f of [
      { ...req, op: 'request', purpose: 'to show spending by category' },
      { ...req, op: 'request', purpose: 'to show spending by category', hints: { tables: ['transactions'] }, renew: grantId },
      { ...req, op: 'query', grantId, sql: 'SELECT amount FROM transactions' },
      { ...req, op: 'list' },
      { ...req, op: 'release', grantId },
    ]) {
      expect(parseFrame(f).ok, `frame ${JSON.stringify(f)} should parse`).toBe(true);
    }
    expect(parseFrame({ ...req, op: 'request', purpose: 'to fix categories', access: 'write' }).ok).toBe(true);
    const bad = parseFrame({ ...req, op: 'request', purpose: 'to fix categories', access: 'owner' });
    expect(!bad.ok && !bad.ignored && bad.code).toBe('MALFORMED');
  });

  it('PR-3: the access-response union stays tolerant — an unknown key on each new variant still parses; a wrong shape does not', () => {
    const resp = { v: 1, type: FRAME_TYPES.accessResponse, requestId: 'a1' } as const;
    for (const f of [
      { ...resp, ok: true, op: 'write', changes: 2, futureSeat: { a: 1 } },
      { ...resp, ok: true, op: 'refresh', fresh: true, futureSeat: 1 },
      { ...resp, ok: true, op: 'discover', candidates: 'none', futureSeat: 'x' },
    ]) {
      expect(parseFrame(f).ok, `frame ${JSON.stringify(f)} should parse`).toBe(true);
    }
    const wrong = parseFrame({ ...resp, ok: true, op: 'write', changes: 'two' });
    expect(!wrong.ok && !wrong.ignored && wrong.code).toBe('MALFORMED');
  });

  it('PR-3 (D-PR3-5): host-ready is UNCHANGED — capabilities has no accessOps key; a 1.2 app detects a 1.1 host by its MALFORMED answer', () => {
    expect(Object.keys(hostReadySchema.shape.capabilities.shape).sort()).toEqual(['access', 'auth', 'db', 'net', 'openUrl', 'streaming']);
    const result = parseFrame({
      v: 1,
      type: FRAME_TYPES.hostReady,
      instanceId: 'ins-1',
      protocolVersions: [1],
      capabilities: { streaming: true, db: true, auth: false, access: true, accessOps: ['write', 'refresh', 'discover'] },
      theme: 'light',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect('accessOps' in (result.frame as HostReadyFrame).capabilities).toBe(false);
  });

  it('parses host-ready without capabilities.access (a 1.0 frame) and with it', () => {
    const ready = (capabilities: Record<string, unknown>) =>
      parseFrame({ v: 1, type: FRAME_TYPES.hostReady, instanceId: 'ins-1', protocolVersions: [1], capabilities, theme: 'light' });
    const without = ready({ streaming: true, db: true, auth: false, net: true, openUrl: false });
    expect(without.ok).toBe(true);
    if (without.ok) expect((without.frame as HostReadyFrame).capabilities.access).toBeUndefined();
    const withAccess = ready({ streaming: true, db: true, auth: false, access: true });
    expect(withAccess.ok).toBe(true);
    if (withAccess.ok) expect((withAccess.frame as HostReadyFrame).capabilities.access).toBe(true);
    const bad = ready({ streaming: true, db: true, auth: false, access: 1 });
    expect(!bad.ok && !bad.ignored && bad.code).toBe('MALFORMED');
  });
});

describe('parseFrame — versioning (R1)', () => {
  it('rejects a frame with no v as UNSUPPORTED_VERSION', () => {
    const { v: _v, ...rest } = announce() as Record<string, unknown>;
    const result = parseFrame(rest);
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.UNSUPPORTED_VERSION });
  });

  it('rejects v: 2 as UNSUPPORTED_VERSION', () => {
    const result = parseFrame(announce({ v: 2 }));
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.UNSUPPORTED_VERSION });
  });
});

describe('parseFrame — unknown-type rule (R2)', () => {
  it('silently ignores an unknown snug:* frame type with valid v', () => {
    const result = parseFrame({ v: 1, type: 'snug:future-thing', anything: true });
    expect(result).toMatchObject({ ok: false, ignored: true });
  });

  it('ignores non-snug postMessage traffic (react devtools, ads, etc.)', () => {
    for (const junk of [{ source: 'react-devtools' }, 'hello', 42, null, undefined, []]) {
      expect(parseFrame(junk)).toMatchObject({ ok: false, ignored: true });
    }
  });

  it('ignores unknown fields on known frames (forward-compat)', () => {
    const result = parseFrame(announce({ futureField: { nested: true } }));
    expect(result.ok).toBe(true);
  });
});

describe('parseFrame — malformed known frames', () => {
  it('returns MALFORMED (not ignored, not thrown) for a known type failing validation', () => {
    const result = parseFrame(appMessage({ requestId: 42 }));
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED' });
  });

  it('enforces announce string caps (R6)', () => {
    const result = parseFrame(announce({ displayName: 'x'.repeat(LIMITS.DISPLAY_NAME_CHARS + 1) }));
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
});

describe('createResponder — terminal-frame guarantee (R3, AC-9)', () => {
  it('emits streaming frames then exactly one terminal frame', () => {
    const sent: unknown[] = [];
    const r = createResponder('req-1', (f) => sent.push(f));
    r.stream('He');
    r.stream('Hello');
    r.succeed({ message: 'Hello there' });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ ok: true, streaming: false });
    expect(r.isClosed).toBe(true);
  });

  it('refuses streaming or a second terminal after close', () => {
    const sent: unknown[] = [];
    const r = createResponder('req-1', (f) => sent.push(f));
    r.fail(ERROR_CODES.CANCELLED, 'superseded by req-2', { retryable: false });
    expect(() => r.stream('late')).toThrow();
    expect(() => r.succeed({})).toThrow();
    expect(sent).toHaveLength(1);
  });

  it('fail() produces a well-formed error frame with known code', () => {
    const sent: unknown[] = [];
    const r = createResponder('req-9', (f) => sent.push(f));
    r.fail(ERROR_CODES.THREAD_CONFLICT, 'busy', { retryable: true });
    const parsed = parseFrame(sent[0]);
    expect(parsed.ok).toBe(true);
  });
});
