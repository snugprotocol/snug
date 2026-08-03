// Hub-hosted origin (ADR-0009): the default SyncProvider, speaking plain conditional
// HTTP against `${baseUrl}/userdb` (server endpoints land in child 5; until then this
// is exercised against fetch fakes). Revisions are the server's etag values, passed
// through verbatim — `if-match` guards updates, `if-none-match: *` guards first
// provision, so a concurrent writer always surfaces as a conflict, never a clobber.
//
// secretsAllowed is false BY CONSTRUCTION (ADR-0008): BYOK keys never reach a hub
// server, so the loop strips `snug_secrets` from every hub push payload.
import {
  defaultFetch,
  fetchOrNetworkError,
  SYNC_ERROR_CODES,
  SyncProviderError,
  type FetchLike,
  type SyncProvider,
  type SyncPushResult,
} from './provider.js';

export interface CreateHubOriginProviderOptions {
  /** Hub API root, e.g. '/api' or 'https://hub.example/api' — '/userdb' is appended. */
  baseUrl: string;
  /** Injectable fetch (tests). Default: global fetch. */
  fetch?: FetchLike;
  /** Forwarded as `x-csrf-token` when the hub session uses CSRF double-submit. */
  csrfToken?: string;
}

/** Reads a conflict's remote revision: etag header first, JSON `revision` body second. */
async function conflictRevision(response: Response): Promise<string> {
  const etag = response.headers.get('etag');
  if (etag !== null && etag !== '') return etag;
  try {
    const body = (await response.json()) as { revision?: unknown };
    if (typeof body.revision === 'string') return body.revision;
  } catch {
    // fall through — a conflict without a readable revision is still a conflict
  }
  throw new SyncProviderError(
    SYNC_ERROR_CODES.BAD_RESPONSE,
    `hub reported a conflict (${response.status}) but no remote revision`,
    response.status,
  );
}

function throwHttpError(response: Response, doing: string): never {
  if (response.status === 401 || response.status === 403) {
    throw new SyncProviderError(SYNC_ERROR_CODES.AUTH, `hub rejected ${doing} (${response.status})`, response.status);
  }
  throw new SyncProviderError(SYNC_ERROR_CODES.HTTP, `hub ${doing} failed (${response.status})`, response.status);
}

export function createHubOriginProvider(options: CreateHubOriginProviderOptions): SyncProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const url = `${options.baseUrl}/userdb`;
  const csrfHeader: Record<string, string> =
    options.csrfToken !== undefined ? { 'x-csrf-token': options.csrfToken } : {};

  return {
    info: () => ({ kind: 'hub', secretsAllowed: false }),

    async pull() {
      const response = await fetchOrNetworkError(fetchImpl, url, {
        method: 'GET',
        credentials: 'include',
        headers: { ...csrfHeader },
      });
      if (response.status === 404 || response.status === 204) return undefined;
      if (!response.ok) throwHttpError(response, 'pull');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return undefined; // provisioned-but-empty counts as empty
      const revision = response.headers.get('etag');
      if (revision === null || revision === '') {
        throw new SyncProviderError(SYNC_ERROR_CODES.BAD_RESPONSE, 'hub pull response carried no etag revision', 200);
      }
      return { bytes, revision };
    },

    async push(bytes, baseRevision): Promise<SyncPushResult> {
      const response = await fetchOrNetworkError(fetchImpl, url, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'content-type': 'application/octet-stream',
          ...(baseRevision !== undefined ? { 'if-match': baseRevision } : { 'if-none-match': '*' }),
          ...csrfHeader,
        },
        body: bytes.slice(),
      });
      if (response.status === 409 || response.status === 412) {
        return { ok: false, conflict: true, remoteRevision: await conflictRevision(response) };
      }
      if (!response.ok) throwHttpError(response, 'push');
      const revision = response.headers.get('etag');
      if (revision === null || revision === '') {
        throw new SyncProviderError(
          SYNC_ERROR_CODES.BAD_RESPONSE,
          'hub push response carried no etag revision',
          response.status,
        );
      }
      return { ok: true, revision };
    },
  };
}
