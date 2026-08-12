import type { DbRequestFrame, NetRequestFrame } from '@snugprotocol/protocol';

/**
 * Outcome of one transport attempt — errors as data, never thrown across the boundary.
 * Known `code` values live in the protocol's ERROR_CODES (e.g. HTTP 409 → THREAD_CONFLICT,
 * network failure → NETWORK_ERROR); the host retries THREAD_CONFLICT itself and forwards
 * everything else to the app as a terminal error frame honoring `retryable`.
 */
export type TransportResult =
  | {
      ok: true;
      text: string;
      /**
       * Why the agent stopped, when the transport knows. `max_tokens` marks a reply the
       * OUTPUT CAP cut off mid-generation: the host must not read its unparseable tail
       * as model non-compliance — no PARSE_FAILED strike, and the app gets told the
       * reply was cut off rather than "not JSON" (TASK-20260812 AC3). Transports that
       * cannot know (older servers) omit it and keep today's behavior.
       */
      stopReason?: 'end' | 'max_tokens';
    }
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

/**
 * Result of one net operation — errors as data, mirroring DbDriverResult. Success maps
 * 1:1 onto the top-level fields of a `snug:net-response` (AL-03).
 */
export type NetHandlerResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated?: boolean }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * Host-brokered network handler (AL-03; implemented in apps/playground by the
 * @snugprotocol/auth connected-fetch executor). `netAppId` is the HOST-assigned
 * `netAppId` option — never the app-claimed appId — so the net binding is decided by
 * the embedder exactly like `dbNamespace`, and an app cannot name another app's auth
 * spec. C1 (token boundary): this interface exposes NO credential surface to the
 * runner; the runner routes the validated net-request frame and posts the response the
 * handler returns, and never sees a credential value (the R4 value-blind lint proves
 * the runner imports no fetch-calling module).
 */
export interface NetHandler {
  handle(netAppId: string, request: NetRequestFrame): Promise<NetHandlerResult>;
}
