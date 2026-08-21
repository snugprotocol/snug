import { z } from 'zod';
import { ERROR_CODES, FRAME_TYPES, LIMITS, NET_METHODS, PROTOCOL_VERSION, STRIP_HEADERS } from './constants.js';

const version = z.literal(PROTOCOL_VERSION);
const id = z.string().min(1).max(LIMITS.ID_CHARS);

export const appAnnounceSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.announce),
  appId: id,
  displayName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
  description: z.string().max(LIMITS.DESCRIPTION_CHARS).optional(),
  iconEmoji: z.string().max(LIMITS.ICON_EMOJI_CHARS).optional(),
  iconColor: z.string().max(LIMITS.ICON_COLOR_CHARS).optional(),
});

export const hostReadySchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.hostReady),
  instanceId: id,
  protocolVersions: z.array(z.number().int().positive()),
  capabilities: z.object({
    streaming: z.boolean(),
    db: z.boolean(),
    auth: z.boolean(),
    /** The envelope net capability (AL-03). Optional so pre-AL-03 host-ready frames still parse (R2). */
    net: z.boolean().optional(),
    /**
     * The open-url capability (ADR-0038 D5): the host will show a confirm dialog for
     * `snug:open-url-request` frames and open approved https URLs in the user's real
     * browser. Optional for the same R2 reason as `net` — and absence is how an app
     * knows to render its copy-the-link fallback instead of a dead button.
     */
    openUrl: z.boolean().optional(),
  }),
  theme: z.enum(['light', 'dark']),
  locale: z.string().max(32).optional(),
});

export const appMessageSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.appMessage),
  requestId: id,
  instanceId: id,
  appId: id,
  action: z.string().min(1).max(LIMITS.ACTION_CHARS),
  payload: z.unknown().optional(),
  state: z.unknown().optional(),
  responseSchema: z.unknown().optional(),
});

export const appCancelSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.appCancel),
  requestId: id,
  instanceId: id,
});

export const responseErrorSchema = z.object({
  /** Open string per rule R5 — known values in ERROR_CODES; unknown codes handled via `retryable`. */
  code: z.string().min(1).max(64),
  message: z.string(),
  rawExcerpt: z.string().max(LIMITS.RAW_EXCERPT_CHARS).optional(),
  attemptsRemaining: z.number().int().min(0).optional(),
  retryable: z.boolean(),
});

export const appResponseSchema = z.union([
  z.object({
    v: version,
    type: z.literal(FRAME_TYPES.appResponse),
    requestId: id,
    ok: z.literal(true),
    streaming: z.literal(true),
    /** Cumulative prose text (display-provisional per rule R3). `mode: 'delta'` reserved for v1.x. */
    text: z.string(),
    seq: z.number().int().min(0).optional(),
  }),
  z.object({
    v: version,
    type: z.literal(FRAME_TYPES.appResponse),
    requestId: id,
    ok: z.literal(true),
    streaming: z.literal(false),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({
    v: version,
    type: z.literal(FRAME_TYPES.appResponse),
    requestId: id,
    ok: z.literal(false),
    error: responseErrorSchema,
  }),
]);

const dbRequestBase = { v: version, type: z.literal(FRAME_TYPES.dbRequest), requestId: id, instanceId: id } as const;

/** Per-op invariants are schema-enforced (parse, don't check): exec needs sql, kv ops need key, import needs bytes. */
export const dbRequestSchema = z.discriminatedUnion('op', [
  z.object({ ...dbRequestBase, op: z.literal('exec'), sql: z.string().min(1), params: z.array(z.unknown()).optional() }),
  z.object({ ...dbRequestBase, op: z.literal('export') }),
  z.object({ ...dbRequestBase, op: z.literal('import'), bytesBase64: z.string().min(1) }),
  z.object({ ...dbRequestBase, op: z.literal('kvGet'), key: z.string().min(1).max(256) }),
  z.object({ ...dbRequestBase, op: z.literal('kvSet'), key: z.string().min(1).max(256), value: z.unknown() }),
]);

const dbResponseBase = { v: version, type: z.literal(FRAME_TYPES.dbResponse), requestId: id } as const;

export const dbResponseSchema = z.union([
  z.object({
    ...dbResponseBase,
    ok: z.literal(true),
    rows: z.array(z.array(z.unknown())).optional(),
    columns: z.array(z.string()).optional(),
    value: z.unknown().optional(),
    bytesBase64: z.string().optional(),
  }),
  z.object({ ...dbResponseBase, ok: z.literal(false), error: responseErrorSchema }),
]);

const NET_CREDENTIAL_HEADER_SET = new Set<string>(STRIP_HEADERS);

/**
 * AL-03's envelope net capability — PUBLISHED at spec v0.3 (in json-schemas SOURCES
 * since TASK-20260820-spec-v03-whitepaper; the superRefine rules below stay prose-only
 * in the spec, since JSON Schema cannot express them).
 *
 * Strict by design (C1/R5): NO appId field exists — the runner's net binding is
 * HOST-assigned exactly like `dbNamespace`, so an app cannot name another app's auth
 * spec; a headers object carrying a credential header (STRIP_HEADERS) is rejected at
 * the bridge (the executor additionally strips, belt and braces); and a `body` on
 * GET/HEAD is strict-rejected (amendment R2).
 */
export const netRequestSchema = z
  .strictObject({
    v: version,
    type: z.literal(FRAME_TYPES.netRequest),
    requestId: id,
    instanceId: id,
    url: z.string().min(1).max(4096),
    method: z.enum(NET_METHODS),
    headers: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
    /** Byte cap (MAX_NET_REQUEST_BODY_BYTES) is executor-enforced; chars ≤ bytes, so this is a cheap early bound. */
    body: z.string().max(LIMITS.MAX_NET_REQUEST_BODY_BYTES).optional(),
  })
  .superRefine((frame, ctx) => {
    if ((frame.method === 'GET' || frame.method === 'HEAD') && frame.body !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: `body is not allowed on ${frame.method} (R2 amendment)` });
    }
    for (const name of Object.keys(frame.headers ?? {})) {
      if (NET_CREDENTIAL_HEADER_SET.has(name.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['headers', name],
          message: `credential header '${name}' may never cross the bridge (C1) — the host injects credentials itself`,
        });
      }
    }
  });

const netResponseBase = { v: version, type: z.literal(FRAME_TYPES.netResponse), requestId: id } as const;

/**
 * Published with netRequestSchema (spec v0.3). Success carries the HTTP status verbatim plus
 * WHITELIST-only headers (already value-scrubbed by the executor) and the scrubbed
 * body; `truncated` marks a response the executor had to cut at the size cap. Envelope
 * failures use the shared error shape (errors as data, R5).
 */
export const netResponseSchema = z.union([
  z.strictObject({
    ...netResponseBase,
    ok: z.literal(true),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
    truncated: z.boolean().optional(),
  }),
  z.strictObject({ ...netResponseBase, ok: z.literal(false), error: responseErrorSchema }),
]);

/**
 * The open-url request (ADR-0038 D5; published at spec v0.3): an app may ASK the
 * host to open an https URL in the user's real browser; the host renders the full URL
 * in a confirm dialog (provenance copy, punycode host) and only the user's gesture
 * opens anything — web via host-page window.open('noopener,noreferrer'), desktop via
 * the https-only system opener. STRICT and URL-only by design: no target, no window
 * features, no navigation primitive — the frame cannot express anything C2 would have
 * to defend against, and the sandbox flags are untouched.
 *
 * https-only and userinfo-free at the SCHEMA so every consumer inherits the refusal;
 * the runner re-refuses on capability absence, and the playground's dialog is the
 * human gate.
 */
export const openUrlRequestSchema = z
  .strictObject({
    v: version,
    type: z.literal(FRAME_TYPES.openUrlRequest),
    requestId: id,
    instanceId: id,
    url: z.string().min(1).max(2048),
  })
  .superRefine((frame, ctx) => {
    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url must parse' });
      return;
    }
    if (url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'only https URLs may be opened' });
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'a URL carrying userinfo is refused (phishing shape)' });
    }
  });

/** The one reply per open-url request: opened (user confirmed), declined, or refused (no capability / invalid). */
export const openUrlResultSchema = z.strictObject({
  v: version,
  type: z.literal(FRAME_TYPES.openUrlResult),
  requestId: id,
  status: z.enum(['opened', 'declined', 'refused']),
  reason: z.string().max(300).optional(),
});

export const hostEventSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.hostEvent),
  /** Open event namespace — consumers ignore unknown events (rule R2 analogue). */
  event: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

export const appEventSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.appEvent),
  event: z.string().min(1).max(64),
  data: z.unknown().optional(),
});

export type AppAnnounceFrame = z.infer<typeof appAnnounceSchema>;
export type HostReadyFrame = z.infer<typeof hostReadySchema>;
export type AppMessageFrame = z.infer<typeof appMessageSchema>;
export type AppCancelFrame = z.infer<typeof appCancelSchema>;
export type AppResponseFrame = z.infer<typeof appResponseSchema>;
export type ResponseError = z.infer<typeof responseErrorSchema>;
export type DbRequestFrame = z.infer<typeof dbRequestSchema>;
export type DbResponseFrame = z.infer<typeof dbResponseSchema>;
export type NetRequestFrame = z.infer<typeof netRequestSchema>;
export type NetResponseFrame = z.infer<typeof netResponseSchema>;
export type OpenUrlRequestFrame = z.infer<typeof openUrlRequestSchema>;
export type OpenUrlResultFrame = z.infer<typeof openUrlResultSchema>;
export type HostEventFrame = z.infer<typeof hostEventSchema>;
export type AppEventFrame = z.infer<typeof appEventSchema>;

export type Frame =
  | AppAnnounceFrame
  | HostReadyFrame
  | AppMessageFrame
  | AppCancelFrame
  | AppResponseFrame
  | DbRequestFrame
  | DbResponseFrame
  | NetRequestFrame
  | NetResponseFrame
  | OpenUrlRequestFrame
  | OpenUrlResultFrame
  | HostEventFrame
  | AppEventFrame;

const FRAME_SCHEMAS: Record<string, z.ZodType<Frame>> = {
  [FRAME_TYPES.announce]: appAnnounceSchema,
  [FRAME_TYPES.hostReady]: hostReadySchema,
  [FRAME_TYPES.appMessage]: appMessageSchema,
  [FRAME_TYPES.appCancel]: appCancelSchema,
  [FRAME_TYPES.appResponse]: appResponseSchema,
  [FRAME_TYPES.dbRequest]: dbRequestSchema,
  [FRAME_TYPES.dbResponse]: dbResponseSchema,
  [FRAME_TYPES.netRequest]: netRequestSchema,
  [FRAME_TYPES.netResponse]: netResponseSchema,
  [FRAME_TYPES.openUrlRequest]: openUrlRequestSchema,
  [FRAME_TYPES.openUrlResult]: openUrlResultSchema,
  [FRAME_TYPES.hostEvent]: hostEventSchema,
  [FRAME_TYPES.appEvent]: appEventSchema,
};

export type FrameParseResult =
  | { ok: true; frame: Frame }
  /** Not addressed to us (non-snug traffic) or a future v1.x frame type — drop silently (rule R2). */
  | { ok: false; ignored: true }
  | {
      ok: false;
      ignored?: false;
      code: typeof ERROR_CODES.UNSUPPORTED_VERSION | 'MALFORMED';
      detail: string;
      /**
       * Recovered from the raw input when it carried a plausible string requestId, so
       * hosts can answer UNSUPPORTED_VERSION/MALFORMED on the wire instead of leaving
       * the app's request hanging (v0.1-draft amendment, TASK-20260731-runner-sandbox).
       */
      requestId?: string;
    };

/** A requestId is answerable only if it is a non-empty string within the R6 id cap. */
function recoverRequestId(candidate: Record<string, unknown>): string | undefined {
  const raw = candidate.requestId;
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= LIMITS.ID_CHARS ? raw : undefined;
}

/**
 * Total parser for anything arriving via postMessage. Never throws.
 * Routing rules: non-snug traffic and unknown `snug:*` types are ignored; version
 * mismatches and malformed known frames return typed failures carrying a recovered
 * `requestId` when the raw input had a plausible one — hosts answer on the wire only
 * in that case, and never otherwise.
 */
export function parseFrame(input: unknown): FrameParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, ignored: true };
  }
  const candidate = input as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string' || !type.startsWith('snug:')) {
    return { ok: false, ignored: true };
  }
  if (candidate.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: ERROR_CODES.UNSUPPORTED_VERSION,
      detail: `frame ${type} carried v=${String(candidate.v)}; supported: [${PROTOCOL_VERSION}]`,
      requestId: recoverRequestId(candidate),
    };
  }
  const schema = FRAME_SCHEMAS[type];
  if (!schema) return { ok: false, ignored: true };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'MALFORMED',
      detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      requestId: recoverRequestId(candidate),
    };
  }
  return { ok: true, frame: parsed.data };
}

/**
 * R6 helper: hosts/SDKs check outbound frames before posting (structured clone has no
 * built-in cap). db-request/db-response use their own 8 MiB size class so artifact
 * import/export can round-trip; net-request/net-response use the net class (B1: 1 MiB
 * response cap + envelope margin — a cap-sized body passes, so an over-cap response can
 * only ever become a terminal error frame, never a silent drop); every other frame
 * keeps the 256 KiB cap.
 */
export function frameWithinLimits(frame: Frame): boolean {
  const limit =
    frame.type === FRAME_TYPES.dbRequest || frame.type === FRAME_TYPES.dbResponse
      ? LIMITS.MAX_DB_FRAME_BYTES
      : frame.type === FRAME_TYPES.netRequest || frame.type === FRAME_TYPES.netResponse
        ? LIMITS.MAX_NET_FRAME_BYTES
        : LIMITS.MAX_FRAME_BYTES;
  try {
    return new TextEncoder().encode(JSON.stringify(frame)).byteLength <= limit;
  } catch {
    return false;
  }
}

export interface Responder {
  readonly requestId: string;
  readonly isClosed: boolean;
  stream(text: string): void;
  succeed(data: Record<string, unknown>): void;
  fail(code: string, message: string, opts: { retryable: boolean; rawExcerpt?: string; attemptsRemaining?: number }): void;
}

/**
 * Terminal-frame guarantee helper (rule R3): hosts answer each accepted request through a
 * Responder, which makes emitting zero or two terminal frames a type/runtime error.
 */
export function createResponder(requestId: string, send: (frame: AppResponseFrame) => void): Responder {
  let closed = false;
  let seq = 0;
  const assertOpen = (op: string): void => {
    if (closed) throw new Error(`responder for ${requestId} already closed (attempted ${op})`);
  };
  return {
    requestId,
    get isClosed() {
      return closed;
    },
    stream(text) {
      assertOpen('stream');
      send({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: true, streaming: true, text, seq: seq++ });
    },
    succeed(data) {
      assertOpen('succeed');
      closed = true;
      send({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId, ok: true, streaming: false, data });
    },
    fail(code, message, opts) {
      assertOpen('fail');
      closed = true;
      // Clamp everything: a terminal error frame must NEVER itself fail schema validation
      // on the app side, or the request hangs forever (violating R3).
      send({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.appResponse,
        requestId,
        ok: false,
        error: {
          code: code.slice(0, 64) || ERROR_CODES.HOST_ERROR,
          message,
          retryable: opts.retryable,
          rawExcerpt: opts.rawExcerpt?.slice(0, LIMITS.RAW_EXCERPT_CHARS),
          attemptsRemaining: opts.attemptsRemaining,
        },
      });
    },
  };
}

/**
 * R3-safe request handling: runs `handler` with a Responder and guarantees a terminal
 * frame even if the handler returns without closing or throws. This is the entrypoint
 * hosts should use; bare createResponder is the low-level escape hatch.
 */
export async function respondTo(
  requestId: string,
  send: (frame: AppResponseFrame) => void,
  handler: (responder: Responder) => void | Promise<void>,
): Promise<void> {
  const responder = createResponder(requestId, send);
  try {
    await handler(responder);
    if (!responder.isClosed) {
      responder.fail(ERROR_CODES.HOST_ERROR, 'host handler completed without a terminal frame', { retryable: true });
    }
  } catch (err) {
    if (!responder.isClosed) {
      responder.fail(ERROR_CODES.HOST_ERROR, err instanceof Error ? err.message : 'host handler threw', {
        retryable: true,
      });
    }
  }
}
