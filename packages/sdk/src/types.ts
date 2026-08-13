import type { ResponseError } from '@snugprotocol/protocol';

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
  /** Base64 of the real `.sqlite` file bytes (5 MiB cap, host-enforced). */
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
