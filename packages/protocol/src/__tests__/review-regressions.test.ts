// Regression suite for the Gate-5 adversarial review findings (TASK-20260731-protocol-core).
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  SNUG_APP_REQUEST_TAG,
  buildAppRequest,
  buildJsonSchemas,
  classifyErrorCode,
  createResponder,
  frameWithinLimits,
  isAppRequest,
  isKnownErrorCode,
  parseAgentReply,
  parseFrame,
  respondTo,
  scanForCredentialValues,
  type AppResponseFrame,
} from '../index.js';

describe('finding 1 — exported schemas must not forbid unknown fields (R2), except the stated strict set', () => {
  // R2's v0.3 exception: the net and open-url frames are STRICT by design — their fields
  // become real-world effects, so an unknown key is a rejection, and their published
  // schemas MUST carry additionalProperties: false. The tolerant core must still not.
  // (SPEC-1.0.md §2/§5 R2; publication flip: TASK-20260820-spec-v03-whitepaper.)
  const STRICT_SCHEMAS = new Set([
    'net-request.json',
    'net-response.json',
    'open-url-request.json',
    'open-url-result.json',
  ]);

  it('tolerant schemas never contain additionalProperties: false; strict schemas always do', () => {
    for (const [name, text] of Object.entries(buildJsonSchemas())) {
      if (STRICT_SCHEMAS.has(name)) {
        expect(text.includes('"additionalProperties": false'), `${name} must stay strict`).toBe(true);
      } else {
        expect(text.includes('"additionalProperties": false'), name).toBe(false);
      }
    }
  });
});

describe('finding 2 — prose quotes before the JSON must not poison extraction', () => {
  it.each([
    ['inch mark', 'Here is a 6" board layout: {"move":"Nc3","message":"ok"}'],
    ['quoted prose', 'She said "go for it: {"move":"Nc3","message":"ok"}'],
  ])('extracts JSON after %s', (_name, input) => {
    const r = parseAgentReply(input);
    expect(r).toMatchObject({ ok: true, data: { move: 'Nc3' } });
  });
});

describe('finding 3 — fail() output always validates (R3)', () => {
  it('clamps oversized rawExcerpt and empty code so the frame round-trips', () => {
    const sent: AppResponseFrame[] = [];
    const r = createResponder('req', (f) => sent.push(f));
    r.fail('', 'boom', { retryable: false, rawExcerpt: 'y'.repeat(1000) });
    const parsed = parseFrame(sent[0]);
    expect(parsed.ok).toBe(true);
    const frame = sent[0];
    if (frame.ok !== false) throw new Error('expected error frame');
    expect(frame.error.code).toBe(ERROR_CODES.HOST_ERROR);
    expect(frame.error.rawExcerpt).toHaveLength(LIMITS.RAW_EXCERPT_CHARS);
  });
});

describe('finding 4 — respondTo guarantees a terminal frame (AC-9)', () => {
  it('emits HOST_ERROR when the handler forgets to close', async () => {
    const sent: AppResponseFrame[] = [];
    await respondTo('req', (f) => sent.push(f), (r) => {
      r.stream('partial…');
    });
    expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR } });
  });

  it('emits HOST_ERROR when the handler throws mid-stream', async () => {
    const sent: AppResponseFrame[] = [];
    await respondTo('req', (f) => sent.push(f), (r) => {
      r.stream('a');
      throw new Error('adapter exploded');
    });
    expect(sent.at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, message: 'adapter exploded' } });
  });

  it('leaves a proper close alone', async () => {
    const sent: AppResponseFrame[] = [];
    await respondTo('req', (f) => sent.push(f), (r) => r.succeed({ message: 'done' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ok: true, streaming: false });
  });
});

describe('finding 5 — input cannot override the snug marker', () => {
  it('stamps snug: 1 even when the input smuggles snug: 2', () => {
    const wire = buildAppRequest({ ...( { snug: 2 } as object), appId: 'a', instanceId: 'i', requestId: 'r', action: 'x' } as never);
    expect(isAppRequest(wire)).toBe(true);
    expect(wire).toContain('"snug":1');
  });
});

describe('finding 6 — entropy-only hits under neutral keys are warnings, known prefixes reject', () => {
  it('compressed app state under a neutral key warns instead of rejecting', () => {
    const { rejects, warnings } = scanForCredentialValues({
      savedDrawing: 'H4sIAAAAAAAAA0vOzy0oSi0uTk1RSMwrLElNzMlPTVEEAF9kJx0aAAAAzz19QQxW',
    });
    expect(rejects).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('high-entropy under a credential-ish key still rejects', () => {
    const { rejects } = scanForCredentialValues({ apiKey: 'H4sIAAAAAAvQzOzy0oSi0uTk1RSMwrLE!lNzMlPTVEE9kJx0a' });
    expect(rejects.length).toBeGreaterThan(0);
  });

  it('known provider prefixes reject regardless of key name', () => {
    const { rejects } = scanForCredentialValues({ blob: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345' });
    expect(rejects.length).toBeGreaterThan(0);
  });
});

describe('finding 7 — frameWithinLimits enforces MAX_FRAME_BYTES', () => {
  const base = { v: PROTOCOL_VERSION, type: FRAME_TYPES.appMessage, requestId: 'r', instanceId: 'i', appId: 'a', action: 'go' } as const;

  it('accepts a normal frame and rejects an oversized payload', () => {
    expect(frameWithinLimits({ ...base, payload: { small: true } })).toBe(true);
    expect(frameWithinLimits({ ...base, payload: { blob: 'x'.repeat(LIMITS.MAX_FRAME_BYTES) } })).toBe(false);
  });

  it('returns false instead of throwing on unserializable frames', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(frameWithinLimits({ ...base, payload: cyclic })).toBe(false);
  });
});

describe('finding 8 — unknown error codes parse and classify as HOST_ERROR (R5)', () => {
  it('an app-response with a v1.1 code parses fine', () => {
    const parsed = parseFrame({
      v: 1, type: FRAME_TYPES.appResponse, requestId: 'r', ok: false,
      error: { code: 'RATE_LIMITED_V2', message: 'later', retryable: true },
    });
    expect(parsed.ok).toBe(true);
  });

  it('classifyErrorCode maps unknown → HOST_ERROR, known → itself', () => {
    expect(classifyErrorCode('RATE_LIMITED_V2')).toBe(ERROR_CODES.HOST_ERROR);
    expect(classifyErrorCode(ERROR_CODES.THREAD_CONFLICT)).toBe(ERROR_CODES.THREAD_CONFLICT);
    expect(isKnownErrorCode('nope')).toBe(false);
  });
});

describe('finding 10 — db frame per-op invariants', () => {
  const base = { v: 1, type: FRAME_TYPES.dbRequest, requestId: 'r', instanceId: 'i' };

  it('rejects exec without sql, kvSet without key, import without bytes', () => {
    for (const bad of [
      { ...base, op: 'exec' },
      { ...base, op: 'kvSet', value: 1 },
      { ...base, op: 'import' },
    ]) {
      expect(parseFrame(bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'MALFORMED' });
    }
  });

  it('rejects a db-response claiming ok:true with an error attached … as ok:false missing error', () => {
    const contradictory = { v: 1, type: FRAME_TYPES.dbResponse, requestId: 'r', ok: false };
    expect(parseFrame(contradictory)).toMatchObject({ ok: false, code: 'MALFORMED' });
  });
});

describe('finding 12 — MALFORMED diagnostics carry field paths', () => {
  it('names the offending field', () => {
    const result = parseFrame({ v: 1, type: FRAME_TYPES.announce, appId: 'a', displayName: 42 });
    if (result.ok || result.ignored) throw new Error('expected MALFORMED');
    expect(result.detail).toContain('displayName');
  });
});

describe('spec constant sanity', () => {
  it('the tag literal appears exactly once in source (constants.ts)', () => {
    expect(SNUG_APP_REQUEST_TAG).toBe('[SNUG_APP_REQUEST]');
  });
});
