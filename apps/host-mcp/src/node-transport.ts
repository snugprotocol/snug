// The real outbound transport for `fetch-proxy.ts` — `node:https`, nothing more.
//
// Kept in its own module for one reason: the release build must contain NO test hook
// (D-B11). The proxy takes its `send` as a parameter, the release entry passes this
// implementation, and the e2e's second build passes one that carries a `lookup` so a stub
// on 127.0.0.1 can answer for `stub.snug.test`. `check-host-mcp` sweeps the release bundle
// for the test entry's env name and the injection symbol, the desktop's `gate:release`
// transposed.
//
// Note what is NOT here: redirect following. `node:https` follows nothing on its own, which
// is exactly the posture the desktop spells as `maxRedirections: 0` — a followed hop would
// carry the executor's injected header to a host outside the frozen ceiling.

import { request as httpsRequest, type RequestOptions } from 'node:https';

export interface SendResult {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  aborted: boolean;
}

export type LookupFn = RequestOptions['lookup'];

/**
 * @param onChunk return false to stop the read — the cap is enforced WHILE reading, so an
 * oversize body is abandoned mid-flight rather than accumulated and then rejected.
 */
export function createNodeHttpsSend(lookup?: LookupFn) {
  return async function send(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | undefined },
    onChunk: (chunk: Uint8Array) => boolean,
  ): Promise<SendResult> {
    return new Promise<SendResult>((resolve, reject) => {
      const target = new URL(url);
      const request = httpsRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? 443 : target.port,
          path: `${target.pathname}${target.search}`,
          method: init.method,
          headers: init.headers,
          ...(lookup !== undefined ? { lookup } : {}),
        },
        (response) => {
          let aborted = false;
          response.on('data', (chunk: Buffer) => {
            if (aborted) return;
            if (!onChunk(new Uint8Array(chunk))) {
              aborted = true;
              // Tear the connection down: the point of a cap while reading is that the
              // remaining bytes never arrive.
              response.destroy();
              resolve({
                status: response.statusCode ?? 0,
                statusText: response.statusMessage ?? '',
                headers: response.headers as Record<string, string | string[]>,
                aborted: true,
              });
            }
          });
          response.on('end', () => {
            if (aborted) return;
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? '',
              headers: response.headers as Record<string, string | string[]>,
              aborted: false,
            });
          });
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };
}

/** The release implementation: no resolver, no hook. */
export const nodeHttpsSend = createNodeHttpsSend();
