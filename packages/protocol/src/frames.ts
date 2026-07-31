import { z } from 'zod';
import { ERROR_CODES, FRAME_TYPES, LIMITS, PROTOCOL_VERSION } from './constants.js';

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

export const dbRequestSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.dbRequest),
  requestId: id,
  instanceId: id,
  op: z.enum(['exec', 'export', 'import', 'kvGet', 'kvSet']),
  sql: z.string().optional(),
  params: z.array(z.unknown()).optional(),
  key: z.string().max(256).optional(),
  value: z.unknown().optional(),
  bytesBase64: z.string().optional(),
});

export const dbResponseSchema = z.object({
  v: version,
  type: z.literal(FRAME_TYPES.dbResponse),
  requestId: id,
  ok: z.boolean(),
  rows: z.array(z.array(z.unknown())).optional(),
  columns: z.array(z.string()).optional(),
  value: z.unknown().optional(),
  bytesBase64: z.string().optional(),
  error: responseErrorSchema.optional(),
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
  [FRAME_TYPES.hostEvent]: hostEventSchema,
  [FRAME_TYPES.appEvent]: appEventSchema,
};

export type FrameParseResult =
  | { ok: true; frame: Frame }
  /** Not addressed to us (non-snug traffic) or a future v1.x frame type — drop silently (rule R2). */
  | { ok: false; ignored: true }
  | { ok: false; ignored?: false; code: typeof ERROR_CODES.UNSUPPORTED_VERSION | 'MALFORMED'; detail: string };

/**
 * Total parser for anything arriving via postMessage. Never throws.
 * Routing rules: non-snug traffic and unknown `snug:*` types are ignored; version
 * mismatches and malformed known frames return typed failures the host may log
 * (but never answers on the wire when no requestId is recoverable).
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
    };
  }
  const schema = FRAME_SCHEMAS[type];
  if (!schema) return { ok: false, ignored: true };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, code: 'MALFORMED', detail: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, frame: parsed.data };
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
      send({
        v: PROTOCOL_VERSION,
        type: FRAME_TYPES.appResponse,
        requestId,
        ok: false,
        error: { code, message, retryable: opts.retryable, rawExcerpt: opts.rawExcerpt, attemptsRemaining: opts.attemptsRemaining },
      });
    },
  };
}
