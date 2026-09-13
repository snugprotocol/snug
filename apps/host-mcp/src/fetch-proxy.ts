// The network side of the executor (ADR-0068 §1) — Snug Desktop's `plugin-http` seam,
// written in Node.
//
// WHAT THIS IS NOT. It is not a second executor. The page's `connected-fetch.ts` remains
// THE seat that reads a credential and calls fetch, with all ten gates and its own suite;
// what arrives here is a request that has ALREADY passed them, with the credential already
// injected. Moving those gates into Node would duplicate C1's one seat.
//
// WHY THE GATES RUN AGAIN ANYWAY. Anything on this machine can open a loopback socket, so
// the far side of that socket cannot assume its caller is our page. These are the
// executor's own gates, re-run — deliberately NOT a superset: there is no resolved-address
// check, because the executor's gate 5 is literal-only (`net-guards.ts`) and resolution
// would be a new policy the desktop does not have either. The DNS-rebinding residual stays
// where the threat model already records it.
//
// TRANSIT-ONLY, NOT VALUE-BLIND. "Value-blind" is taken: `packages/runner` earns it with a
// source lint proving it never imports the credential layer at all. This module imports it
// on purpose and handles credential values because forwarding them is the job. What it
// promises instead is the desktop's promise: nothing is logged, persisted, echoed or
// retained, and every error message is scrubbed of the values it saw.

import { scrubAuthValues } from '@snugprotocol/auth/dist/scrub.js';
import { isForbiddenNetHost } from '@snugprotocol/auth/dist/net-guards.js';
import { LIMITS, isWhitelistedNetResponseHeader } from '@snugprotocol/protocol';

/**
 * Strictly greater than the executor's own 60s wall clock, so the executor's abort always
 * fires first and IT names the failure ("the provider did not answer within 60s"). At a tie
 * the winner is a scheduling race, and when this side wins, the page sees
 * `timeoutSignal.aborted === false` and hands the app a transport error instead — the
 * defect `next-steps.md` records for the LAN leg, in the other direction. This clock is a
 * backstop against a socket that hangs past the executor's own bound, nothing more.
 */
export const PROXY_TIMEOUT_MS = 75_000;

export interface ProxyRequest {
  url: string;
  method: string;
  /** Already injected by the executor. Forwarded verbatim; never logged. */
  headers: Record<string, string>;
  body?: string | undefined;
}

export type ProxyResult =
  | { ok: true; status: number; statusText: string; headers: Array<[string, string]>; bodyBase64: string }
  | { ok: false; code: 'NET_INVALID_REQUEST' | 'NET_SIZE_EXCEEDED' | 'NET_FETCH_FAILED'; message: string };

/** The transport seam, injected so unit tests open no sockets and the release build has no hook. */
export interface ProxyTransport {
  send(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | undefined },
    /** Return false to stop the read: the cap is enforced WHILE reading, never after. */
    onChunk: (chunk: Uint8Array) => boolean,
  ): Promise<{ status: number; statusText?: string; headers: Record<string, string | string[]>; aborted: boolean }>;
}

export interface FetchProxy {
  handle(request: ProxyRequest): Promise<ProxyResult>;
}

const refuse = (code: 'NET_INVALID_REQUEST' | 'NET_SIZE_EXCEEDED' | 'NET_FETCH_FAILED', message: string): ProxyResult => ({
  ok: false,
  code,
  message,
});

export function createFetchProxy(deps: { send: ProxyTransport['send']; timeoutMs?: number }): FetchProxy {
  const timeoutMs = deps.timeoutMs ?? PROXY_TIMEOUT_MS;

  return {
    async handle(request: ProxyRequest): Promise<ProxyResult> {
      // The scrub set: every injected value, so a message or body that reflects one back
      // is redacted before it can cross to the page and thence to the app.
      const scrubCandidates: Record<string, string> = { ...request.headers };

      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return refuse('NET_INVALID_REQUEST', 'the request URL is not a URL');
      }

      // https only. The LAN rungs are out of scope for this binding: the page carries
      // neither `lanFetch` nor `lanHttpPrivate`, so the executor's own named refusal is
      // the honest answer for a LAN row, and a plain-http rung here would be a policy
      // nobody consented to.
      if (url.protocol !== 'https:') {
        return refuse('NET_INVALID_REQUEST', `refusing ${url.protocol} — connected requests are https only`);
      }

      // The SSRF literal guard, IMPORTED. A second copy of that table drifts the day the
      // package learns a new spelling; the identity is pinned by test.
      if (isForbiddenNetHost(url.hostname)) {
        return refuse('NET_INVALID_REQUEST', 'refusing a private, loopback or link-local target');
      }

      const cap = LIMITS.MAX_NET_RESPONSE_BODY_BYTES;
      const chunks: Uint8Array[] = [];
      let total = 0;
      let overflow = false;

      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeout = new Promise<ProxyResult>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          // The bound that fires names itself (lesson 2026-08-18) — a transport's own
          // spelling reaches the user as noise pointing nowhere.
          resolve(refuse('NET_FETCH_FAILED', `the provider did not answer within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });

      const send = (async (): Promise<ProxyResult> => {
        let answer: Awaited<ReturnType<ProxyTransport['send']>>;
        try {
          answer = await deps.send(
            url.href,
            {
              method: request.method,
              headers: request.headers,
              ...(request.body !== undefined ? { body: request.body } : {}),
            },
            (chunk) => {
              total += chunk.byteLength;
              if (total > cap) {
                overflow = true;
                return false; // stop the read: the bytes must not accumulate
              }
              chunks.push(chunk);
              return true;
            },
          );
        } catch (error) {
          if (timedOut) return refuse('NET_FETCH_FAILED', `the provider did not answer within ${Math.round(timeoutMs / 1000)}s`);
          const message = error instanceof Error ? error.message : String(error);
          // Transport errors routinely embed the URL — query string included — and
          // sometimes the headers. Scrub before it crosses back.
          return refuse('NET_FETCH_FAILED', `request failed: ${scrubAuthValues(message, scrubCandidates)}`);
        }

        if (overflow) {
          // Every byte read is discarded: a partial body could hold a partially-scrubbed
          // credential reflection.
          chunks.length = 0;
          return refuse('NET_SIZE_EXCEEDED', `response exceeded the ${cap}-byte cap and was discarded`);
        }

        // A 3xx comes back as DATA. `node:https` follows nothing on its own, so this is a
        // statement about what we do NOT add — the executor refuses the redirect itself,
        // and a followed hop would carry the injected header off the frozen ceiling.
        const headers: Array<[string, string]> = [];
        for (const [name, raw] of Object.entries(answer.headers)) {
          const lower = name.toLowerCase();
          // Set-Cookie is dropped here and again in the page: a cookie the app never
          // asked for is state we would be handing it.
          if (lower === 'set-cookie' || lower === 'set-cookie2') continue;
          if (!isWhitelistedNetResponseHeader(lower)) continue;
          const value = Array.isArray(raw) ? raw.join(', ') : raw;
          headers.push([lower, scrubAuthValues(value, scrubCandidates)]);
        }

        const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const scrubbed = scrubAuthValues(body.toString('utf8'), scrubCandidates);
        return {
          ok: true,
          status: answer.status,
          statusText: answer.statusText ?? '',
          headers,
          bodyBase64: Buffer.from(scrubbed, 'utf8').toString('base64'),
        };
      })();

      try {
        return await Promise.race([send, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
