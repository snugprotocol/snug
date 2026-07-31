// builder.ts — the Builder chat seam. One interface, two implementations:
//   server → POST /invoke + SSE (delta/artifact/done/error events, heartbeats
//            tolerated, 409/429 surfaced as typed errors)
//   byok   → runAgentTurn in-browser with the KB + artifact tools; SSE-shaped events
//            are SYNTHESIZED from the turn callbacks so the view code is identical.

import { parseSse, runAgentTurn, tryParseJsonRecord, type AgentTool } from '@snugprotocol/adapters';
import { buildHostSystemPrompt } from '@snugprotocol/knowledge';
import { ERROR_CODES } from '@snugprotocol/protocol';

import type { LibraryStore } from '../state/library.js';
import { getByokKey, type ByokProvider } from '../state/mode.js';
import { createByokAdapter } from './adapter.js';
import { buildByokTools } from './tools.js';

export interface ArtifactEvent {
  artifactId: string;
  displayName: string;
}

export interface BuildHandlers {
  /** Streamed DELTA (not cumulative) — callers accumulate. */
  onDelta?: (delta: string) => void;
  /** An artifact landed (SSE `artifact` event / byok artifact_write). */
  onArtifact?: (artifact: ArtifactEvent) => void;
  /** Tool activity for the reasoning pill ("consulting the knowledge base…"). */
  onActivity?: (label: string) => void;
}

export type BuildResult =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface BuilderAgent {
  send(message: string, handlers: BuildHandlers, signal: AbortSignal): Promise<BuildResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
}

const cancelled = (): BuildResult => ({
  ok: false,
  code: ERROR_CODES.CANCELLED,
  message: 'stopped',
  retryable: false,
});

// ---------------------------------------------------------------- server mode

export function createServerBuilder(threadId: string, fetchImpl?: FetchLike): BuilderAgent {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async send(message, handlers, signal) {
      let response: Response;
      try {
        response = await doFetch('/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ message, threadId }),
          signal,
        });
      } catch (err) {
        return isAbort(err, signal)
          ? cancelled()
          : { ok: false, code: ERROR_CODES.NETWORK_ERROR, message: 'could not reach the server', retryable: true };
      }
      if (!response.ok) {
        const body = tryParseJsonRecord(await response.text().catch(() => ''));
        return {
          ok: false,
          code: typeof body?.code === 'string' ? body.code : ERROR_CODES.HOST_ERROR,
          message: typeof body?.message === 'string' ? body.message : `server answered ${response.status}`,
          retryable: body?.retryable === true,
        };
      }
      try {
        for await (const event of parseSse(response.body)) {
          const data = tryParseJsonRecord(event.data);
          if (data === null) continue; // one malformed block never kills the stream
          if (event.event === 'delta' && typeof data.text === 'string') {
            handlers.onDelta?.(data.text);
          } else if (event.event === 'artifact') {
            if (typeof data.artifactId === 'string') {
              handlers.onArtifact?.({
                artifactId: data.artifactId,
                displayName: typeof data.displayName === 'string' ? data.displayName : 'your app',
              });
            }
          } else if (event.event === 'done') {
            return { ok: true, text: typeof data.text === 'string' ? data.text : '' };
          } else if (event.event === 'error') {
            return {
              ok: false,
              code: typeof data.code === 'string' ? data.code : ERROR_CODES.HOST_ERROR,
              message: typeof data.message === 'string' ? data.message : 'server error',
              retryable: data.retryable === true,
            };
          }
        }
      } catch (err) {
        if (isAbort(err, signal)) return cancelled();
        return { ok: false, code: 'STREAM_DROPPED', message: 'the stream dropped mid-reply', retryable: true };
      }
      return { ok: false, code: 'STREAM_DROPPED', message: 'the stream ended without a reply', retryable: true };
    },
  };
}

// ------------------------------------------------------------------ byok mode

export interface ByokBuilderOptions {
  provider: ByokProvider;
  library: LibraryStore & Required<Pick<LibraryStore, 'save'>>;
  /** Injectable for tests; defaults to the sessionStorage-backed key. */
  getKey?: () => string | undefined;
}

export function createByokBuilder(options: ByokBuilderOptions): BuilderAgent {
  const readKey = options.getKey ?? getByokKey;
  const system = buildHostSystemPrompt({ appBuilder: true, artifacts: true });
  return {
    async send(message, handlers, signal) {
      const adapter = createByokAdapter(options.provider, readKey(), 'chat');
      const tools: AgentTool[] = buildByokTools(options.library, {
        onArtifact: (artifact) => handlers.onArtifact?.({ artifactId: artifact.id, displayName: artifact.displayName }),
      });
      const result = await runAgentTurn({
        adapter,
        system,
        messages: [{ role: 'user', content: message }],
        tools,
        signal,
        onDelta: (delta) => handlers.onDelta?.(delta),
        onEvent: (event) => {
          if (event.type === 'tool_call') {
            handlers.onActivity?.(
              event.call.name === 'artifact_write' ? 'writing the app file…' : 'consulting the knowledge base…',
            );
          }
        },
      });
      if (signal.aborted) return cancelled();
      return result.ok
        ? { ok: true, text: result.text }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}
