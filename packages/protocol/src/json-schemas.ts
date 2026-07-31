import { z } from 'zod';
import { appRequestEnvelopeSchema } from './envelope.js';
import {
  appAnnounceSchema,
  appCancelSchema,
  appEventSchema,
  appMessageSchema,
  appResponseSchema,
  dbRequestSchema,
  dbResponseSchema,
  hostEventSchema,
  hostReadySchema,
} from './frames.js';

const SOURCES: Record<string, z.ZodType> = {
  'app-announce.json': appAnnounceSchema,
  'host-ready.json': hostReadySchema,
  'app-message.json': appMessageSchema,
  'app-cancel.json': appCancelSchema,
  'app-response.json': appResponseSchema,
  'db-request.json': dbRequestSchema,
  'db-response.json': dbResponseSchema,
  'host-event.json': hostEventSchema,
  'app-event.json': appEventSchema,
  'app-request-envelope.json': appRequestEnvelopeSchema,
};

/**
 * Deterministic JSON Schema export — the byte-level source for `schemas/` and, via
 * SPEC_SYNC.md, for the spec repo. Normalization: recursive key sort, 2-space indent,
 * trailing newline. Regenerate with `pnpm gen:schemas`; CI compares against the
 * committed files.
 */
export function buildJsonSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(SOURCES)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
    out[name] = `${JSON.stringify(sortKeysDeep(json), null, 2)}\n`;
  }
  return out;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
