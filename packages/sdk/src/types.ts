import type { AccessGrantView as ProtocolAccessGrantView, AccessHints, AccessParam, ResponseError } from '@snugprotocol/protocol';

/** App identity shown by the host — display metadata, never a security identity (R4). */
export interface SnugAppMeta {
  /** Stable kebab-case id. */
  appId: string;
  /** Max 80 chars. */
  displayName: string;
  /** Max 400 chars. */
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
}

export type SnugTheme = 'light' | 'dark';

/** Capabilities advertised by host-ready. Optional fields: the protocol is additive (R2). */
export interface HostCapabilities {
  streaming?: boolean;
  db?: boolean;
  auth?: boolean;
  /**
   * Access between apps (spec 1.1 Part VI, ADR-0075): `true` when this host routes
   * `snug:access-request`. Absent from a 1.0 host — render the honest fallback, never assume.
   */
  access?: boolean;
}

/**
 * The ALWAYS-resolved result of sendMessage (never rejects): `{ok:true, data}` with the
 * agent's parsed reply, or `{ok:false, error}` — errors are data, render them.
 */
export type SendMessageResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ResponseError };

export interface SendMessageOptions {
  /** The FULL current app state — each request is self-contained; the agent has no memory. */
  state?: unknown;
  /** The reply shape you expect back. Always pass it. */
  responseSchema?: unknown;
  /**
   * Called with CUMULATIVE display text while the agent streams. Display-provisional
   * only (R3) — the resolved Promise is the sole final answer.
   */
  onStream?: (text: string) => void;
}

export interface UseSnugAppResult {
  /** True once host-ready arrived; sendMessage before that resolves a HOST_ERROR result. */
  isReady: boolean;
  theme: SnugTheme;
  /** True while at least one sendMessage is in flight. */
  isWaiting: boolean;
  lastResponse: SendMessageResult | null;
  sendMessage(action: string, payload?: unknown, opts?: SendMessageOptions): Promise<SendMessageResult>;
}

/** Result shape of a db exec — the KB-documented `{rows, columns}` contract. */
export interface DbExecResult {
  rows: unknown[][];
  columns: string[];
}

/** Host-brokered SQL surface (useAppDB). Failures THROW here — unlike sendMessage. */
export interface AppDb {
  exec(sql: string, params?: unknown[]): Promise<DbExecResult>;
  /** Base64 of the real `.snug` file bytes (5 MiB cap, host-enforced). */
  exportDb(): Promise<string>;
  importDb(bytesBase64: string): Promise<void>;
}

/** Options for a host-brokered net request (AL-03). No credential fields — the HOST injects them. */
export interface ConnectedFetchOptions {
  /** Defaults to GET. Mutating methods prompt the user for confirmation on the host side. */
  method?: string;
  /** Ordinary request headers. Credential headers (Authorization, Cookie, X-Api-Key, …) are stripped by the host. */
  headers?: Record<string, string>;
  /** Request body (POST/PUT/PATCH/DELETE only). */
  body?: string;
}

/**
 * The ALWAYS-resolved result of a connected fetch (never rejects): a scrubbed,
 * whitelist-headered success, or an envelope error (errors are data — render them). The
 * app never sees a credential value; the host injected and scrubbed them.
 */
export type ConnectedFetchResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated?: boolean }
  | { ok: false; error: ResponseError };

/**
 * Host-brokered network surface (useConnectedFetch, AL-03). The sandboxed app has zero
 * network of its own (C2); this reaches ONLY the app's APPROVED hosts through the host,
 * which validates the ceiling, injects credentials, caps sizes, gates mutating calls
 * behind user confirmation, and scrubs the response. ALWAYS resolves.
 */
export interface ConnectedFetch {
  fetch(url: string, opts?: ConnectedFetchOptions): Promise<ConnectedFetchResult>;
}

// ---------------------------------------------------------------- access between apps (ADR-0075)

/**
 * What the reader LEARNS about an access grant: the source's display name and icon, the
 * granted tables with their columns, the duration and expiry — never the source's library id
 * or the user's other apps. The protocol's `accessGrantViewSchema`, inferred (one definition):
 * `access` is `'read'` at 1.1 and an open string so a future grant kind still parses.
 */
export type AccessGrantView = ProtocolAccessGrantView;

/** The failure arm every access call shares — errors are data (R5 open codes; known ones in `ACCESS_ERROR_CODES`). */
export type AccessFailure = { ok: false; error: ResponseError };

/** `request` answered: the user allowed it, and this is what was granted. */
export type AccessRequestResult = { ok: true; grant: AccessGrantView } | AccessFailure;

/**
 * `query` answered: ONE read-only SELECT's columns and rows from a scoped copy of the source.
 * `truncated` is set when the host cut the answer at its row or byte cap; `totalRows` is then
 * the statement's full count.
 */
export type AccessQueryResult =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated?: boolean; totalRows?: number }
  | AccessFailure;

/** `list` answered: this app's live access grants (none is an empty list, not an error). */
export type AccessListResult = { ok: true; grants: AccessGrantView[] } | AccessFailure;

/** `release` answered: the grant is given back. */
export type AccessReleaseResult = { ok: true } | AccessFailure;

/**
 * Relevance hints for the host's ranking of the user's apps — hints only; the USER picks the
 * source. The protocol's own inferred type (`accessHintsSchema`; caps `ACCESS_HINT_WORDS_MAX`,
 * `ACCESS_HINT_WORD_MAX_CHARS`, `ACCESS_HINT_TABLES_MAX`), never a retyped shape.
 */
export type AccessRequestHints = AccessHints;

export interface AccessRequestOptions {
  hints?: AccessRequestHints;
  /** The id of a grant being asked for again (an expired or stopped one). */
  renew?: string;
}

/** The `onChange` hint: ids only (R7) — call `list()` or `query()` to learn what changed. */
export interface AccessChange {
  grantId: string;
}

/**
 * Host-brokered access to ANOTHER app's tables (useSnugAccess; spec 1.1 Part VI). The app
 * never names a source: it states a purpose, the user picks the app and tables on host UI the
 * app cannot draw over, and the app learns only what was granted. Every read is logged on the
 * source and every grant can be stopped at any moment. Every call ALWAYS resolves (errors as
 * data); before host-ready it resolves a retryable `HOST_ERROR`, and on a host that does not
 * advertise `capabilities.access === true` a non-retryable `HOST_ERROR` (render the fallback).
 */
export interface SnugAccess {
  /** Ask the user for access — after a user act, never on load. `purpose` is one plain line, shown quoted. */
  request(purpose: string, opts?: AccessRequestOptions): Promise<AccessRequestResult>;
  /** Run ONE read-only `SELECT` on a granted source's tables. */
  query(grantId: string, sql: string, params?: AccessParam[]): Promise<AccessQueryResult>;
  /** This app's live access grants. */
  list(): Promise<AccessListResult>;
  /** Give a grant back. */
  release(grantId: string): Promise<AccessReleaseResult>;
  /** Called when one of this app's grants changed on the host (stopped, paused, expired). Returns the unsubscribe. */
  onChange(listener: (data: AccessChange) => void): () => void;
}
