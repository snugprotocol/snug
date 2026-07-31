// Inspector timeline reducer (task AC-4): frames in → rendered entries out, with
// STRUCTURAL payload summaries only — a marker smuggled through payload/state/text
// values must never surface in any entry.

import { FRAME_TYPES, PROTOCOL_VERSION, type Frame } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { initialInspectorState, inspectorReduce, type InspectorState } from '../run/inspector.js';

const MARKER = 'SECRET-PROMPT-TEXT-a8f3';

function feed(frames: Array<{ direction: 'inbound' | 'outbound'; frame: Frame }>): InspectorState {
  return frames.reduce((state, action) => inspectorReduce(state, action), initialInspectorState);
}

const announce: Frame = {
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.announce,
  appId: 'test-app',
  displayName: 'chess coach',
};

const appMessage: Frame = {
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.appMessage,
  requestId: 'req-1',
  instanceId: 'ins-1',
  appId: 'test-app',
  action: 'player_move',
  payload: { from: 'e2', to: 'e4', note: MARKER },
  state: { board: MARKER },
  responseSchema: { message: MARKER },
};

describe('inspectorReduce', () => {
  it('turns a scripted round-trip into ordered timeline entries', () => {
    const state = feed([
      { direction: 'inbound', frame: announce },
      { direction: 'inbound', frame: appMessage },
      {
        direction: 'outbound',
        frame: { v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId: 'req-1', ok: true, streaming: false, data: { move: 'e5', message: 'nice' } },
      },
    ]);
    expect(state.entries.map((entry) => entry.label)).toEqual(['announce', 'message · player_move', 'response']);
    expect(state.entries[1]?.detail).toContain('payload keys: from, to, note');
    expect(state.entries[1]?.detail).toContain('state ✓');
    expect(state.inFlight).toBe(0);
  });

  it('never renders payload/state/streamed VALUES — structural only', () => {
    const state = feed([
      { direction: 'inbound', frame: appMessage },
      {
        direction: 'outbound',
        frame: { v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId: 'req-1', ok: true, streaming: true, text: MARKER },
      },
      {
        direction: 'outbound',
        frame: { v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId: 'req-1', ok: false, error: { code: 'PARSE_FAILED', message: MARKER, retryable: true } },
      },
    ]);
    const rendered = JSON.stringify(state.entries);
    expect(rendered).not.toContain(MARKER);
  });

  it('tracks in-flight requests for the thinking pulse', () => {
    const afterSend = feed([{ direction: 'inbound', frame: appMessage }]);
    expect(afterSend.inFlight).toBe(1);
    const afterError = inspectorReduce(afterSend, {
      direction: 'outbound',
      frame: { v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId: 'req-1', ok: false, error: { code: 'HOST_ERROR', message: 'x', retryable: false } },
    });
    expect(afterError.inFlight).toBe(0);
    expect(afterError.entries.at(-1)?.isError).toBe(true);
  });

  it('collapses streaming progress into one updating entry', () => {
    const stream = (chars: number): Frame => ({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.appResponse,
      requestId: 'req-1',
      ok: true,
      streaming: true,
      text: 'x'.repeat(chars),
    });
    const state = feed([
      { direction: 'inbound', frame: appMessage },
      { direction: 'outbound', frame: stream(5) },
      { direction: 'outbound', frame: stream(40) },
    ]);
    const streamingEntries = state.entries.filter((entry) => entry.label === 'streaming');
    expect(streamingEntries).toHaveLength(1);
    expect(streamingEntries[0]?.detail).toBe('40 chars so far');
  });

  it('flags db activity for the export reveal', () => {
    const state = feed([
      {
        direction: 'inbound',
        frame: { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'req-db', instanceId: 'ins-1', op: 'kvSet', key: 'game', value: { secret: MARKER } },
      },
    ]);
    expect(state.sawDbOp).toBe(true);
    expect(JSON.stringify(state.entries)).not.toContain(MARKER);
    expect(state.entries[0]?.detail).toBe('key "game"');
  });
});
