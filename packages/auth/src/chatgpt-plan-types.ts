/**
 * "Use my ChatGPT plan" — the session contracts (TASK-20261023-siwc-chatgpt-plan, ADR-0078).
 *
 * The TYPES every surface builds against — the per-machine session file the Rust side keeps
 * (D2), the store seat the shell implements over `chatgpt_session_read|write|clear`, the
 * sign-in's own loopback seat (D10), the keeper's API and its named failures (D5) — and the one
 * TOTAL parser that turns whatever the file holds into those types. The keeper itself is
 * `chatgpt-plan.ts`; the measured wire and its pure helpers are `chatgpt-plan-wire.ts`;
 * `chatgpt-plan.ts` re-exports every public name here so the package has one door.
 *
 * Custody in one sentence (ADR-0078 §2): the tokens are a rotating, per-host credential, so
 * they live beside the user file in a `0600` file the shell owns — never in `snug_secrets`,
 * never in an export, a sync push, a share or a URL — and the keeper holds no long-lived token
 * in memory: every use reads the file inside one serial queue.
 */

import type { CallbackDelivery, CallbackErrorDelivery } from './oauth-service.js';
import { isRecord } from './records.js';

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
 * advisory for a forced one (D4). `idTokenUnverified` marks a set whose ID token the keeper
 * could not check when it was persisted (a JWKS outage mid-refresh, or a refresh reply that
 * carried none — RFC 6749 §6 allows the omission): the next use re-verifies it, and a reload
 * does too, because the flag lives in the file rather than in a page's memory (Gate 5 S10).
 */
export interface ChatgptSessionTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: readonly string[];
  idTokenUnverified?: boolean;
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
 * refresh token back. `read` answers `undefined` when no file exists; what it answers otherwise
 * is whatever is on disk, so the keeper runs it through `parseChatgptSessionFile` every time.
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
 * session); it always resolves, even when that read fails (Gate 5 G5-C1: an unreadable file is
 * "signed out, not registered", and the next sign-in names the failure). Signed out carries
 * whether a registration is kept (the next sign-in reuses it); signed in carries the plan flag,
 * the account display data, the cached models and the last usage-limit refusal while it stands.
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
 * The one session instance per page — the playground builds it from the platform seat at boot.
 * Implemented by `createChatgptPlanSession`.
 */
export interface ChatgptPlanSession {
  /** Continue with ChatGPT: first sign-in registers the client; `prompt: 'consent'` re-asks for the plan scope (AC3). */
  signIn(opts?: { prompt?: 'consent' }): Promise<SignInResult>;
  /**
   * The visible cancel while the browser is open — tears the listener down, ends the flow by
   * name. Once an attempt has persisted its tokens it is no longer cancellable: this is then a
   * no-op for it, and the attempt's result still arrives with the models it fetched (G5-C9).
   */
  cancelSignIn(): Promise<void>;
  /**
   * Best-effort revocation, local delete of tokens + cached models, registration KEPT (D7).
   * `unconfirmed` is told to the user; `none` = there was nothing to revoke.
   */
  signOut(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }>;
  /** Drop the client id and host id too — for a ChatGPT-side disconnect that deleted the client (AC9). Clears even when the file cannot be read. */
  forgetRegistration(): Promise<void>;
  /** A bearer for one send, refreshed proactively; throws `ChatgptPlanError` by name. The token lives only for that send. */
  getAccessToken(): Promise<string>;
  /** A forced refresh after a 401 on `previousToken` (single-flight, rotation-safe — D4); answers the new token. */
  refreshNow(previousToken: string): Promise<string>;
  /**
   * The route rejected `token` AFTER a refresh-and-retry (the adapter's second 401 — G5-C4):
   * when it is still the current access token the session is dropped (tokens, account and
   * cached models; the registration kept) and the status says signed out; when another caller
   * already rotated past it, nothing happens.
   */
  reportRejected(token: string): Promise<void>;
  /**
   * Resolves once no refresh, sign-in or sign-out persist job is in flight — the current
   * in-flight refresh promise included, so a close between a token POST's answer and the write
   * of its rotation cannot lose the only valid refresh token (ADR-0078 §4; G5-C2). Never rejects.
   */
  flush(): Promise<void>;
  status(): ChatgptPlanStatus;
  subscribe(listener: () => void): () => void;
  /** The plan's models (`visibility:'list'`, server order), from the cache unless `force`; fails soft to the last list (AC8). */
  listModels(force?: boolean): Promise<readonly ChatgptModel[]>;
}

// --------------------------------------------------------------- the total parser (ST4)

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') return undefined;
    out.push(entry);
  }
  return out;
}

function parseTokens(value: unknown): ChatgptSessionTokens | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = nonEmptyString(value['accessToken']);
  const refreshToken = nonEmptyString(value['refreshToken']);
  const idToken = nonEmptyString(value['idToken']);
  const expiresAt = value['expiresAt'];
  const scopes = parseStringList(value['scopes']);
  if (accessToken === undefined || refreshToken === undefined || idToken === undefined) return undefined;
  if (!isFiniteNumber(expiresAt) || scopes === undefined) return undefined;
  const earliestRefreshAt = value['earliestRefreshAt'];
  if (earliestRefreshAt !== undefined && !isFiniteNumber(earliestRefreshAt)) return undefined;
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    scopes,
    ...(value['idTokenUnverified'] === true ? { idTokenUnverified: true } : {}),
  };
}

function parseAccount(value: unknown): ChatgptSessionAccount | undefined {
  if (!isRecord(value)) return undefined;
  const sub = nonEmptyString(value['sub']);
  if (sub === undefined) return undefined;
  const email = nonEmptyString(value['email']);
  const name = nonEmptyString(value['name']);
  return { sub, ...(email !== undefined ? { email } : {}), ...(name !== undefined ? { name } : {}) };
}

function parseModel(value: unknown): ChatgptModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value['id']);
  const name = value['name'];
  const efforts = parseStringList(value['efforts']);
  if (id === undefined || typeof name !== 'string' || efforts === undefined) return undefined;
  const defaultEffort = nonEmptyString(value['defaultEffort']);
  return { id, name, efforts, ...(defaultEffort !== undefined ? { defaultEffort } : {}) };
}

function parseModelCache(value: unknown): { fetchedAt: number; list: ChatgptModel[] } | undefined {
  if (!isRecord(value)) return undefined;
  const fetchedAt = value['fetchedAt'];
  const entries = value['list'];
  if (!isFiniteNumber(fetchedAt) || !Array.isArray(entries)) return undefined;
  const list: ChatgptModel[] = [];
  for (const entry of entries as unknown[]) {
    const model = parseModel(entry);
    if (model !== undefined) list.push(model);
  }
  return { fetchedAt, list };
}

/**
 * The TOTAL parser over whatever the store hands back (Gate 5 ST4). Never throws: a value that
 * is not a v1 file with a host id reads as no file; a well-formed registration with a
 * malformed `tokens` reads as that registration ALONE — the account and the cached models
 * belong to the session that is gone, and `planGranted` is a fact about tokens; every
 * optional member is typed, and a mistyped one is dropped rather than carried. Unknown
 * fields are ignored (forward-compat), like every envelope parser in this repo.
 */
export function parseChatgptSessionFile(value: unknown): ChatgptSessionFile | undefined {
  if (!isRecord(value) || value['v'] !== 1) return undefined;
  const hostId = nonEmptyString(value['hostId']);
  if (hostId === undefined) return undefined;
  const clientId = nonEmptyString(value['clientId']);
  const registration: ChatgptSessionFile = { v: 1, hostId, ...(clientId !== undefined ? { clientId } : {}), planGranted: false };
  const tokens = parseTokens(value['tokens']);
  if (tokens === undefined) return registration;
  const account = parseAccount(value['account']);
  const models = parseModelCache(value['models']);
  return {
    ...registration,
    tokens,
    ...(account !== undefined ? { account } : {}),
    planGranted: value['planGranted'] === true,
    ...(models !== undefined ? { models } : {}),
  };
}
