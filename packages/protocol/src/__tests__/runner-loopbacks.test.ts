// Loop-back amendments from TASK-20260731-runner-sandbox (spec v0.1-draft amendment):
// 1. FrameParseResult failure variants recover a plausible `requestId` so hosts can
//    answer UNSUPPORTED_VERSION / MALFORMED on the wire instead of silently hanging apps.
// 2. db-request/db-response get their own size class (8 MiB) so a base64-encoded
//    5 MiB .sqlite artifact can round-trip through the db bridge.
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  frameWithinLimits,
  parseFrame,
  type DbResponseFrame,
  type Frame,
} from '../index.js';

describe('parseFrame — recoverable requestId on failures (R1 amendment)', () => {
  it('surfaces the requestId of a version-mismatched frame so the host can answer on the wire', () => {
    const result = parseFrame({
      v: 2,
      type: FRAME_TYPES.appMessage,
      requestId: 'req-future',
      instanceId: 'ins-1',
      appId: 'chess',
      action: 'move',
    });
    expect(result).toMatchObject({ ok: false, code: ERROR_CODES.UNSUPPORTED_VERSION, requestId: 'req-future' });
  });

  it('surfaces the requestId of a malformed known frame', () => {
    const result = parseFrame({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.appMessage,
      requestId: 'req-broken',
      instanceId: 'ins-1',
      appId: 'chess',
      action: 42, // wrong type — MALFORMED
    });
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED', requestId: 'req-broken' });
  });

  it('omits requestId when the raw value is not a plausible id (non-string, empty, oversized)', () => {
    for (const bad of [42, '', 'x'.repeat(LIMITS.ID_CHARS + 1), { nested: true }, null]) {
      const result = parseFrame({ v: 2, type: FRAME_TYPES.appMessage, requestId: bad });
      expect(result.ok).toBe(false);
      if (result.ok || result.ignored) throw new Error('expected a typed failure');
      expect(result.requestId).toBeUndefined();
    }
  });

  it('omits requestId when the frame never carried one', () => {
    const result = parseFrame({ v: 3, type: FRAME_TYPES.announce, appId: 'a', displayName: 'A' });
    expect(result.ok).toBe(false);
    if (result.ok || result.ignored) throw new Error('expected a typed failure');
    expect(result.requestId).toBeUndefined();
  });

  it('still ignores unknown snug:* types silently — no requestId recovery for R2 drops', () => {
    const result = parseFrame({ v: 1, type: 'snug:future-thing', requestId: 'req-1' });
    expect(result).toMatchObject({ ok: false, ignored: true });
  });
});

describe('frameWithinLimits — db size class (R6 amendment)', () => {
  const bigBase64 = 'A'.repeat(Math.ceil((LIMITS.MAX_ARTIFACT_BYTES * 4) / 3)); // base64 of a 5 MiB artifact

  it('defines MAX_DB_FRAME_BYTES = 8 MiB', () => {
    expect(LIMITS.MAX_DB_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it('accepts a db-response carrying a base64-encoded 5 MiB artifact', () => {
    const frame: DbResponseFrame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbResponse,
      requestId: 'r1',
      ok: true,
      bytesBase64: bigBase64,
    };
    expect(frameWithinLimits(frame)).toBe(true);
  });

  it('accepts a db-request import of the same artifact', () => {
    const frame: Frame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbRequest,
      requestId: 'r1',
      instanceId: 'i1',
      op: 'import',
      bytesBase64: bigBase64,
    };
    expect(frameWithinLimits(frame)).toBe(true);
  });

  it('rejects a db frame above 8 MiB', () => {
    const frame: DbResponseFrame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbResponse,
      requestId: 'r1',
      ok: true,
      bytesBase64: 'A'.repeat(LIMITS.MAX_DB_FRAME_BYTES + 1),
    };
    expect(frameWithinLimits(frame)).toBe(false);
  });

  it('keeps the standard 256 KiB cap for non-db frames', () => {
    const frame: Frame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.appResponse,
      requestId: 'r1',
      ok: true,
      streaming: false,
      data: { blob: 'A'.repeat(LIMITS.MAX_FRAME_BYTES) },
    };
    expect(frameWithinLimits(frame)).toBe(false);
  });

  it('a small frame of every type stays within limits', () => {
    const frames: Frame[] = [
      { v: 1, type: FRAME_TYPES.appMessage, requestId: 'r', instanceId: 'i', appId: 'a', action: 'go' },
      { v: 1, type: FRAME_TYPES.dbRequest, requestId: 'r', instanceId: 'i', op: 'export' },
      { v: 1, type: FRAME_TYPES.dbResponse, requestId: 'r', ok: true },
    ];
    for (const frame of frames) expect(frameWithinLimits(frame)).toBe(true);
  });
});
