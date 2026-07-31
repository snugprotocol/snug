// inspector.ts — the "watch it think" timeline reducer. Fed by the runner's onFrame
// observation hook (every accepted inbound frame, every posted outbound frame).
//
// STRUCTURAL ONLY (task AC-4): entries describe frame shape — types, actions, key
// NAMES, sizes, codes — never payload VALUES, streamed text, or anything that could
// carry prompt content. A unit test feeds marker text through payloads and asserts
// it never appears in the rendered entries.

import { FRAME_TYPES, type Frame } from '@snugprotocol/protocol';
import type { FrameDirection } from '@snugprotocol/runner';

export interface InspectorEntry {
  id: number;
  at: number;
  direction: FrameDirection;
  label: string;
  detail: string;
  isError: boolean;
  /** Streaming entries update in place instead of appending (progress, not spam). */
  streamKey?: string;
}

export interface InspectorState {
  entries: InspectorEntry[];
  /** App requests awaiting a terminal response — drives the thinking border pulse. */
  inFlight: number;
  /** True once any db op was observed — reveals the .sqlite export affordance. */
  sawDbOp: boolean;
  nextId: number;
}

export const initialInspectorState: InspectorState = { entries: [], inFlight: 0, sawDbOp: false, nextId: 1 };

const MAX_ENTRIES = 200;

function keyNames(value: unknown): string {
  if (value === null || typeof value !== 'object') return typeof value;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 0 ? 'empty' : keys.slice(0, 6).join(', ') + (keys.length > 6 ? ', …' : '');
}

interface Summary {
  label: string;
  detail: string;
  isError?: boolean;
  streamKey?: string;
  deltaInFlight?: number;
  dbOp?: boolean;
}

function summarize(frame: Frame): Summary {
  switch (frame.type) {
    case FRAME_TYPES.announce:
      return { label: 'announce', detail: `app "${frame.displayName}"` };
    case FRAME_TYPES.hostReady:
      return { label: 'ready', detail: `streaming${'db' in frame.capabilities && frame.capabilities.db ? ' + db' : ''} · theme ${frame.theme}` };
    case FRAME_TYPES.appMessage:
      return {
        label: `message · ${frame.action}`,
        detail: `payload keys: ${keyNames(frame.payload)} · state ${frame.state !== undefined ? '✓' : '–'} · schema ${frame.responseSchema !== undefined ? '✓' : '–'}`,
        deltaInFlight: 1,
      };
    case FRAME_TYPES.appResponse: {
      if (frame.ok) {
        if (frame.streaming) {
          return {
            label: 'streaming',
            detail: `${typeof frame.text === 'string' ? frame.text.length : 0} chars so far`,
            streamKey: frame.requestId,
          };
        }
        return { label: 'response', detail: `data keys: ${keyNames(frame.data)}`, deltaInFlight: -1 };
      }
      return { label: `error · ${frame.error.code}`, detail: frame.error.retryable ? 'retryable' : 'terminal', isError: true, deltaInFlight: -1 };
    }
    case FRAME_TYPES.appCancel:
      return { label: 'cancel', detail: `request ${frame.requestId.slice(0, 8)}…`, deltaInFlight: -1 };
    case FRAME_TYPES.dbRequest: {
      const detail =
        frame.op === 'exec'
          ? `sql · ${frame.sql.length} chars`
          : frame.op === 'kvGet' || frame.op === 'kvSet'
            ? `key "${frame.key}"`
            : frame.op;
      return { label: `db · ${frame.op}`, detail, dbOp: true };
    }
    case FRAME_TYPES.dbResponse:
      return frame.ok
        ? { label: 'db · ok', detail: frame.rows !== undefined ? `${frame.rows.length} rows` : 'done', dbOp: true }
        : { label: `db · ${frame.error.code}`, detail: frame.error.retryable ? 'retryable' : 'terminal', isError: true, dbOp: true };
    case FRAME_TYPES.hostEvent:
      return { label: `host event · ${frame.event}`, detail: '' };
    case FRAME_TYPES.appEvent:
      return { label: `app event · ${frame.event}`, detail: '' };
    default:
      return { label: 'frame', detail: '' };
  }
}

export function inspectorReduce(
  state: InspectorState,
  action: { direction: FrameDirection; frame: Frame; at?: number },
): InspectorState {
  const summary = summarize(action.frame);
  const at = action.at ?? Date.now();
  const inFlight = Math.max(0, state.inFlight + (summary.deltaInFlight ?? 0));
  const sawDbOp = state.sawDbOp || summary.dbOp === true;

  // Streaming progress updates the existing entry for its request in place.
  if (summary.streamKey !== undefined) {
    const index = state.entries.findIndex((entry) => entry.streamKey === summary.streamKey);
    if (index !== -1) {
      const entries = state.entries.slice();
      const existing = entries[index] as InspectorEntry;
      entries[index] = { ...existing, detail: summary.detail, at };
      return { ...state, entries, inFlight, sawDbOp };
    }
  }

  const entry: InspectorEntry = {
    id: state.nextId,
    at,
    direction: action.direction,
    label: summary.label,
    detail: summary.detail,
    isError: summary.isError === true,
    ...(summary.streamKey !== undefined ? { streamKey: summary.streamKey } : {}),
  };
  const entries = [...state.entries, entry].slice(-MAX_ENTRIES);
  return { entries, inFlight, sawDbOp, nextId: state.nextId + 1 };
}
