// The page's half of the loopback contract (ADR-0068 §1).
//
// Everything the local host process offers the page goes through here: the outbound fetch
// seam, the user file, the event stream, and status. It is the only module that knows the
// bearer, which arrives in the launch URL's fragment and lives in `sessionStorage` for this
// tab alone.

import type { FileBackendFs } from '@snugprotocol/db';

/** Where the token lives once the fragment has been stripped: this tab, this origin. */
const TOKEN_KEY = 'snug-host-token';

export interface LocalClient {
  /** The `fetchImpl` the platform seam hands to `connectedFetchDepsFor`. */
  fetchImpl(input: string, init?: RequestInit): Promise<Response>;
  fs: FileBackendFs;
  status(): Promise<LocalStatus>;
  /** Subscribe to the process's pushes. Returns an unsubscribe. */
  events(onEvent: (name: string, data: unknown) => void): () => void;
}

export interface LocalStatus {
  binding: string;
  port: number;
  pages: number;
  heldBy?: string;
  /**
   * What the user's own `claude` CLI can do, probed by the process at boot (D-B35).
   * ABSENT until the probe answers — the page must read that as "not known yet" rather
   * than as a claim either way.
   */
  brain?: { state: string; detail?: string };
}

/**
 * Read the token out of the fragment and REMOVE it from the address bar before anything
 * else runs — including the router, which reads `location.hash` when it first renders.
 * `replaceState` rather than `pushState` so no history entry keeps the token either.
 */
export function claimTokenFromFragment(win: {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}): string | undefined {
  const match = /[#&]token=([0-9a-f]{64})\b/.exec(win.location.hash);
  if (match?.[1] !== undefined) {
    try {
      win.sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      /* a tab that cannot remember still works for this load */
    }
    // Land on the app's own default route, not on a hash the router would try to match.
    win.history.replaceState(null, '', `${win.location.pathname}#/`);
    return match[1];
  }
  try {
    return win.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The envelope the process answers `/fetch` with. */
interface FetchEnvelope {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  bodyBase64?: string;
  code?: string;
  message?: string;
}

/** Statuses that MUST carry no body: constructing a Response with one throws. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Rebuild a `Response` the executor can run its gates against.
 *
 * Three things here are load-bearing rather than incidental:
 *  * a null-body status must be constructed with `null`, or `new Response` THROWS and a
 *    perfectly successful DELETE surfaces to the app as a transport failure;
 *  * a status outside 200–599 throws too, so it is clamped;
 *  * `statusText` outside the reason-phrase grammar throws, so it is dropped.
 */
export function responseFromEnvelope(envelope: FetchEnvelope): Response {
  const status = Math.min(599, Math.max(200, envelope.status ?? 200));
  const headers = new Headers();
  for (const [name, value] of envelope.headers ?? []) {
    try {
      headers.append(name, value);
    } catch {
      /* a header the browser forbids in a Response is not one the executor reads */
    }
  }
  // `BodyInit` wants an ArrayBuffer view spelled as a BufferSource; a bare Uint8Array
  // narrows differently under this TS lib. The bytes are identical either way.
  const decoded = NULL_BODY_STATUS.has(status) || envelope.bodyBase64 === undefined ? null : base64ToBytes(envelope.bodyBase64);
  const body: BodyInit | null = decoded === null ? null : (decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer);
  const init: ResponseInit = { status, headers };
  if (envelope.statusText !== undefined && /^[\t -~-ÿ]*$/.test(envelope.statusText)) {
    init.statusText = envelope.statusText;
  }
  return new Response(body, init);
}

/**
 * Serialize a request body for the wire. The executor always sends a string, but the OAuth
 * service sends `URLSearchParams` — and `JSON.stringify` of one yields `"{}"`, which would
 * make every token exchange and refresh a silently empty POST.
 */
export function serializeBody(body: BodyInit | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

export function createLocalClient(token: string): LocalClient {
  const auth = { authorization: `Bearer ${token}` };

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });

  return {
    async fetchImpl(input: string, init: RequestInit = {}): Promise<Response> {
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? {}).forEach((value, name) => {
        headers[name] = value;
      });
      const response = await call('/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input,
          method: init.method ?? 'GET',
          headers,
          body: serializeBody(init.body),
        }),
      });
      if (!response.ok) throw new Error(`the local Snug runner answered ${response.status}`);
      const envelope = (await response.json()) as FetchEnvelope;
      // A proxy refusal is thrown, so the executor names it exactly as it names any other
      // transport failure — its own gates having already run.
      if (!envelope.ok) throw new Error(envelope.message ?? envelope.code ?? 'the request was refused');
      return responseFromEnvelope(envelope);
    },

    fs: {
      async readFile(path: string): Promise<Uint8Array | undefined> {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const response = await call(`/userdb/${encodeURIComponent(name)}`);
        // 404 is absence and ONLY absence. Anything else must throw, or a transient failure
        // opens an empty database over the user's real file.
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`reading your file failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const response = await call(`/userdb/${encodeURIComponent(name)}`, { method: 'PUT', body: payload });
        if (!response.ok) throw new Error(`saving your file failed (${response.status})`);
      },
    },

    async status(): Promise<LocalStatus> {
      const response = await call('/status');
      if (!response.ok) throw new Error(`the runner answered ${response.status}`);
      return (await response.json()) as LocalStatus;
    },

    events(onEvent): () => void {
      const controller = new AbortController();
      void (async () => {
        try {
          // `fetch` rather than `EventSource`: EventSource cannot carry an Authorization
          // header, and the bearer rule has no exceptions.
          const response = await call('/events', { signal: controller.signal });
          const reader = response.body?.getReader();
          if (reader === undefined) return;
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split = buffer.indexOf('\n\n');
            while (split !== -1) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const name = /^event: (.+)$/m.exec(frame)?.[1];
              const data = /^data: (.*)$/m.exec(frame)?.[1];
              if (name !== undefined && data !== undefined) {
                try {
                  onEvent(name, JSON.parse(data));
                } catch {
                  /* a frame we cannot read is not a reason to drop the stream */
                }
              }
              split = buffer.indexOf('\n\n');
            }
          }
        } catch {
          /* the stream ends when the process goes away; the status chip says so */
        }
      })();
      return () => controller.abort();
    },
  };
}
