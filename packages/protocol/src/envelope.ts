import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION, SNUG_APP_REQUEST_TAG } from './constants.js';

const id = z.string().min(1).max(LIMITS.ID_CHARS);

/**
 * The chat envelope a host sends to its agent endpoint for an app-originated turn.
 * `snug: 1` is the machine-detectable marker AND version (ancestors had an ad-hoc
 * boolean marker or nothing). Servers detect it with isAppRequest() and typically
 * skip thread history — the envelope is self-contained via `state`.
 */
export const appRequestEnvelopeSchema = z.object({
  snug: z.literal(PROTOCOL_VERSION),
  appId: id,
  instanceId: id,
  requestId: id,
  action: z.string().min(1).max(LIMITS.ACTION_CHARS),
  payload: z.unknown().optional(),
  state: z.unknown().optional(),
  responseSchema: z.unknown().optional(),
});

export type AppRequestEnvelope = z.infer<typeof appRequestEnvelopeSchema>;

export type EnvelopeInput = Omit<AppRequestEnvelope, 'snug'>;

/** Serialize an envelope to the tagged wire string: `[SNUG_APP_REQUEST]\n{json}`. */
export function buildAppRequest(env: EnvelopeInput): string {
  // Marker last so a stray `snug` on the input can never override it.
  const body: AppRequestEnvelope = { ...env, snug: PROTOCOL_VERSION };
  return `${SNUG_APP_REQUEST_TAG}\n${JSON.stringify(body)}`;
}

/** True only for a tag-prefixed message whose body parses and carries the `snug: 1` marker. */
export function isAppRequest(text: string): boolean {
  return parseAppRequest(text).ok;
}

export type AppRequestParseResult =
  | { ok: true; envelope: AppRequestEnvelope }
  | { ok: false; detail: string };

/** Total parser for the tagged wire string. Never throws. */
export function parseAppRequest(text: string): AppRequestParseResult {
  if (typeof text !== 'string' || !text.startsWith(SNUG_APP_REQUEST_TAG)) {
    return { ok: false, detail: 'missing tag prefix' };
  }
  const body = text.slice(SNUG_APP_REQUEST_TAG.length).replace(/^\r?\n/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: 'body is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: 'body must be a JSON object' };
  }
  const result = appRequestEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, envelope: result.data };
}
