// The brain contract (ADR-0071 §1): what the runner needs of ANY agent the user already has.
//
// ADR-0069 named the brain as its own axis and built one — the user's `claude` CLI as a
// tool-less child. Everything about it was hard-wired: the binary lookup, the argv, the child
// class, the probe, the catalogue. This file is the seam a second brain needs, and nothing
// in it is shaped like a CLI: a driver says who it is, whether it can answer, which models
// and thinking levels it has IN ITS OWN WORDS, and makes the `Brain` the chat route calls.
// A third brain is a file and a registry line.
//
// Two rules ride with the contract because every driver owes them (ADR-0071 §2, §3):
//   · NO BRAIN MAY ACT. An app's think is untrusted input; a brain that can run a shell is a
//     door out of the sandbox (C2). Each driver is tool-free by construction, pinned by a
//     frozen literal in its own test. There is no "allow tools" switch here to set.
//   · NO DRIVER PASSES THE PARENT ENVIRONMENT. A child gets `childEnvFor`'s allowlist and
//     nothing else, so no API key and no session token can reach one (C1).

import path from 'node:path';

// ------------------------------------------------------------- the child environment

/**
 * A child's environment, built from NOTHING (D-B21).
 *
 * Measured inside a live Claude Code session on 2026-09-07, the environment an MCP server
 * inherits carries twelve `CLAUDE_*` variables — `CLAUDE_CODE_MESSAGING_TOKEN` and
 * `CLAUDE_CODE_MESSAGING_SOCKET` among them, which together are a live IPC channel back
 * into the running session. A denylist against that namespace is a losing game: it is
 * undocumented and it grows between CLI versions, so the first variable added after this
 * ships would leak silently. An allowlist cannot drift that way — and it is why a second
 * vendor's keys (`OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`) needed no new
 * line here: a brain on a key is not "the user's own agent" (D15).
 *
 * Passing HOME is what lets a CLI find the user's own login, which is the point.
 */
export const CHILD_ENV_ALLOWLIST = ['HOME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'] as const;

/**
 * @param execDir the directory of the Node running this process, prepended to the child's
 *   PATH: under a desktop host PATH is empty, and an npm-installed `claude` or `codex` is a
 *   `#!/usr/bin/env node` shim that would exit 127 without one (measured, both). The
 *   launcher found this Node; the child inherits the find.
 */
export function childEnvFor(parent: Record<string, string | undefined>, execDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  if (execDir !== undefined && execDir !== '') {
    env.PATH = env.PATH === undefined || env.PATH === '' ? execDir : `${execDir}${path.delimiter}${env.PATH}`;
  }
  return env;
}

// ------------------------------------------------------------------ what rides argv

/**
 * What a model id may look like before it is allowed into argv: it starts with a letter or digit
 * (so it can never read as a flag), and holds only the characters real ids use — aliases
 * (`sonnet`), dated ids (`claude-haiku-4-5-20251001`), the context suffix (`claude-opus-5-5[1m]`),
 * a dotted slug (`gpt-5.5`). A CLI's parser may happen to consume a dash-led value as the
 * option's argument today; a child's argv must not rest on that (review, 2026-10-03).
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;
export const isModelId = (value: unknown): value is string => typeof value === 'string' && MODEL_ID.test(value);

/**
 * The most a system prompt may weigh, in UTF-8 bytes, where it rides a child's argv — which
 * is where both CLIs take it (`--system-prompt`, `-c developer_instructions=`). The limits
 * are the kernel's: Linux refuses any ONE argument over 128 KiB (`MAX_ARG_STRLEN`), macOS
 * the whole argv + environment over 1 MiB (`ARG_MAX`). Both numbers leave room for the rest
 * of the command line and for what quoting adds. Past them the spawn fails `E2BIG`, which
 * each driver names (`isArgvTooBig`) instead of passing on.
 */
export function argvPromptLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' ? 120_000 : 900_000;
}

/** A spawn the kernel refused because the command line was too long. */
export const isArgvTooBig = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'E2BIG';

// ---------------------------------------------------------------- the wire shapes

export interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

/**
 * One think, as the chat route hands it to the brain it resolved. `model` and `effort` are
 * THAT brain's entry of the user's per-machine choice, already validated by its driver; the
 * page's `claude` placeholder was stripped by the route and never arrives here.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  /** The thinking level, in the brain's own vocabulary. */
  effort?: string;
}

/** OpenAI allows content as a string OR as an array of parts; the page's adapter uses both. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => part.text ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Turn an OpenAI-shaped conversation into the ONE system prompt and ONE user prompt a child
 * takes. The assistant turns are rendered into the prompt rather than dropped: without them
 * every follow-up would reach the model as a fresh question with no memory of its own last
 * answer.
 */
export function splitChatRequest(request: ChatRequest): { system: string; prompt: string } {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n\n');

  const turns = request.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
  if (!turns.some((message) => message.role === 'user')) {
    throw new Error('this request carries no user turn — there is nothing to answer');
  }
  // A single user turn rides bare; a conversation is labelled so the model can tell the
  // voices apart.
  const prompt =
    turns.length === 1 && turns[0] !== undefined
      ? textOf(turns[0].content)
      : turns.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${textOf(message.content)}`).join('\n\n');

  return { system, prompt };
}

/**
 * The SSE frames of one answer, as the page's OpenAI adapter reads them.
 *
 * EVERY FRAME IS ONE JSON.stringify OF THE WHOLE PAYLOAD: a delta's text is a string value
 * inside it, so a delta containing "\n\ndata:" rides inside its frame and can never forge a
 * second (pinned by a test with exactly that text).
 *
 * @param placeholder the model the content frames name — the brain's own id, NEVER the
 *   model that was asked for: the page reads the final frame's model as "what ran", and a
 *   request must not turn into a claim (ADR-0070 D2).
 */
export function chatFrames(placeholder: string): { content(text: string): string; finish(model: string, reason: string): string; done: string } {
  const base = { id: `chatcmpl-snug-${Date.now().toString(36)}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: placeholder };
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  return {
    content: (text) => frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    finish: (model, reason) => frame({ ...base, model, choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
    done: 'data: [DONE]\n\n',
  };
}

// ------------------------------------------------------------------- the brain

/** Where a streamed answer goes: the route's response, or a string in tests. */
export interface StreamSink {
  write(chunk: string): void;
  /** The page giving up on the request (the route's `close`); the child is reaped. */
  signal?: AbortSignal;
}

/**
 * A failed stream, and whether any of it reached the sink. The route answers a failure
 * BEFORE the first delta with a 502 the page can read; after it, the only honest move is
 * to close the stream with no finish, which the page's adapter reports as dropped.
 */
export class BrainStreamError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
  ) {
    super(message);
    this.name = 'BrainStreamError';
  }
}

export interface Brain {
  /** Answer one OpenAI-shaped chat request, writing SSE chunks as the answer arrives. */
  stream(request: ChatRequest, sink: StreamSink): Promise<void>;
  /** The same answer as one SSE body — the buffered form, for tests and the live check. */
  complete(request: ChatRequest): Promise<string>;
  /** Reap every child, warm or busy. */
  stop(): void;
}

// ------------------------------------------------------------------- the driver

/**
 * What a brain can do right now (ADR-0069 §6, ADR-0071 §6), decided before the first think
 * rather than by it.
 *
 * `ready` — it can answer. `logged-out` — installed, no usable session. `outdated` — the
 * agent names a newer version it needs. `absent` — nothing is installed; the page's demo
 * brain answers and the chip says how to get one. `unknown` — it could not be told; the
 * honest state, and never treated as ready.
 */
export type BrainState = 'ready' | 'logged-out' | 'outdated' | 'absent' | 'unknown';

export interface BrainReadiness {
  state: BrainState;
  /** One sentence for the chip: what is wrong and what to do. Never a stack trace. */
  detail?: string;
}

/** One model a brain will take, with the thinking levels THAT model has. */
export interface BrainModel {
  id: string;
  name: string;
  /** Empty = this model has no thinking axis, so no level is offered for it. */
  efforts: readonly string[];
}

export interface BrainCatalog {
  /** The levels on offer when no model is chosen (the brain's default model's). */
  efforts: readonly string[];
  /** Empty = no list could be read; the page keeps free text as the whole control. */
  models: readonly BrainModel[];
}

export interface BrainDriver {
  /** Compared, never displayed (`claude`, `codex`). */
  readonly id: string;
  readonly name: string;
  /** Whose it is, in words (`your Claude Code CLI`). */
  readonly via: string;
  /**
   * Whether the tool-free posture has been PROVEN on a real, logged-in run (ADR-0071 §2).
   * An unverified brain is never taken by `auto`; it answers only when pinned by id.
   */
  readonly verified: boolean;
  /** Whether an answer arrives as it is written, or whole at the end. */
  readonly streaming: boolean;
  /** The largest system prompt this brain can be handed, in UTF-8 bytes, where it has a limit. */
  readonly maxPromptBytes?: number;
  /** Asked the cheapest honest way the agent offers — never at process start (B1). */
  probe(): Promise<BrainReadiness>;
  /** Models and levels in the brain's OWN vocabulary; nothing maps one brain's onto another's (ADR-0071 §5). */
  catalog(): BrainCatalog;
  acceptsModel(model: string): boolean;
  /** @param model the model the level is for; undefined = the brain's default model. */
  acceptsEffort(model: string | undefined, effort: string): boolean;
  create(): Brain;
}
