// Newline-delimited JSON-RPC over stdio — the spawn channel, hand-rolled (ADR-0068 §4).
//
// The precedent is `apps/whatsapp-sidecar/src/server.ts`, which hand-rolls HTTP over a unix
// socket for the same reason it applies here: the surface is five methods, and a
// general-purpose implementation would bring transports, auth and a dependency tree this
// process never uses onto a marketplace-scrutiny target. The official SDK stays a
// devDependency and drives this server as a client in the interop test, so the framing is
// proven against the reference implementation rather than against our own reading of it.

/**
 * The largest line we will buffer. A peer that never sends a newline must not be able to
 * grow our heap without bound; past this we drop the line and resynchronise at the next
 * newline rather than truncating (a truncated line would parse as a DIFFERENT message).
 */
export const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024;

export interface LineFramerOptions {
  /** Called when a line exceeded the cap and was discarded. */
  onOverflow?: (bytes: number) => void;
}

export interface LineFramer {
  push(chunk: Uint8Array): void;
}

/**
 * Split a byte stream into lines WITHOUT decoding chunk by chunk: a multi-byte character
 * that straddles a chunk boundary is mangled by a naive `chunk.toString()` per chunk, and
 * app display names and the instructions string are not ASCII. Bytes are joined first and
 * decoded per complete line.
 */
export function createLineFramer(onLine: (line: string) => void, options: LineFramerOptions = {}): LineFramer {
  let buffer = Buffer.alloc(0);
  // Set while discarding an over-long line: everything up to the next newline is refuse.
  let skipping = false;

  const emit = (bytes: Buffer): void => {
    const line = bytes.toString('utf8').replace(/\r$/, '');
    if (line.length > 0) onLine(line);
  };

  return {
    push(chunk: Uint8Array): void {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (skipping) {
          skipping = false; // resynchronised
          continue;
        }
        emit(line);
      }
      if (!skipping && buffer.byteLength > MAX_RPC_LINE_BYTES) {
        options.onOverflow?.(buffer.byteLength);
        buffer = Buffer.alloc(0);
        skipping = true;
      }
      if (skipping) buffer = Buffer.alloc(0);
    },
  };
}

export type RpcId = string | number;

export type ParsedRpc =
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'error'; code: number; id?: RpcId };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;

/**
 * One line to a message. A notification (no `id`) is returned as its own kind because the
 * distinction is load-bearing: answering a notification is a protocol violation, and a
 * client may drop the session over it.
 */
export function parseRpcMessage(line: string): ParsedRpc {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'error', code: PARSE_ERROR };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'error', code: INVALID_REQUEST };
  }
  const message = value as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof message.id === 'string' || typeof message.id === 'number';
  const id = hasId ? (message.id as RpcId) : undefined;
  if (typeof message.method !== 'string') {
    // Carry the id back when there was one: without it the caller's promise never settles.
    return id === undefined ? { kind: 'error', code: INVALID_REQUEST } : { kind: 'error', code: INVALID_REQUEST, id };
  }
  if (id === undefined) return { kind: 'notification', method: message.method, params: message.params };
  return { kind: 'request', id, method: message.method, params: message.params };
}
