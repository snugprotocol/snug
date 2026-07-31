// Test helpers: recorded-SSE fixtures over a fake fetch — no live network, ever.

export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

export function sseResponse(body: string | string[], init?: ResponseInit): Response {
  const chunks = Array.isArray(body) ? body : [body];
  return new Response(streamOf(...chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
  bodyJson: Record<string, unknown>;
  headers: Record<string, string>;
}

export function fakeFetch(
  factory: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: RecordedCall[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      calls.push({
        url,
        init,
        headers,
        bodyJson: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return factory(url, init);
    },
  };
}

/** SSE body builder: one `event:`/`data:` block. */
export function block(event: string | null, data: string): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${data}\n\n`;
}

export function abortErrorStream(signal: AbortSignal | null | undefined, ...leadingChunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of leadingChunks) controller.enqueue(encoder.encode(chunk));
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    },
  });
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
