import { describe, expect, it } from 'vitest';
import {
  SNUG_APP_REQUEST_TAG,
  buildAppRequest,
  isAppRequest,
  parseAppRequest,
} from '../index.js';

const env = {
  appId: 'chess-v1',
  instanceId: 'ins-1',
  requestId: 'req-1',
  action: 'player_move',
  payload: { from: 'e2', to: 'e4' },
  state: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  responseSchema: { move: 'string', message: 'string' },
};

describe('buildAppRequest / parseAppRequest round-trip', () => {
  it('round-trips a full envelope through the tagged string form', () => {
    const wire = buildAppRequest(env);
    expect(wire.startsWith(`${SNUG_APP_REQUEST_TAG}\n`)).toBe(true);
    const parsed = parseAppRequest(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.appId).toBe('chess-v1');
    expect(parsed.envelope.payload).toEqual({ from: 'e2', to: 'e4' });
    expect(parsed.envelope.snug).toBe(1);
  });

  it('stamps the snug: 1 marker automatically', () => {
    const wire = buildAppRequest(env);
    const body = JSON.parse(wire.slice(wire.indexOf('\n') + 1)) as Record<string, unknown>;
    expect(body.snug).toBe(1);
  });
});

describe('isAppRequest detection (R4/AC-4)', () => {
  it('detects a tagged message', () => {
    expect(isAppRequest(buildAppRequest(env))).toBe(true);
  });

  it('rejects ordinary chat text, even mentioning the tag inline', () => {
    expect(isAppRequest('hello world')).toBe(false);
    expect(isAppRequest(`what does ${SNUG_APP_REQUEST_TAG} mean?`)).toBe(false);
  });

  it('rejects a tagged body without the snug: 1 marker', () => {
    const impostor = `${SNUG_APP_REQUEST_TAG}\n${JSON.stringify({ appId: 'x', requestId: 'r', action: 'a' })}`;
    expect(isAppRequest(impostor)).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isAppRequest(undefined as unknown as string)).toBe(false);
    expect(isAppRequest(42 as unknown as string)).toBe(false);
  });
});

describe('parseAppRequest — total parser', () => {
  it('returns typed failure on truncated JSON', () => {
    const wire = buildAppRequest(env).slice(0, 40);
    const parsed = parseAppRequest(wire);
    expect(parsed.ok).toBe(false);
  });

  it('returns typed failure on scalar/array/null bodies', () => {
    for (const body of ['null', '42', '[1,2]', '"str"']) {
      const parsed = parseAppRequest(`${SNUG_APP_REQUEST_TAG}\n${body}`);
      expect(parsed.ok, `body ${body}`).toBe(false);
    }
  });

  it('ignores unknown fields (forward-compat)', () => {
    const wire = `${SNUG_APP_REQUEST_TAG}\n${JSON.stringify({ snug: 1, ...env, futureField: 1 })}`;
    const parsed = parseAppRequest(wire);
    expect(parsed.ok).toBe(true);
  });

  it('requires appId, instanceId, requestId, action', () => {
    const { action: _a, ...missing } = env;
    const wire = `${SNUG_APP_REQUEST_TAG}\n${JSON.stringify({ snug: 1, ...missing })}`;
    expect(parseAppRequest(wire).ok).toBe(false);
  });
});
