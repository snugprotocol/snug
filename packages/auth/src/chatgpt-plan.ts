/**
 * "Use my ChatGPT plan" — the session contracts (TASK-20261023-siwc-chatgpt-plan, ADR-0078).
 *
 * L0 of the task: the TYPES every lane builds against — the per-machine session file the Rust
 * side keeps (D2), the store seat the shell implements over `chatgpt_session_read|write|clear`,
 * the sign-in's own loopback seat (D10), the keeper's API and its named failures (D5). The
 * keeper itself (`createChatgptPlanSession`: PKCE sign-in with dynamic registration, the ID
 * token checks, the single-flight rotation-safe refresh, revocation, the model list) is L1 and
 * lands in this file behind these types, tests first.
 *
 * Custody in one sentence (ADR-0078 §2): the tokens are a rotating, per-host credential, so
 * they live beside the user file in a `0600` file the shell owns — never in `snug_secrets`,
 * never in an export, a sync push, a share or a URL — and the keeper holds no long-lived token
 * in memory: every use reads the file inside one serial queue.
 *
 * DI-pure and browser-safe like the rest of this package: no tauri, no node, WebCrypto only.
 */

import type { CallbackDelivery, CallbackErrorDelivery } from './oauth-service.js';

// ------------------------------------------------------------------ the session file (D2)

/**
 * One model the plan offers, in OpenAI's own vocabulary (ADR-0070 §3/§4 — never a mapping,
 * never a hardcoded list): `slug` → `id`, `display_name` → `name`,
 * `supported_reasoning_levels` → `efforts` (empty = no level axis, so no control is offered —
 * the Haiku rule), `default_reasoning_level` → `defaultEffort` (what an unattended step runs on).
 * Mirrors the platform's `BrainModelOption` shape on purpose.
 */
export interface ChatgptModel {
  id: string;
  name: string;
  efforts: readonly string[];
  defaultEffort?: string;
}

/**
 * The token set, replaced TOGETHER and atomically on every refresh (AC5): the refresh token
 * rotates, so a partial write would lose the only valid one. Instants are epoch milliseconds.
 * `earliestRefreshAt` is OpenAI's undocumented floor — respected for a proactive refresh,
 * advisory for a forced one (D4).
 */
export interface ChatgptSessionTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: readonly string[];
}

/** The verified account identity from the ID token — what the chip shows (R-131: the email is the user's check). */
export interface ChatgptSessionAccount {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * The whole per-machine file. `hostId` is minted once per machine (`urn:uuid:…`) and
 * `clientId` is the `oaiapp_…` client OpenAI issued against it — the REGISTRATION, kept across
 * sign-outs so the next sign-in reuses it (AC9), dropped only by "forget this registration".
 * `tokens` and `account` exist only while signed in. `planGranted` is REQUIRED because a grant
 * without `chatgpt.tokens.use.direct` is a real, named state (signed in, plan not granted — AC3),
 * not an absence. `models` is the cached list (per machine, like ADR-0070 §5 brain facts).
 */
export interface ChatgptSessionFile {
  v: 1;
  hostId: string;
  clientId?: string;
  tokens?: ChatgptSessionTokens;
  account?: ChatgptSessionAccount;
  planGranted: boolean;
  models?: { fetchedAt: number; list: ChatgptModel[] };
}

/**
 * The custody seat the shell implements (D2): whole-file read / write / clear over the three
 * Rust commands. No field-level API on purpose — every mutation is a read-modify-write of the
 * whole file inside the keeper's serial queue, so a model-cache update can never write a stale
 * refresh token back. `read` answers `undefined` when no file exists.
 */
export interface ChatgptSessionStore {
  read(): Promise<ChatgptSessionFile | undefined>;
  write(file: ChatgptSessionFile): Promise<void>;
  clear(): Promise<void>;
}

// ------------------------------------------------------------- the loopback seat (D10)

/**
 * The sign-in's OWN loopback (D10): a second `createDesktopOAuthTransport` instance behind a
 * port-filtered listener, so a ChatGPT sign-in never cancels or consumes a connection wizard's
 * flow. `begin(path)` binds an ephemeral port and answers the redirect URI
 * (`http://127.0.0.1:<port>/auth/callback` — the IP literal, never `localhost`); `onCallback`
 * receives the code delivery, or — this instance opted in — an error delivery so a declined
 * consent ends by name instead of waiting out the TTL; `cancel()` is the visible cancel while
 * the browser is open (AC2).
 */
export interface ChatgptLoopbackSeat {
  begin(path: string): Promise<{ redirectUri: string }>;
  onCallback(cb: (d: CallbackDelivery | CallbackErrorDelivery) => void): () => void;
  cancel(): Promise<void>;
}

// --------------------------------------------------------------- the keeper's API (§2, D5)

/**
 * Every failure the keeper names (plan §2). Each maps to one sentence a person can act on;
 * none ever reroutes a turn (D5).
 */
export const CHATGPT_PLAN_ERROR_CODES = [
  'sign_in_needed',
  'plan_not_granted',
  'usage_limit',
  'usage_unavailable',
  'client_mismatch',
  'registration_incomplete',
  'id_token_invalid',
  'subject_mismatch',
  'refresh_not_ready',
  'revocation_unconfirmed',
  'network',
] as const;

export type ChatgptPlanErrorCode = (typeof CHATGPT_PLAN_ERROR_CODES)[number];

/** What `getAccessToken` / `refreshNow` throw — a code a caller acts on by name, never prose alone. */
export class ChatgptPlanError extends Error {
  readonly code: ChatgptPlanErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: ChatgptPlanErrorCode, retryable = false) {
    super(message);
    this.name = 'ChatgptPlanError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The keeper's state as every surface reads it. `'unknown'` means WAIT — the first store read
 * has not answered yet (Gate-2 finding F9: a launch catch-up step must wait, not refuse a valid
 * session); signed out carries whether a registration is kept (the next sign-in reuses it);
 * signed in carries the plan flag, the account display data, the cached models and the last
 * usage-limit refusal while it stands.
 */
export type ChatgptPlanStatus =
  | 'unknown'
  | { signedIn: false; registered: boolean }
  | {
      signedIn: true;
      planGranted: boolean;
      email?: string;
      name?: string;
      models: readonly ChatgptModel[];
      limit?: { at: number; code: 'usage_limit' | 'usage_unavailable' };
    };

export type SignInResult = { ok: true; status: ChatgptPlanStatus } | { ok: false; code: ChatgptPlanErrorCode; message: string };

/**
 * The one session instance per page (L4 builds it from the platform seat at boot). Implemented
 * by `createChatgptPlanSession` (L1).
 */
export interface ChatgptPlanSession {
  /** Continue with ChatGPT: first sign-in registers the client; `prompt: 'consent'` re-asks for the plan scope (AC3). */
  signIn(opts?: { prompt?: 'consent' }): Promise<SignInResult>;
  /** The visible cancel while the browser is open — tears the listener down, ends the flow by name. */
  cancelSignIn(): Promise<void>;
  /**
   * Best-effort revocation, local delete of tokens + cached models, registration KEPT (D7).
   * `unconfirmed` is told to the user; `none` = there was nothing to revoke.
   */
  signOut(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }>;
  /** Drop the client id and host id too — for a ChatGPT-side disconnect that deleted the client (AC9). */
  forgetRegistration(): Promise<void>;
  /** A bearer for one send, refreshed proactively; throws `ChatgptPlanError` by name. The token lives only for that send. */
  getAccessToken(): Promise<string>;
  /** A forced refresh after a 401 on `previousToken` (single-flight, rotation-safe — D4); answers the new token. */
  refreshNow(previousToken: string): Promise<string>;
  status(): ChatgptPlanStatus;
  subscribe(listener: () => void): () => void;
  /** The plan's models (`visibility:'list'`, server order), from the cache unless `force`; fails soft to the last list (AC8). */
  listModels(force?: boolean): Promise<readonly ChatgptModel[]>;
}
