import { ERROR_CODES, LIMITS } from './constants.js';
import type { ResponseError } from './frames.js';

export type AgentReplyResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ResponseError & { code: typeof ERROR_CODES.PARSE_FAILED; rawExcerpt: string } };

/**
 * Total, fence-tolerant parser for an agent's JSON-only reply to an app request.
 * Precedence (review finding 12 — never corrupt valid JSON):
 *   1. JSON.parse of the trimmed text as-is.
 *   2. The content of the first fenced ``` block.
 *   3. Every balanced `{…}` region (string-aware), first one that parses to an object wins.
 * Only non-null plain objects are accepted; failures return PARSE_FAILED with a capped excerpt.
 */
export function parseAgentReply(text: string): AgentReplyResult {
  if (typeof text === 'string') {
    const trimmed = text.trim();
    for (const candidate of candidates(trimmed)) {
      const obj = tryParseObject(candidate);
      if (obj) return { ok: true, data: obj };
    }
  }
  const excerpt = (typeof text === 'string' ? text : String(text)).slice(0, LIMITS.RAW_EXCERPT_CHARS);
  return {
    ok: false,
    error: {
      code: ERROR_CODES.PARSE_FAILED,
      message: 'agent reply was not a parseable JSON object',
      rawExcerpt: excerpt,
      retryable: true,
    },
  };
}

function* candidates(trimmed: string): Generator<string> {
  yield trimmed;
  const fence = /```(?:json)?\r?\n?([\s\S]*?)\r?\n?```/i.exec(trimmed);
  if (fence?.[1]) yield fence[1].trim();
  yield* balancedObjects(trimmed);
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to next candidate */
  }
  return null;
}

/** Yields each balanced top-level `{…}` region, tracking JSON string/escape state. */
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
    if (ch === '"') inString = true;
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
