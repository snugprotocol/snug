// The SyncProvider seam (ADR-0009): an origin is a replica the browser pushes the
// serialized user DB to and pulls it from. Providers are dumb byte stores with
// revision-checked writes — all merge/divergence policy lives in the sync loop, so a
// new origin (OneDrive, Drive, S3, …) only has to map pull/push onto its API.
//
// Error posture: an expected, policy-relevant outcome (revision conflict) is DATA in
// the push result; unexpected transport/server failures throw SyncProviderError, which
// the loop converts to error events at its boundary (errors-as-data where policy acts).

export interface SyncProviderInfo {
  /** Stable origin identifier ('hub', 'dropbox', …) — recorded in `snug_sync` config. */
  kind: string;
  /**
   * Whether push payloads may ever include `snug_secrets`. Hub origins are always
   * false (ADR-0008: BYOK keys are never sent to any hub server); personal origins
   * may be true, and even then including secrets stays an explicit user opt-in.
   */
  secretsAllowed: boolean;
}

export interface SyncPullResult {
  bytes: Uint8Array;
  /** Opaque origin revision (etag, Dropbox rev, …) — echoed back as `baseRevision`. */
  revision: string;
}

export type SyncPushResult =
  | { ok: true; revision: string }
  | {
      /** The origin moved past `baseRevision` — surfaced as divergence, never auto-resolved. */
      ok: false;
      conflict: true;
      /**
       * The revision the origin actually holds, when it can be named. ABSENT means the
       * origin refused the conditional write but could not name a revision — in practice
       * "the origin holds no image at all" (a hub whose row was wiped answers a bare 412
       * while our sidecar still remembers a revision). It is still a conflict: the write
       * did not land, and resolution stays an explicit user action either way.
       */
      remoteRevision?: string;
    };

export interface SyncProvider {
  info(): SyncProviderInfo;
  /** Resolves undefined when the origin holds no image yet (never provisioned). */
  pull(): Promise<SyncPullResult | undefined>;
  /**
   * Revision-checked write: with `baseRevision` the origin must still be at that
   * revision; without it the origin must be empty. Anything else is a conflict.
   */
  push(bytes: Uint8Array, baseRevision: string | undefined): Promise<SyncPushResult>;
}

export const SYNC_ERROR_CODES = {
  /** The transport itself failed (offline, DNS, CORS) — retryable on the next tick. */
  NETWORK: 'SYNC_NETWORK',
  /** The origin rejected our credentials (401/403, missing token). */
  AUTH: 'SYNC_AUTH',
  /** The origin answered with an unexpected HTTP status. */
  HTTP: 'SYNC_HTTP',
  /** The origin answered 2xx but the response was missing required data (e.g. no etag). */
  BAD_RESPONSE: 'SYNC_BAD_RESPONSE',
  /** An explicit pull was requested but the origin holds no image. */
  ORIGIN_EMPTY: 'SYNC_ORIGIN_EMPTY',
  /** Anything unexpected inside the loop itself. */
  INTERNAL: 'SYNC_INTERNAL',
} as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES];

export class SyncProviderError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    /** HTTP status when the error came from a response; undefined for transport failures. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncProviderError';
  }
}

/**
 * Injectable fetch seam shared by all HTTP providers: string URLs only, standard
 * RequestInit/Response. Tests inject fakes; production omits it for the global fetch.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Runs `fetch` and wraps transport-level rejections in a typed NETWORK error. */
export async function fetchOrNetworkError(fetchImpl: FetchLike, input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SyncProviderError(SYNC_ERROR_CODES.NETWORK, `sync request to ${input} failed: ${message}`);
  }
}
