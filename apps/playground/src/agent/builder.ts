// builder.ts — the Builder chat seam. One interface, two implementations:
//   server → POST /invoke + SSE (delta/artifact/done/error events, heartbeats
//            tolerated, 409/429 surfaced as typed errors)
//   byok   → runAgentTurn in-browser with the KB + artifact tools; SSE-shaped events
//            are SYNTHESIZED from the turn callbacks so the view code is identical.

import { parseSse, runAgentTurn, tryParseJsonRecord, type AgentTool, type AgentTurnEvent } from '@snugprotocol/adapters';
import { buildHostSystemPrompt } from '@snugprotocol/knowledge';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { getPlatform } from '../platform/platform.js';
import { appProviderPinFor, resolveModelForApp } from '../state/appModel.js';
import { endpointsNeedConfirmStore, getByokKey, type ByokProvider } from '../state/mode.js';
import { adapterKindFor, createTurnAdapter, routeOf, type AdapterKind, type DirectMode } from './adapter.js';
import type { ArtifactSink } from './artifactSink.js';
import { buildByokTools } from './tools.js';
import { extractAppHtml, WEBLLM_BUILD_SUFFIX } from './webllm/appHtml.js';

export interface ArtifactEvent {
  artifactId: string;
  displayName: string;
  /** User-DB version number — set on direct-mode writes; subscription mode fills it after the client-side fetch+write. */
  version?: number;
}

export interface TurnHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * One chat turn with its app-attached context (child 3, AC4). Direct mode appends
 * `contextBlock` to the system prompt and replays `history` as real turns;
 * subscription mode prepends the block to the wire message (server unchanged, which
 * keeps its own history — `history` is ignored there).
 */
export interface BuilderTurn {
  message: string;
  contextBlock?: string;
  history?: TurnHistoryMessage[];
  /**
   * Replace the turn's tool set (ADR-0019 D9).
   *
   * The DATA lane passes the two data tools here, which is the second half of intent
   * scoping: the context assembler decides what the turn can SEE and this decides what
   * it can DO. An empty array is a legitimate value — the `app_question`/`other` lanes
   * answer tool-free — so the check is `!== undefined`, never truthiness.
   */
  tools?: AgentTool[];
}

/**
 * One entry in the build step timeline. A tool STARTS and later ENDS; the view keeps
 * every step in order rather than collapsing them into one label (task AC9/AC10).
 * Carries the tool NAME and phase only — never its inputs or outputs.
 */
export interface BuildStep {
  tool: string;
  phase: 'start' | 'end';
}

export interface BuildHandlers {
  /** Streamed DELTA (not cumulative) — callers accumulate. */
  onDelta?: (delta: string) => void;
  /** An artifact landed (SSE `artifact` event / byok artifact_write). */
  onArtifact?: (artifact: ArtifactEvent) => void;
  /**
   * Ordered tool progress for the step timeline. Both modes emit it: direct mode from
   * the turn's tool_call/tool_result events, subscription mode from the hub's `step`
   * SSE event (added server-side in the same task).
   */
  onStep?: (step: BuildStep) => void;
  /** Tool activity for the reasoning pill ("consulting the knowledge base…"). */
  onActivity?: (label: string) => void;
  /** The app's schema or wiki docs changed (direct-mode tools) — refresh panels. */
  onKnowledge?: () => void;
  /**
   * The LLM inspector's only feed. Carries the WHOLE agent-turn event union, not just
   * completed round trips: the surface renders calls and tools as they START, with a
   * live timer, and settles them on completion. Direct mode only — subscription-mode
   * round trips happen on the hub and are never serialized to the client, by design.
   */
  onLlmEvent?: (event: AgentTurnEvent) => void;
  /**
   * What this turn actually runs on (TASK-20260826, ADR-0059 rule 3), reported once
   * per send from the SAME resolved config the adapter is constructed from — and
   * BEFORE the provider is called, because provenance is a property of the route,
   * not of a successful response. Direct mode only: the server builder never fires
   * it (subscription turns are the hub's story and are never scripted).
   */
  onBrain?: (kind: AdapterKind) => void;
}

export type BuildResult =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string; retryable: boolean };

export interface BuilderAgent {
  send(turn: string | BuilderTurn, handlers: BuildHandlers, signal: AbortSignal): Promise<BuildResult>;
}

const asTurn = (turn: string | BuilderTurn): BuilderTurn => (typeof turn === 'string' ? { message: turn } : turn);

const CONTEXT_SEPARATOR = '\n\n---\n\n';

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

export function createServerBuilder(threadId: string, fetchImpl?: FetchLike, model?: string): BuilderAgent {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async send(turn, handlers, signal) {
      const { message, contextBlock } = asTurn(turn);
      // Subscription mode: the context rides inside the wire message (the hub server
      // and its thread store stay unchanged; it keeps its own text history).
      const wireMessage = contextBlock !== undefined ? `${contextBlock}${CONTEXT_SEPARATOR}${message}` : message;
      let response: Response;
      try {
        response = await doFetch('/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ message: wireMessage, threadId, ...(model !== undefined ? { model } : {}) }),
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
          } else if (event.event === 'step') {
            // Tool name + phase only (the server sends nothing else). A malformed step
            // is skipped like any other bad block — one bad event never kills a build.
            if (typeof data.tool === 'string' && (data.phase === 'start' || data.phase === 'end')) {
              handlers.onStep?.({ tool: data.tool, phase: data.phase });
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

// ------------------------------------------------- direct mode (byok / local)

export interface DirectBuilderOptions {
  /** byok/local, or the experimental 'webllm' brain (never a persisted mode — AL-07). */
  mode: DirectMode;
  provider: ByokProvider;
  /** Where artifact_write lands — the sink pins the target app host-side (F9). */
  sink: ArtifactSink;
  /** Injectable for tests; defaults to the user-DB secret for the provider. */
  getKey?: (provider: ByokProvider) => Promise<string | undefined>;
  /**
   * An EXPLICIT model override. When absent the model is resolved PER SEND from
   * `appId` + the Settings default (ADR-0036) — so leave it unset in production and
   * pass `appId` instead; this seat exists for the callers that already had one and for
   * tests that want to pin a literal.
   */
  model?: string;
  /**
   * The app this thread is attached to, if any (TASK-20260817). Its per-app model pick
   * routes BOTH the app-attached data-chat lane and the builder lane, which share this
   * one agent — resolved per send so switching model mid-thread takes effect on the next
   * turn rather than after a remount.
   */
  appId?: string;
  localUrl?: string;
  /** Injectable for tests; default reads the F15 confirm-guard store. */
  needsConfirm?: () => boolean;
}

export function createDirectBuilder(options: DirectBuilderOptions): BuilderAgent {
  const readKey = options.getKey ?? getByokKey;
  const needsConfirm = options.needsConfirm ?? ((): boolean => endpointsNeedConfirmStore.get());
  const isWebllm = options.mode === 'webllm';
  // webllm builds run TOOL-FREE (web-llm 0.2.84 function calling is 8B-Hermes-only and
  // forbids custom system prompts — see webllmAdapter.ts): the file-creation layer is
  // replaced by the fenced-HTML instruction, and the artifact is extracted from the
  // reply text after the turn. Blast radius (no KB consult round trip, no
  // schema_apply/app_doc_write) is documented in the task file.
  //
  // TASK-20260812-desktop-auth-awareness P2 (AC1): the assembly is told which shell it
  // serves — on desktop the 95-platform-desktop layer is appended LAST; on web (or with
  // no platform set) the bytes are identical to before the seat existed. ADR-0012 cache
  // note: the system prefix now differs per PLATFORM, but a client's platform never
  // changes mid-session (setPlatform is set-once, before boot), so within any one client
  // the cached prefix stays byte-stable and the per-turn caching discipline holds. The
  // app-chat lanes ride this same assembly (useBuilderChat builds its agent only here),
  // so this is their platform decision altitude too.
  const platform = getPlatform().kind;
  const system = isWebllm
    ? `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform })}${CONTEXT_SEPARATOR}${WEBLLM_BUILD_SUFFIX}`
    : buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform });
  return {
    async send(turn, handlers, signal) {
      const { message, contextBlock, history, tools: toolOverride } = asTurn(turn);
      // F15: an imported/pulled DB is executable config — its endpoint/provider
      // settings must be re-confirmed before ANY direct turn, builder included.
      if (needsConfirm()) {
        return {
          ok: false,
          code: ERROR_CODES.CONSENT_REQUIRED,
          message: 'endpoint settings came from an imported or synced file — confirm them in Settings before building',
          retryable: false,
        };
      }
      // The attached app's PROVIDER pin resolves per send too (TASK-20260821, review
      // finding 7 — same stale-capture class as the model): this memoized agent would
      // otherwise keep routing a mid-thread cross-provider pin to the provider captured
      // at construction. The demo arm's explicit `provider: 'mock'` and every test's
      // explicit construction stay untouched — the pin only overrides byok with an app.
      const provider =
        options.mode === 'byok' && options.provider !== 'mock' && options.appId !== undefined
          ? (appProviderPinFor(options.appId) ?? options.provider)
          : options.provider;
      // local talks to an unauthenticated endpoint; webllm runs IN the page — neither
      // reads a provider key.
      const key = options.mode === 'local' || isWebllm ? undefined : await readKey(provider);
      // PER SEND, never at construction — useBuilderChat memoizes this agent, so a model
      // captured here at creation would freeze the thread on whatever was chosen when the
      // view mounted. An explicit `options.model` still wins (test pins, existing callers).
      const model = options.model ?? resolveModelForApp(options.appId);
      // ONE config object feeds both the provenance stamp and the constructor
      // (ADR-0059 rule 2): building them from separate spreads is how a stamp
      // starts lying about the route.
      const adapterConfig = {
        mode: options.mode,
        provider,
        ...(key !== undefined ? { key } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(options.localUrl !== undefined ? { localUrl: options.localUrl } : {}),
      };
      handlers.onBrain?.(adapterKindFor(routeOf(adapterConfig)));
      const adapter = createTurnAdapter(adapterConfig, 'chat');
      // Tool-free in webllm mode: `runAgentTurn` treats an empty list as JSON-only
      // mode and offers the adapter NO tools (which would refuse them anyway).
      const tools: AgentTool[] = isWebllm
        ? []
        : toolOverride !== undefined
        ? toolOverride
        : buildByokTools(options.sink, {
            onArtifact: (artifact) =>
              handlers.onArtifact?.({ artifactId: artifact.id, displayName: artifact.displayName, version: artifact.version }),
            onSchemaApplied: () => handlers.onKnowledge?.(),
            onDocWritten: () => handlers.onKnowledge?.(),
          });
      const activityLabels: Record<string, string> = {
        artifact_write: 'writing the app file…',
        schema_apply: 'designing the app’s database…',
        app_doc_write: 'updating the app’s docs…',
      };
      const result = await runAgentTurn({
        adapter,
        // The app-attached context (code, schema, docs) rides as a per-turn system
        // suffix; the base layers stay byte-stable for the golden assembly tests.
        system: contextBlock !== undefined ? `${system}${CONTEXT_SEPARATOR}${contextBlock}` : system,
        messages: [...(history ?? []), { role: 'user', content: message }],
        tools,
        // AC12's direct-mode half: this is the BUILDER turn — a large system prompt plus
        // a fixed tool list, repeated across a build. The app-frame transport (the other
        // runAgentTurn call site) deliberately does not opt in (D0/Q2).
        //
        // Note the per-turn context suffix above lands at the END of `system`, after the
        // byte-stable base layers, so the cached prefix survives it.
        cache: true,
        signal,
        onDelta: (delta) => handlers.onDelta?.(delta),
        onEvent: (event) => {
          if (event.type === 'tool_call') {
            handlers.onActivity?.(activityLabels[event.call.name] ?? 'consulting the knowledge base…');
            handlers.onStep?.({ tool: event.call.name, phase: 'start' });
          } else if (event.type === 'tool_result') {
            // Previously received and dropped — completion is what makes the timeline
            // a timeline rather than a list of things that merely started (AC10).
            handlers.onStep?.({ tool: event.call.name, phase: 'end' });
          }
          // Every event reaches the inspector, including the tool ones above: tools
          // nest under the round trip that requested them, each with its own time (AC5).
          handlers.onLlmEvent?.(event);
        },
      });
      if (signal.aborted) return cancelled();
      if (result.ok && isWebllm) {
        // The webllm "artifact_write": a complete single-file document in the reply
        // is the app (see appHtml.ts). A failed sink write must not destroy the reply
        // text — the user keeps the code in chat, and the next build can retry.
        const extracted = extractAppHtml(result.text);
        if (extracted !== undefined) {
          try {
            const written = await options.sink.write(extracted.html, extracted.title);
            handlers.onArtifact?.({
              artifactId: written.id,
              displayName: written.displayName,
              version: written.version,
            });
          } catch {
            // Reply text survives; the artifact card simply does not appear.
          }
        }
      }
      return result.ok
        ? { ok: true, text: result.text }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}
