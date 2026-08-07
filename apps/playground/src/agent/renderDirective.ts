// renderDirective.ts — parse-don't-trust for the builder's `auth_wizard` render
// directive (AL-04 plan D9). The playground validates with `renderDirectiveSchema`
// before ANY UI effect: a malformed directive is dropped with a visible note, never
// partially rendered (same posture as frame parsing). The VALIDATED directive is
// also the ONLY shape that persists in chat message `meta` (M1 — the schema itself
// carries no evidence[] and no docs-derived free text), and it is re-validated on
// every read: an imported/synced file cannot smuggle a widened shape back in.

import { renderDirectiveSchema, type RenderDirective } from '@snugprotocol/protocol';

export type DirectiveScan = { directive: RenderDirective } | { malformed: true } | null;

/**
 * Scan a builder reply for a render directive. Candidates: every fenced code
 * block, then every balanced top-level `{…}` region (string-aware). The FIRST
 * candidate that validates wins; a candidate that parses as JSON and CLAIMS a
 * directive kind but fails the schema makes the scan `malformed` (dropped + note).
 */
export function scanForRenderDirective(text: string): DirectiveScan {
  let sawMalformedClaim = false;
  for (const candidate of candidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const validated = renderDirectiveSchema.safeParse(parsed);
    if (validated.success) return { directive: validated.data };
    if (typeof (parsed as Record<string, unknown>)['kind'] === 'string' && String((parsed as Record<string, unknown>)['kind']).startsWith('auth_wizard')) {
      sawMalformedClaim = true;
    }
  }
  return sawMalformedClaim ? { malformed: true } : null;
}

function* candidates(text: string): Generator<string> {
  const fence = /```(?:json)?\r?\n?([\s\S]*?)\r?\n?```/gi;
  for (const match of text.matchAll(fence)) {
    const inner = match[1]?.trim();
    if (inner !== undefined && inner !== '') yield inner;
  }
  yield text.trim();
  yield* balancedObjects(text);
}

/** Balanced `{…}` regions, tracking JSON string/escape state (the reply.ts pattern). */
function* balancedObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0 && --depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/** Build the persisted meta fragment — the VALIDATED directive, nothing else (M1). */
export function directiveToMeta(directive: RenderDirective): { directive: RenderDirective } {
  return { directive };
}

/**
 * Read a directive back out of persisted meta, RE-validating strictly — a row that
 * grew extra fields (import, sync, tampering) reads as no directive at all.
 */
export function metaToDirective(meta: unknown): RenderDirective | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const raw = (meta as Record<string, unknown>)['directive'];
  if (raw === undefined) return undefined;
  const validated = renderDirectiveSchema.safeParse(raw);
  return validated.success ? validated.data : undefined;
}
