import {
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  NET_ERROR_CODES,
  PROTOCOL_VERSION,
  buildAppRequest,
  createResponder,
  frameWithinLimits,
  parseAgentReply,
  parseFrame,
  type AppAnnounceFrame,
  type AppCancelFrame,
  type AppMessageFrame,
  type AppResponseFrame,
  type DbRequestFrame,
  type DbResponseFrame,
  type Frame,
  type NetRequestFrame,
  type NetResponseFrame,
  type OpenUrlRequestFrame,
  type Responder,
} from '@snugprotocol/protocol';
import type {
  AgentTransport,
  BudgetStore,
  DbDriver,
  DbDriverResult,
  NetHandler,
  NetHandlerResult,
  OpenUrlHandler,
  TransportResult,
} from './transport.js';

export type FrameDirection = 'inbound' | 'outbound';
export type ThemeName = 'light' | 'dark';

/** Cap on concurrent app requests per instance (F7). */
export const MAX_IN_FLIGHT = 8;

/** Terminal error messages are clamped so an error frame can never itself exceed limits. */
const MAX_ERROR_MESSAGE_CHARS = 1000;

export interface RunnerHostCallbacks {
  /** App metadata on (re-)announce. Display only — never a security identity (R4). */
  onAnnounce?: (frame: AppAnnounceFrame) => void;
  /** Open app→host event channel (`resize`, `visibility`, …). */
  onAppEvent?: (event: string, data: unknown) => void;
  /**
   * Observation hook (F12, Inspector): called with every ACCEPTED inbound frame and
   * every actually-POSTED outbound frame. Structural payloads — do not mutate.
   */
  onFrame?: (direction: FrameDirection, frame: Frame) => void;
  /** Fired once per host when the parse-failure budget is (observed) exhausted. */
  onBudgetExhausted?: () => void;
  /** Fired once when the app document navigated unexpectedly (F2) — the host is permanently cut off. */
  onNavigatedAway?: () => void;
}

export interface RunnerHostBaseOptions extends RunnerHostCallbacks {
  /**
   * The sandboxed app iframe (`sandbox="allow-scripts"`, srcDoc). The host attaches its
   * message listener and load/srcdoc observers at create time; the EMBEDDER assigns
   * `srcdoc` (CSP-injected HTML) strictly AFTER createRunnerHost returns, so no frame
   * from the app document can ever race the listener.
   */
  iframe: HTMLIFrameElement;
  transport: AgentTransport;
  /**
   * HOST-assigned key for the parse-failure budget. Never derive this from the
   * app-claimed appId: a re-announcing app must not be able to reset its own budget (F5).
   */
  budgetKey: string;
  /** Defaults to a per-host in-memory store. */
  budgetStore?: BudgetStore;
  theme?: ThemeName;
  locale?: string;
}

/**
 * db capability requires BOTH a driver and a host-assigned namespace (F5); the net
 * capability (AL-03) likewise requires BOTH a handler and a host-assigned `netAppId` —
 * both enforced at the type level so an embedder cannot supply one half. The net
 * binding mirrors `dbNamespace`: HOST-assigned, never app-claimed.
 */
export type RunnerHostOptions = RunnerHostBaseOptions &
  ({ db: DbDriver; dbNamespace: string } | { db?: undefined; dbNamespace?: undefined }) &
  ({ net: NetHandler; netAppId: string } | { net?: undefined; netAppId?: undefined }) & {
    /**
     * The open-url capability (ADR-0038 D5) — optional and standalone: unlike db/net it
     * needs no id binding, because the frame carries only a URL and the handler is the
     * host's own confirm surface. Absent ⇒ `capabilities.openUrl` is false and every
     * request gets a named `refused` result, never a silent drop.
     */
    openUrl?: OpenUrlHandler;
  };

export interface RunnerHost {
  /** Removes listeners/observers, aborts in-flight work, drops all timers. Idempotent. */
  destroy(): void;
  /**
   * Explicit user reset (R6): clears the parse budget (unless `clearBudget` is false),
   * supersedes in-flight work, and — when a srcDoc is present — reassigns it to reload
   * the app. The reassignment is counted as an EXPECTED load (no navigation cutoff).
   * A navigation cutoff is permanent and is NOT lifted by reset; recreate the host.
   */
  reset(clearBudget?: boolean): void;
  /** Posts a `theme-change` host-event and updates the theme of later ready frames. */
  setTheme(theme: ThemeName): void;
  /** Posts an arbitrary host-event (open additive channel, R2). */
  notifyEvent(event: string, data?: unknown): void;
}

interface InFlight {
  controller: AbortController;
  responder: Responder;
}

function createMemoryBudgetStore(): BudgetStore {
  const data = new Map<string, number>();
  return { get: (key) => data.get(key) ?? 0, set: (key, value) => void data.set(key, value) };
}

function mintInstanceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid !== undefined ? `ins-${uuid}` : `ins-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clampMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_CHARS ? message.slice(0, MAX_ERROR_MESSAGE_CHARS) : message;
}

/** True when the sleep completed; false when the signal aborted first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Attaches the Snug bridge host to a sandboxed app iframe.
 *
 * Lifecycle contract: create the host FIRST, then assign `iframe.srcdoc` (the React
 * wrapper does this in effect order). Every inbound frame is source-checked against
 * `iframe.contentWindow` (R4 — sandboxed srcDoc iframes have a null origin, so
 * `event.origin` is useless and `targetOrigin` is necessarily `'*'`).
 *
 * Navigation escape (F2): the host counts srcdoc assignments (via MutationObserver) as
 * expected loads. A document `load` with no outstanding assignment credit means the app
 * navigated on its own — the host aborts everything and never posts again.
 */
export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  const { iframe, transport, budgetKey } = options;
  const win = iframe.ownerDocument.defaultView;
  if (!win) throw new Error('createRunnerHost: iframe must belong to a live document');

  const budget = options.budgetStore ?? createMemoryBudgetStore();
  let theme: ThemeName = options.theme ?? 'light';
  let instanceId = mintInstanceId();
  let announcedThisLoad = false;
  let destroyed = false;
  let navigatedAway = false;
  let exhaustedNotified = false;
  /** Outstanding srcdoc-assignment credits; a load with zero credits is an escape. */
  let allowedLoads = 0;
  const inFlight = new Map<string, InFlight>();
  /** In-flight db requestIds — same duplicate/flood discipline as app messages (Gate-5). */
  const dbInFlight = new Set<string>();
  /** In-flight net requestIds — same discipline as the db seam (AL-03). */
  const netInFlight = new Set<string>();
  /**
   * ONE pending open-url request per instance (ADR-0038): each open is a modal human
   * decision, so a queue would be a dialog-spam primitive. A second request while one
   * is pending gets a named `refused`, never a stacked dialog.
   */
  let openUrlPending = false;

  const observer = new MutationObserver((records) => {
    allowedLoads += records.length;
  });
  observer.observe(iframe, { attributes: true, attributeFilter: ['srcdoc'] });

  // ---------------------------------------------------------------- outbound

  function post(frame: Frame): void {
    if (destroyed || navigatedAway) return;
    if (!frameWithinLimits(frame)) return; // oversized streaming frames are skipped silently (F9)
    const target = iframe.contentWindow;
    if (!target) return;
    target.postMessage(frame, '*');
    options.onFrame?.('outbound', frame);
  }

  function postHostReady(): void {
    post({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.hostReady,
      instanceId,
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: {
        streaming: true,
        db: options.db !== undefined,
        auth: false,
        net: options.net !== undefined,
        openUrl: options.openUrl !== undefined,
      },
      theme,
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
    });
  }

  function failSafely(
    responder: Responder,
    code: string,
    message: string,
    opts: { retryable: boolean; rawExcerpt?: string; attemptsRemaining?: number },
  ): void {
    if (!responder.isClosed) responder.fail(code, clampMessage(message), opts);
  }

  // ------------------------------------------------------------- strike budget

  function currentStrikes(): number {
    const value = budget.get(budgetKey);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function notifyExhaustedOnce(): void {
    if (exhaustedNotified) return;
    exhaustedNotified = true;
    options.onBudgetExhausted?.();
  }

  // ---------------------------------------------------------------- lifecycle

  function supersedeInFlight(message: string): void {
    for (const entry of inFlight.values()) {
      failSafely(entry.responder, ERROR_CODES.SUPERSEDED, message, { retryable: false });
      entry.controller.abort();
    }
    inFlight.clear();
  }

  function cutOff(): void {
    navigatedAway = true; // set FIRST: nothing below may post, ever again
    supersedeInFlight('app navigated away');
    options.onNavigatedAway?.();
  }

  function onLoad(): void {
    if (destroyed || navigatedAway) return;
    // Drain undelivered mutation records so a srcdoc assignment in this task counts.
    allowedLoads += observer.takeRecords().length;
    if (!iframe.hasAttribute('srcdoc')) return; // initial about:blank — no app document yet
    if (allowedLoads <= 0) {
      cutOff(); // a load nobody assigned: the sandboxed document navigated (F2)
      return;
    }
    // Consume ALL credits: rapid consecutive assignments can coalesce into one load,
    // and leaving residue would bank a free navigation. Fail closed.
    allowedLoads = 0;
    supersedeInFlight('superseded by app reload');
    instanceId = mintInstanceId();
    announcedThisLoad = false;
    postHostReady(); // spec: ready on load AND as announce-ack (idempotent)
  }

  // ----------------------------------------------------------------- inbound

  function handleAnnounce(frame: AppAnnounceFrame): void {
    if (announcedThisLoad) {
      // R4: a new announce from the same document invalidates in-flight work.
      supersedeInFlight('superseded by re-announce');
      instanceId = mintInstanceId();
    }
    announcedThisLoad = true;
    options.onAnnounce?.(frame);
    postHostReady();
  }

  function handleAppMessage(frame: AppMessageFrame): void {
    if (frame.instanceId !== instanceId) return; // stale instance — drop silently (R4)
    void respondTo(frame.requestId, async (responder) => {
      if (!frameWithinLimits(frame)) {
        failSafely(responder, ERROR_CODES.HOST_ERROR, 'app-message exceeds the frame size limit', { retryable: false });
        return;
      }
      if (currentStrikes() >= LIMITS.MAX_PARSE_FAILURES) {
        notifyExhaustedOnce();
        // Never silence (R3): exhausted budget answers immediately and non-retryably.
        failSafely(responder, ERROR_CODES.PARSE_FAILED, 'parse-failure budget exhausted — explicit user reset required', {
          retryable: false,
          attemptsRemaining: 0,
        });
        return;
      }
      if (inFlight.has(frame.requestId)) {
        failSafely(responder, ERROR_CODES.HOST_ERROR, `requestId ${frame.requestId} is already in flight`, {
          retryable: false,
        });
        return;
      }
      if (inFlight.size >= MAX_IN_FLIGHT) {
        failSafely(responder, ERROR_CODES.HOST_ERROR, `too many concurrent requests (max ${MAX_IN_FLIGHT})`, {
          retryable: true,
        });
        return;
      }
      const controller = new AbortController();
      inFlight.set(frame.requestId, { controller, responder });
      try {
        const wire = buildAppRequest({
          appId: frame.appId,
          instanceId: frame.instanceId,
          requestId: frame.requestId,
          action: frame.action,
          payload: frame.payload,
          state: frame.state,
          responseSchema: frame.responseSchema,
        });
        const result = await sendWithConflictRetries(wire, controller.signal, responder);
        if (result === undefined) {
          // Aborted: cancel/supersede/destroy already closed the responder; if not
          // (defensive), guarantee the terminal frame ourselves.
          failSafely(responder, ERROR_CODES.CANCELLED, 'request aborted', { retryable: false });
          return;
        }
        if (responder.isClosed) return;
        if (!result.ok) {
          failSafely(responder, result.code, result.message, { retryable: result.retryable });
          return;
        }
        const reply = parseAgentReply(result.text);
        if (!reply.ok && result.stopReason === 'max_tokens') {
          // The output cap cut the reply off mid-JSON — the model complied and the HOST
          // truncated, so this is not a parse failure and charges no strike (AC3). The
          // copy names the real cause; PARSE_FAILED copy here produced an unwinnable
          // retry loop presented as the model's fault (TASK-20260812).
          failSafely(responder, ERROR_CODES.HOST_ERROR, 'agent reply was cut off by the output token limit before it finished', {
            retryable: true,
            rawExcerpt: reply.error.rawExcerpt,
          });
          return;
        }
        if (!reply.ok) {
          const strikes = currentStrikes() + 1;
          budget.set(budgetKey, strikes); // strike = TERMINAL parse failure only (F8)
          const attemptsRemaining = Math.max(0, LIMITS.MAX_PARSE_FAILURES - strikes);
          if (attemptsRemaining === 0) notifyExhaustedOnce();
          failSafely(responder, ERROR_CODES.PARSE_FAILED, reply.error.message, {
            retryable: attemptsRemaining > 0,
            rawExcerpt: reply.error.rawExcerpt,
            attemptsRemaining,
          });
          return;
        }
        budget.set(budgetKey, 0); // success resets the consecutive-failure budget
        const terminal: AppResponseFrame = {
          v: PROTOCOL_VERSION,
          type: FRAME_TYPES.appResponse,
          requestId: frame.requestId,
          ok: true,
          streaming: false,
          data: reply.data,
        };
        if (!frameWithinLimits(terminal)) {
          // Only oversized TERMINALS become errors (streaming is skipped) — never silence.
          failSafely(responder, ERROR_CODES.HOST_ERROR, 'agent reply exceeds the frame size limit', {
            retryable: false,
          });
          return;
        }
        responder.succeed(reply.data);
      } finally {
        inFlight.delete(frame.requestId);
      }
    });
  }

  /**
   * R3 wrapper: guarantees exactly one terminal frame per accepted request even if the
   * handler throws or returns without closing. (Local rather than protocol respondTo so
   * the guaranteed fallback frame also goes through this host's guarded `post`.)
   */
  async function respondTo(requestId: string, handler: (responder: Responder) => Promise<void>): Promise<void> {
    const responder = createResponder(requestId, post);
    try {
      await handler(responder);
      if (!responder.isClosed) {
        responder.fail(ERROR_CODES.HOST_ERROR, 'host completed without a terminal frame', { retryable: true });
      }
    } catch (err) {
      failSafely(responder, ERROR_CODES.HOST_ERROR, err instanceof Error ? err.message : 'host handler threw', {
        retryable: true,
      });
    }
  }

  /** Returns undefined when aborted. Retries THREAD_CONFLICT with R6 backoff, abort-aware. */
  async function sendWithConflictRetries(
    wire: string,
    signal: AbortSignal,
    responder: Responder,
  ): Promise<TransportResult | undefined> {
    const backoffs = LIMITS.THREAD_CONFLICT_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      let accumulated = '';
      let settled = false;
      let result: TransportResult;
      try {
        result = await transport.send(wire, {
          signal,
          onDelta: (delta) => {
            if (settled || responder.isClosed) return; // post-settle callbacks are ignored (F6)
            accumulated += delta;
            responder.stream(accumulated); // cumulative frames (R3); oversized ones skip in post()
          },
        });
      } catch (err) {
        if (signal.aborted) return undefined;
        // Errors-as-data is the transport contract; a throw is a transport bug.
        result = {
          ok: false,
          code: ERROR_CODES.HOST_ERROR,
          message: err instanceof Error ? err.message : 'transport threw',
          retryable: true,
        };
      } finally {
        settled = true;
      }
      if (signal.aborted) return undefined;
      if (result.ok || result.code !== ERROR_CODES.THREAD_CONFLICT || !result.retryable || attempt >= backoffs.length) {
        return result;
      }
      const slept = await abortableSleep(backoffs[attempt] ?? backoffs[backoffs.length - 1] ?? 0, signal);
      if (!slept) return undefined;
    }
  }

  function handleAppCancel(frame: AppCancelFrame): void {
    if (frame.instanceId !== instanceId) return;
    const entry = inFlight.get(frame.requestId);
    if (!entry) return;
    failSafely(entry.responder, ERROR_CODES.CANCELLED, 'cancelled by the app', { retryable: false });
    entry.controller.abort();
  }

  function postDbError(requestId: string, code: string, message: string, retryable: boolean): void {
    post({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbResponse,
      requestId,
      ok: false,
      error: { code, message: clampMessage(message), retryable },
    });
  }

  async function handleDbRequest(frame: DbRequestFrame): Promise<void> {
    if (frame.instanceId !== instanceId) return; // stale instance — drop silently
    if (!frameWithinLimits(frame)) {
      postDbError(frame.requestId, ERROR_CODES.HOST_ERROR, 'db-request exceeds the db frame size limit', false);
      return;
    }
    if (options.db === undefined) {
      postDbError(frame.requestId, ERROR_CODES.HOST_ERROR, 'this host has no db capability', false);
      return;
    }
    if (dbInFlight.has(frame.requestId)) {
      postDbError(frame.requestId, ERROR_CODES.HOST_ERROR, `db requestId ${frame.requestId} is already in flight`, false);
      return;
    }
    if (dbInFlight.size >= MAX_IN_FLIGHT) {
      postDbError(frame.requestId, ERROR_CODES.HOST_ERROR, `too many concurrent db requests (max ${MAX_IN_FLIGHT})`, true);
      return;
    }
    dbInFlight.add(frame.requestId);
    const boundInstance = instanceId;
    let result: DbDriverResult;
    try {
      // Storage identity is the HOST-assigned namespace — never app-claimed appId (F5).
      result = await options.db.handle(options.dbNamespace, frame);
    } catch (err) {
      result = {
        ok: false,
        code: ERROR_CODES.HOST_ERROR,
        message: err instanceof Error ? err.message : 'db driver threw',
        retryable: true,
      };
    } finally {
      dbInFlight.delete(frame.requestId);
    }
    if (destroyed || navigatedAway || instanceId !== boundInstance) return; // superseded meanwhile
    if (!result.ok) {
      postDbError(frame.requestId, result.code, result.message, result.retryable);
      return;
    }
    const response: DbResponseFrame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbResponse,
      requestId: frame.requestId,
      ok: true,
      ...(result.rows !== undefined ? { rows: result.rows } : {}),
      ...(result.columns !== undefined ? { columns: result.columns } : {}),
      ...(result.value !== undefined ? { value: result.value } : {}),
      ...(result.bytesBase64 !== undefined ? { bytesBase64: result.bytesBase64 } : {}),
    };
    if (!frameWithinLimits(response)) {
      postDbError(frame.requestId, ERROR_CODES.HOST_ERROR, 'db result exceeds the db frame size limit', false);
      return;
    }
    post(response);
  }

  function postNetError(requestId: string, code: string, message: string, retryable: boolean): void {
    post({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.netResponse,
      requestId,
      ok: false,
      error: { code, message: clampMessage(message), retryable },
    });
  }

  /**
   * Route a validated net-request to the HOST-assigned handler (AL-03) — the runner is
   * value-blind (R4): it hands over the frame and posts back whatever the handler
   * returns, never reading a credential value. The `netAppId` binding is host-assigned,
   * never app-claimed (mirrors dbNamespace, F5). An oversized net-response can only ever
   * become a NET_SIZE_EXCEEDED terminal frame, never silence (B1).
   */
  async function handleNetRequest(frame: NetRequestFrame): Promise<void> {
    if (frame.instanceId !== instanceId) return; // stale instance — drop silently
    if (!frameWithinLimits(frame)) {
      postNetError(frame.requestId, ERROR_CODES.HOST_ERROR, 'net-request exceeds the net frame size limit', false);
      return;
    }
    if (options.net === undefined) {
      postNetError(frame.requestId, ERROR_CODES.HOST_ERROR, 'this host has no net capability', false);
      return;
    }
    if (netInFlight.has(frame.requestId)) {
      postNetError(frame.requestId, ERROR_CODES.HOST_ERROR, `net requestId ${frame.requestId} is already in flight`, false);
      return;
    }
    if (netInFlight.size >= MAX_IN_FLIGHT) {
      postNetError(frame.requestId, ERROR_CODES.HOST_ERROR, `too many concurrent net requests (max ${MAX_IN_FLIGHT})`, true);
      return;
    }
    netInFlight.add(frame.requestId);
    const boundInstance = instanceId;
    let result: NetHandlerResult;
    try {
      // The net binding is the HOST-assigned netAppId — never the app-claimed appId (F5/R5).
      result = await options.net.handle(options.netAppId, frame);
    } catch (err) {
      result = {
        ok: false,
        code: ERROR_CODES.HOST_ERROR,
        message: err instanceof Error ? err.message : 'net handler threw',
        retryable: true,
      };
    } finally {
      netInFlight.delete(frame.requestId);
    }
    if (destroyed || navigatedAway || instanceId !== boundInstance) return; // superseded meanwhile
    if (!result.ok) {
      postNetError(frame.requestId, result.code, result.message, result.retryable);
      return;
    }
    const response: NetResponseFrame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.netResponse,
      requestId: frame.requestId,
      ok: true,
      status: result.status,
      headers: result.headers,
      body: result.body,
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    };
    if (!frameWithinLimits(response)) {
      // B1: an oversized net-response can NEVER be silently dropped at the bridge — it
      // becomes a SMALL terminal NET_SIZE_EXCEEDED (the executor caps while reading; this
      // is the belt to that braces for a handler that returns an over-cap body anyway).
      postNetError(frame.requestId, NET_ERROR_CODES.NET_SIZE_EXCEEDED, 'net result exceeds the net frame size limit', false);
      return;
    }
    post(response);
  }

  function postOpenUrlResult(requestId: string, status: 'opened' | 'declined' | 'refused', reason?: string): void {
    post({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.openUrlResult,
      requestId,
      status,
      ...(reason !== undefined ? { reason: clampMessage(reason) } : {}),
    });
  }

  /**
   * Route a validated open-url request to the host's confirm surface (ADR-0038 D5).
   * The runner never opens a window itself — it holds no navigation primitive — and a
   * missing capability is a NAMED refusal, never the router's silent unknown-frame
   * drop: an app must be able to render its copy-the-link fallback on a fact, not a
   * timeout.
   */
  async function handleOpenUrlRequest(frame: OpenUrlRequestFrame): Promise<void> {
    if (frame.instanceId !== instanceId) return; // stale instance — drop silently
    if (options.openUrl === undefined) {
      postOpenUrlResult(frame.requestId, 'refused', 'this app does not have the open-url capability');
      return;
    }
    if (openUrlPending) {
      postOpenUrlResult(frame.requestId, 'refused', 'an open-url request is already waiting on the user');
      return;
    }
    openUrlPending = true;
    const boundInstance = instanceId;
    let status: 'opened' | 'declined' | 'refused';
    let reason: string | undefined;
    try {
      status = await options.openUrl.open(frame.url);
    } catch (err) {
      status = 'refused';
      reason = err instanceof Error ? err.message : 'the host could not open the link';
    } finally {
      openUrlPending = false;
    }
    if (destroyed || navigatedAway || instanceId !== boundInstance) return; // superseded meanwhile
    postOpenUrlResult(frame.requestId, status, reason);
  }

  /**
   * Answer UNSUPPORTED_VERSION/MALFORMED on the wire ONLY when a requestId is recoverable
   * (R1) AND the raw `type` is an answerable app-origin request type. Anything else —
   * host-frame types echoed back, unknown types, app-cancel — is dropped: a hostile app
   * must not be able to conjure reflected response frames (Gate-5 finding 3).
   */
  function answerUnparseable(raw: unknown, code: string, detail: string, requestId: string | undefined): void {
    if (requestId === undefined) return;
    const rawType = (raw as { type?: unknown } | null)?.type;
    const error = { code, message: clampMessage(detail), retryable: false };
    if (rawType === FRAME_TYPES.dbRequest) {
      post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.dbResponse, requestId, ok: false, error });
    } else if (rawType === FRAME_TYPES.netRequest) {
      post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.netResponse, requestId, ok: false, error });
    } else if (rawType === FRAME_TYPES.appMessage) {
      post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: false, error });
    }
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed || navigatedAway) return;
    if (event.source !== iframe.contentWindow) return; // R4: route by source identity only
    const parsed = parseFrame(event.data);
    if (!parsed.ok) {
      if (parsed.ignored) return; // non-snug traffic / unknown snug:* types (R2)
      answerUnparseable(event.data, parsed.code, parsed.detail, parsed.requestId);
      return;
    }
    const frame = parsed.frame;
    switch (frame.type) {
      case FRAME_TYPES.announce:
      case FRAME_TYPES.appMessage:
      case FRAME_TYPES.appCancel:
      case FRAME_TYPES.dbRequest:
      case FRAME_TYPES.netRequest:
      case FRAME_TYPES.openUrlRequest:
      case FRAME_TYPES.appEvent:
        break;
      default:
        return; // host→app frame types reflected back at us — drop
    }
    options.onFrame?.('inbound', frame);
    switch (frame.type) {
      case FRAME_TYPES.announce:
        handleAnnounce(frame);
        return;
      case FRAME_TYPES.appMessage:
        handleAppMessage(frame);
        return;
      case FRAME_TYPES.appCancel:
        handleAppCancel(frame);
        return;
      case FRAME_TYPES.dbRequest:
        void handleDbRequest(frame);
        return;
      case FRAME_TYPES.netRequest:
        void handleNetRequest(frame);
        return;
      case FRAME_TYPES.openUrlRequest:
        void handleOpenUrlRequest(frame);
        return;
      case FRAME_TYPES.appEvent:
        options.onAppEvent?.(frame.event, frame.data);
        return;
    }
  }

  function notifyEvent(event: string, data?: unknown): void {
    post({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.hostEvent,
      event,
      ...(data !== undefined ? { data } : {}),
    });
  }

  win.addEventListener('message', onMessage);
  iframe.addEventListener('load', onLoad);

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true; // set FIRST: no frame may post during teardown
      win.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      observer.disconnect();
      for (const entry of inFlight.values()) {
        failSafely(entry.responder, ERROR_CODES.SUPERSEDED, 'host destroyed', { retryable: false });
        entry.controller.abort(); // also cancels abort-aware backoff sleeps
      }
      inFlight.clear();
    },
    reset(clearBudget = true): void {
      if (destroyed) return;
      if (clearBudget) {
        budget.set(budgetKey, 0);
        exhaustedNotified = false;
      }
      supersedeInFlight('superseded by host reset');
      const srcdoc = iframe.getAttribute('srcdoc');
      if (srcdoc !== null) {
        // Reassignment reloads the app; the srcdoc observer counts it as expected.
        iframe.setAttribute('srcdoc', srcdoc);
      }
    },
    setTheme(next: ThemeName): void {
      if (next === theme) return; // unchanged theme is a no-op — never a noise event (Gate-5)
      theme = next; // later host-ready frames carry the new theme
      notifyEvent('theme-change', { theme: next });
    },
    notifyEvent,
  };
}
