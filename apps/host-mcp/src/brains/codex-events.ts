// What `codex exec --json` says, and the only two things Snug lets it mean (ADR-0071 §2).
//
// The stream is JSONL (measured on the real CLI 0.160.0; the shapes are upstream's
// `exec_events.rs`): `thread.started`, `turn.started`, `item.started|updated|completed`
// (item types `agent_message`, `reasoning`, `command_execution`, `file_change`,
// `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`, `error`),
// `turn.completed`, `turn.failed`, `error`. The answer arrives whole, as one
// `item.completed` / `agent_message` — never as token deltas.
//
// THE TRIPWIRE IS AN ALLOWLIST. Codex has no "no tools" switch, and of the features the
// driver disables only one has been observed to remove its tool. So the stream is read as
// evidence: an `agent_message` is the answer, `reasoning` is dropped, and ANY other item —
// a known tool item or a type that did not exist when this was written — means the brain
// tried to act. The think fails and nothing it produced is delivered. A denylist would have
// let tomorrow's tool through.
//
// WHAT THAT DOES AND DOES NOT BOUND. It withholds the ANSWER, so no tool result reaches an
// app. It cannot undo what a tool already did; that is bounded by the read-only sandbox and
// the disabled features, and it is why the driver kills the process group the moment this
// reports — and why Codex is `verified: false` until a logged-in walk shows adversarial
// thinks producing no such item at all.
//
// NOTHING THE CLI SAYS ABOUT A FAILURE TRAVELS. Its messages carry request ids, URLs and
// whatever a provider put in an error body (recorded: `cf-ray`, `request id`, the endpoint).
// A failure is mapped by pattern onto a fixed set of sentences, and the page sees only those.

import { StringDecoder } from 'node:string_decoder';

/**
 * The sentences for what Codex itself reported — one line each, nothing interpolated. `codex.ts`
 * adds Snug's own bound, abort, concurrency-cap and stopping sentences; none carries the CLI's text.
 */
export const CODEX_SENTENCES = {
  // A think that met no login: the probe's remedy (codex.ts `codexLoginRemedy`) names the ONE
  // command — `codex login` alone would log in the user's own ~/.codex, not Snug's (B7 walk).
  loggedOut: 'Snug’s Codex is not logged in — the brain menu shows the one command that logs it in; then check again.',
  usageLimit: 'Your Codex plan has reached its usage limit — try again later.',
  capacity: 'The Codex model is at capacity right now — try again in a moment.',
  contextWindow: 'This think is too large for the Codex model’s context window.',
  streamDropped: 'Codex lost its connection before it finished answering — try again.',
  toolAttempt: 'Codex tried to use a tool, which Snug never allows — the think was stopped and nothing was delivered.',
  couldNotStart: 'Snug could not start your Codex CLI.',
  tooLarge: 'This think is too large for your Codex CLI — an app’s instructions ride its command line, and the system refused one this long.',
  noAnswer: 'Codex could not answer.',
  unreadableStatus: 'Your Codex CLI did not say whether it is logged in.',
  statusTimedOut: 'Your Codex CLI did not answer the login check in time.',
} as const;

/**
 * A failure the CLI described, as one of ours — or nothing, when it said nothing we know.
 * Auth first: the recorded logged-out run says `401` inside a "stream … Reconnecting"
 * sentence, and the login is the one a person can act on.
 */
function specificSentence(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  if (/not logged in|\b401\b|unauthorized|authenticat/i.test(message)) return CODEX_SENTENCES.loggedOut;
  if (/usage limit|quota|\b429\b|too many requests|rate limit/i.test(message)) return CODEX_SENTENCES.usageLimit;
  if (/at capacity|high demand|overloaded/i.test(message)) return CODEX_SENTENCES.capacity;
  if (/context window|context[ _]length|maximum context/i.test(message)) return CODEX_SENTENCES.contextWindow;
  if (/stream (?:disconnected|closed)|connection (?:closed|reset|lost)/i.test(message)) return CODEX_SENTENCES.streamDropped;
  return undefined;
}

/** A JSONL line longer than this is not an event. The answer rides ONE line, so the cap is generous. */
export const MAX_EVENT_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Lines of JSON out of a byte stream. A pipe read ends on a BYTE: not on a line, and not on
 * a character — so the decoder is stateful (an em dash cut in two must not become
 * U+FFFD ×3) and a partial line waits for its end.
 */
export function createJsonlReader(handlers: { onValue(value: unknown): void; onOverflow(): void }, maxLineChars: number = MAX_EVENT_LINE_CHARS): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const line = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return; // stdout is the wire; a line that is not JSON is noise, not an event
    }
    handlers.onValue(value);
  };

  const drain = (): void => {
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      line(text);
    }
    // Checked AFTER the whole lines are taken: the cap is on ONE line, never on a read that
    // happened to carry many.
    if (buffer.length > maxLineChars) {
      buffer = '';
      handlers.onOverflow();
    }
  };

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      buffer += decoder.end();
      drain();
      const rest = buffer;
      buffer = '';
      line(rest);
    },
  };
}

/** How one think ended: an answer, or the one sentence that says why there is none. */
export type CodexOutcome = { kind: 'answered'; text: string } | { kind: 'failed'; sentence: string };

const ITEM_EVENTS = new Set(['item.started', 'item.updated', 'item.completed']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One turn's verdict, read off its stream. `push` returns the outcome the moment it is
 * decided — a tripped wire is decided at the FIRST offending item, while the tool may still
 * be running — and `end` decides a stream that stopped without one. Decided once: nothing
 * that arrives later changes it.
 */
export function createCodexTurn(options: { maxLineChars?: number } = {}): { push(chunk: Buffer | string): CodexOutcome | undefined; end(): CodexOutcome } {
  let outcome: CodexOutcome | undefined;
  /** The LAST complete agent message. Held — an answer is only an answer once the turn completed. */
  let answer: string | undefined;
  /** The most recent specific thing a top-level `error` said. The CLI reports retries as errors, so one is not a verdict. */
  let said: string | undefined;

  const fail = (sentence: string): void => {
    outcome ??= { kind: 'failed', sentence };
  };

  const onValue = (event: unknown): void => {
    if (outcome !== undefined || !isRecord(event) || typeof event.type !== 'string') return;

    if (ITEM_EVENTS.has(event.type)) {
      const item = isRecord(event.item) ? event.item : undefined;
      switch (item?.type) {
        case 'agent_message':
          if (event.type !== 'item.completed') return; // still being written
          if (typeof item.text === 'string') answer = item.text;
          else fail(CODEX_SENTENCES.noAnswer);
          return;
        case 'reasoning':
          return; // thinking stays private, as it does on every brain
        case 'error':
          fail(specificSentence(item.message) ?? said ?? CODEX_SENTENCES.noAnswer);
          return;
        default:
          // Everything else, known or not: the brain tried to act.
          fail(CODEX_SENTENCES.toolAttempt);
          return;
      }
    }

    switch (event.type) {
      case 'turn.completed':
        outcome = { kind: 'answered', text: answer ?? '' };
        return;
      case 'turn.failed':
        fail(specificSentence(isRecord(event.error) ? event.error.message : undefined) ?? said ?? CODEX_SENTENCES.noAnswer);
        return;
      case 'error':
        said = specificSentence(event.message) ?? said;
        return;
      default:
        return; // `thread.started`, `turn.started`, and whatever a newer CLI says around a turn
    }
  };

  const reader = createJsonlReader({ onValue, onOverflow: () => fail(CODEX_SENTENCES.noAnswer) }, options.maxLineChars);

  return {
    push(chunk) {
      if (outcome === undefined) reader.push(chunk);
      return outcome;
    },
    end() {
      if (outcome === undefined) reader.end();
      // A stream that stopped before `turn.completed` delivered nothing, whatever it held.
      outcome ??= { kind: 'failed', sentence: said ?? CODEX_SENTENCES.noAnswer };
      return outcome;
    },
  };
}
