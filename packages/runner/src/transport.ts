import type { DbRequestFrame } from '@snugprotocol/protocol';

/**
 * Outcome of one transport attempt — errors as data, never thrown across the boundary.
 * Known `code` values live in the protocol's ERROR_CODES (e.g. HTTP 409 → THREAD_CONFLICT,
 * network failure → NETWORK_ERROR); the host retries THREAD_CONFLICT itself and forwards
 * everything else to the app as a terminal error frame honoring `retryable`.
 */
export type TransportResult =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface AgentTransportOptions {
  /** Aborted on app cancel, supersede (reload/re-announce/reset), navigation cutoff, and destroy. */
  signal: AbortSignal;
  /**
   * Called with each streamed DELTA (not cumulative text). The host accumulates deltas
   * and posts cumulative `streaming: true` frames per rule R3. Calls after the returned
   * promise settles are ignored by the host.
   */
  onDelta?: (delta: string) => void;
}

/**
 * The runner-owned seam to the host's agent endpoint (implemented by child 5: SSE/HTTP).
 *
 * C1 (token boundary): this interface deliberately exposes NO URL, header, or credential
 * surface to anything app-controlled. The `wire` string is the tagged chat envelope built
 * by the HOST from a validated app-message; where the request goes and what credentials
 * it carries are fixed at transport construction time, outside the sandbox's reach.
 */
export interface AgentTransport {
  send(wire: string, options: AgentTransportOptions): Promise<TransportResult>;
}

/**
 * Synchronous store for the PARSE_FAILED strike budget (rule R6: 3 consecutive terminal
 * parse failures, then an explicit user reset). Keyed by the HOST-assigned `budgetKey` —
 * never by app-claimed identity, so a hostile app cannot reset its own budget by
 * re-announcing with a fresh appId. Synchronous by contract: budget checks sit on the
 * request hot path and must not introduce await points between check and update.
 */
export interface BudgetStore {
  /** Current strike count for `key`; absent keys read as 0. */
  get(key: string): number;
  set(key: string, value: number): void;
}

/**
 * Result of one db operation — errors as data, mirroring TransportResult.
 * Success fields map 1:1 onto the TOP-LEVEL fields of a `snug:db-response` frame
 * (rows/columns/value/bytesBase64), per dbResponseSchema.
 */
export type DbDriverResult =
  | { ok: true; rows?: unknown[][]; columns?: string[]; value?: unknown; bytesBase64?: string }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * Host-brokered storage driver (implemented by child 4: sql.js/OPFS). `namespace` is the
 * HOST-assigned `dbNamespace` option — never the app-claimed appId — so storage identity
 * is decided by the embedder, not by whatever the sandboxed HTML announces.
 */
export interface DbDriver {
  handle(namespace: string, request: DbRequestFrame): Promise<DbDriverResult>;
}
