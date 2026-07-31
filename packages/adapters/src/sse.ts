// sse.ts — tolerant SSE parsing shared by the provider adapters and createHttpTransport.
//
// Tolerance contract (ancestor pattern): comment lines (heartbeats) are skipped, unknown
// field names are ignored, and a malformed block never kills the stream — consumers skip
// it and move to the next blank-line-delimited block. Browser-safe: Web Streams only.

export interface SseEvent {
  /** The block's `event:` field; `'message'` when absent (SSE default). */
  event: string;
  /** The block's `data:` lines joined with newlines. */
  data: string;
}

/**
 * Parse a streaming SSE body into events. Malformed CONTENT never throws — only the
 * underlying stream erroring (network drop, abort) propagates, which callers map to
 * their own error codes. Early exit (break/return in a for-await) cancels the reader,
 * so events after a terminal block are never read (post-settle events ignored).
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<SseEvent, void, undefined> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null; // block without data — nothing to dispatch (tolerance)
    }
    const event: SseEvent = { event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
    return event;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          const event = flush();
          if (event !== null) yield event;
          continue;
        }
        if (line.startsWith(':')) continue; // comment — heartbeats land here
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value_ = colon === -1 ? '' : line.slice(colon + 1);
        if (value_.startsWith(' ')) value_ = value_.slice(1);
        if (field === 'event') eventName = value_;
        else if (field === 'data') dataLines.push(value_);
        // id/retry/unknown fields ignored — tolerance contract
      }
      if (done) break;
    }
    const event = flush(); // stream may end without a trailing blank line
    if (event !== null) yield event;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already errored/closed — nothing to release */
    }
  }
}

/**
 * Parse an SSE data payload as a JSON object; `null` for anything else (malformed JSON,
 * arrays, primitives). The shared "one malformed block never kills the stream" primitive.
 */
export function tryParseJsonRecord(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return null;
}
