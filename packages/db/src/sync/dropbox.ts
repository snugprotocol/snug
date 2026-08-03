// Dropbox origin (ADR-0009): the example third-party SyncProvider, talking raw Dropbox
// HTTP API v2 (no SDK dependency — providers must stay browser-runnable and lean).
// Revisions are Dropbox file `rev` values; `mode: update` makes the write revision-
// checked, `mode: add` (first push) fails on any existing file — never a clobber.
//
// secretsAllowed is true: a personal origin is the user's own storage, so full-
// portability images (BYOK keys included) are allowed — still an explicit user opt-in
// enforced by the loop, and the OAuth token itself lives in `snug_secrets` (ADR-0008
// posture), injected here via getToken.
import {
  defaultFetch,
  fetchOrNetworkError,
  SYNC_ERROR_CODES,
  SyncProviderError,
  type FetchLike,
  type SyncProvider,
  type SyncPushResult,
} from './provider.js';

export const DROPBOX_DEFAULT_PATH = '/snug/user.sqlite';

const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const GET_METADATA_URL = 'https://api.dropboxapi.com/2/files/get_metadata';
const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

export interface CreateDropboxProviderOptions {
  /** Access token, read from `snug_secrets` at call time (never captured at setup). */
  getToken: () => string | undefined | Promise<string | undefined>;
  /** Injectable fetch (tests). Default: global fetch. */
  fetch?: FetchLike;
  /** File path inside the app folder / user Dropbox. Default: DROPBOX_DEFAULT_PATH. */
  path?: string;
}

/** Dropbox reports API errors as 409 with a union body; classify the ones we act on. */
async function classify409(response: Response): Promise<'not-found' | 'conflict' | 'other'> {
  try {
    const body = (await response.json()) as { error_summary?: unknown };
    const summary = typeof body.error_summary === 'string' ? body.error_summary : '';
    if (summary.includes('not_found')) return 'not-found';
    if (summary.includes('conflict')) return 'conflict';
  } catch {
    // unreadable body — treat as an unexpected error below
  }
  return 'other';
}

function throwHttpError(response: Response, doing: string): never {
  if (response.status === 401 || response.status === 403) {
    throw new SyncProviderError(
      SYNC_ERROR_CODES.AUTH,
      `dropbox rejected ${doing} (${response.status})`,
      response.status,
    );
  }
  throw new SyncProviderError(SYNC_ERROR_CODES.HTTP, `dropbox ${doing} failed (${response.status})`, response.status);
}

export function createDropboxProvider(options: CreateDropboxProviderOptions): SyncProvider {
  const fetchImpl = options.fetch ?? defaultFetch;
  const path = options.path ?? DROPBOX_DEFAULT_PATH;

  const authHeader = async (): Promise<string> => {
    const token = await options.getToken();
    if (token === undefined || token === '') {
      throw new SyncProviderError(SYNC_ERROR_CODES.AUTH, 'no dropbox token — connect Dropbox first');
    }
    return `Bearer ${token}`;
  };

  /** Current remote rev for conflict results (the conflict response itself has none). */
  const remoteRevision = async (authorization: string): Promise<string> => {
    try {
      const response = await fetchOrNetworkError(fetchImpl, GET_METADATA_URL, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) return 'unknown';
      const body = (await response.json()) as { rev?: unknown };
      return typeof body.rev === 'string' ? body.rev : 'unknown';
    } catch {
      return 'unknown'; // a conflict without a resolvable revision is still a conflict
    }
  };

  return {
    info: () => ({ kind: 'dropbox', secretsAllowed: true }),

    async pull() {
      const authorization = await authHeader();
      const response = await fetchOrNetworkError(fetchImpl, DOWNLOAD_URL, {
        method: 'POST',
        headers: { authorization, 'dropbox-api-arg': JSON.stringify({ path }) },
      });
      if (response.status === 409) {
        if ((await classify409(response)) === 'not-found') return undefined;
        throw new SyncProviderError(SYNC_ERROR_CODES.HTTP, 'dropbox pull failed (409)', 409);
      }
      if (!response.ok) throwHttpError(response, 'pull');
      const metaHeader = response.headers.get('dropbox-api-result');
      let rev: unknown;
      try {
        rev = metaHeader === null ? undefined : (JSON.parse(metaHeader) as { rev?: unknown }).rev;
      } catch {
        rev = undefined;
      }
      if (typeof rev !== 'string') {
        throw new SyncProviderError(SYNC_ERROR_CODES.BAD_RESPONSE, 'dropbox download carried no rev metadata', 200);
      }
      return { bytes: new Uint8Array(await response.arrayBuffer()), revision: rev };
    },

    async push(bytes, baseRevision): Promise<SyncPushResult> {
      const authorization = await authHeader();
      const arg = {
        path,
        mode: baseRevision === undefined ? 'add' : { '.tag': 'update', update: baseRevision },
        autorename: false,
        mute: true,
      };
      const response = await fetchOrNetworkError(fetchImpl, UPLOAD_URL, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/octet-stream',
          'dropbox-api-arg': JSON.stringify(arg),
        },
        body: bytes.slice(),
      });
      if (response.status === 409) {
        const kind = await classify409(response);
        // `mode: add` racing an existing file also surfaces as a path conflict
        if (kind === 'conflict' || kind === 'not-found') {
          return { ok: false, conflict: true, remoteRevision: await remoteRevision(authorization) };
        }
        throw new SyncProviderError(SYNC_ERROR_CODES.HTTP, 'dropbox push failed (409)', 409);
      }
      if (!response.ok) throwHttpError(response, 'push');
      const body = (await response.json()) as { rev?: unknown };
      if (typeof body.rev !== 'string') {
        throw new SyncProviderError(SYNC_ERROR_CODES.BAD_RESPONSE, 'dropbox upload response carried no rev', 200);
      }
      return { ok: true, revision: body.rev };
    },
  };
}

// ------------------------------------------------------------------- PKCE (no SDK)
// Public-client OAuth: the browser never holds a client secret; possession of the
// code_verifier is the proof. Both helpers are pure fetch/URL so the hub client can
// run the whole flow without a Dropbox SDK dependency.

export interface BuildDropboxAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  /** S256 challenge derived from the stored code verifier. */
  codeChallenge: string;
}

export function buildDropboxAuthUrl(options: BuildDropboxAuthUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('token_access_type', 'offline'); // long-lived origin: ask for a refresh token
  return url.toString();
}

export interface ExchangeDropboxCodeOptions {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  /** Injectable fetch (tests). Default: global fetch. */
  fetch?: FetchLike;
}

export interface DropboxTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

export async function exchangeDropboxCode(options: ExchangeDropboxCodeOptions): Promise<DropboxTokenResponse> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
  const response = await fetchOrNetworkError(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SyncProviderError(
      SYNC_ERROR_CODES.AUTH,
      `dropbox code exchange failed (${response.status})${detail !== '' ? `: ${detail}` : ''}`,
      response.status,
    );
  }
  const parsed = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  if (typeof parsed.access_token !== 'string') {
    throw new SyncProviderError(SYNC_ERROR_CODES.BAD_RESPONSE, 'dropbox token response carried no access_token', 200);
  }
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === 'string' ? { refreshToken: parsed.refresh_token } : {}),
    ...(typeof parsed.expires_in === 'number' ? { expiresIn: parsed.expires_in } : {}),
    ...(typeof parsed.token_type === 'string' ? { tokenType: parsed.token_type } : {}),
  };
}
