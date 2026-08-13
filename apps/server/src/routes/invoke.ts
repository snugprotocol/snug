// routes/invoke.ts — POST /invoke (SSE). C1 boundary FIRST: inbound credential headers
// are stripped from the request context before anything else runs, and nothing derived
// from request headers is ever placed in an adapter-bound payload; app-request
// envelopes whose payload/state carry high-confidence credential values are rejected
// with a typed 400 before any model sees them.
//
// SSE contract (consumed by createHttpTransport and the playground):
//   event: delta     data: {"text": "<delta>"}
//   event: artifact  data: {"artifactId": "...", "displayName": "..."}
//   event: done      data: {"text": "<full assistant text>"}
//   event: error     data: {"code": "...", "message": "...", "retryable": bool}
//   plus `:hb` comment heartbeats every heartbeatMs.

import { runAgentTurn, type AdapterMessage, type AgentAdapter } from '@snugprotocol/adapters';
import { buildHostSystemPrompt, renderRuntimeContract, SYSTEM_BLOCK_SEPARATOR } from '@snugprotocol/knowledge';
import {
  ERROR_CODES,
  LIMITS,
  parseAppRequest,
  runtimeContractSchema,
  scanForCredentialValues,
  stripCredentialHeaders,
} from '@snugprotocol/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { RateLimiter } from '../rate-limit.js';
import type { ArtifactStore } from '../stores/artifacts.js';
import type { ThreadStore } from '../stores/threads.js';
import { buildServerTools } from '../tools.js';

export interface InvokeRouteDeps {
  adapter: AgentAdapter;
  /**
   * Subscription-mode model choice (TASK-20260803-serverless-run): builds an adapter
   * for a validated per-request `model` override. Absent → `model` is accepted but
   * served by the default adapter.
   */
  makeAdapter?: (model: string) => AgentAdapter;
  artifacts: ArtifactStore;
  threads: ThreadStore;
  heartbeatMs: number;
  rateLimiter: RateLimiter;
  maxIterations?: number;
}

const invokeBodySchema = z.object({
  message: z.string().min(1),
  threadId: z.string().min(1).max(LIMITS.ID_CHARS).optional(),
  model: z.string().min(1).max(128).optional(),
  /**
   * The app's runtime contract, for subscription mode (ADR-0018 D3, fold F-M3).
   *
   * The hub is STATELESS about apps — it has no user DB and cannot look a contract up —
   * so for a synced or exported app this is the only channel by which its contract can
   * reach the model. That makes it CLIENT-CONTROLLED SYSTEM CONTENT, and it is treated
   * accordingly: parsed with the real `runtimeContractSchema` (strict, fully bounded, so
   * an over-bound or extra-field contract is a 400 rather than a silent truncation), and
   * covered by the C1 credential scan below like every other client-supplied field.
   *
   * JSON only — never rendered text. The ONE renderer lives in `packages/knowledge` and
   * serves both this call site and the playground's, so the contract can never exist as
   * two hand-maintained renderings.
   */
  contract: runtimeContractSchema.optional(),
});

export function registerInvokeRoute(app: FastifyInstance, deps: InvokeRouteDeps): void {
  /** Optimistic per-thread in-flight lock: a second /invoke on the same thread → 409. */
  const inFlight = new Set<string>();

  app.post('/invoke', async (request, reply) => {
    // --- C1 boundary, before anything else -------------------------------------
    // The ONLY request-derived context that survives this point is `safeHeaders`
    // (credential headers removed); adapter-bound payloads are built exclusively
    // from the validated body, thread history, and the knowledge store below.
    const safeHeaders = stripCredentialHeaders(normalizeHeaders(request.headers));
    request.log.debug({ headers: Object.keys(safeHeaders) }, 'invoke');

    if (!deps.rateLimiter.take(request.ip)) {
      return reply.status(429).send({
        code: 'RATE_LIMITED',
        message: 'too many requests from this address — slow down and retry',
        retryable: true,
      });
    }

    const parsedBody = invokeBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({
        code: 'BAD_REQUEST',
        message: `body must be {message, threadId?}: ${parsedBody.error.issues.map((i) => i.message).join('; ')}`,
        retryable: false,
      });
    }
    const { message, threadId, model, contract } = parsedBody.data;
    const turnDeps: InvokeRouteDeps =
      model !== undefined && deps.makeAdapter !== undefined ? { ...deps, adapter: deps.makeAdapter(model) } : deps;

    const appRequest = parseAppRequest(message);
    if (appRequest.ok) {
      // C1 value scan over the ENTIRE parsed envelope — the app path streams the raw
      // wire string to the adapter, so every field (payload, state, responseSchema,
      // ids, action) is LLM-bound. High-confidence rejects only: key-name-only hits
      // like {token:'rook'} are warnings, never rejects.
      // Defense in depth: the scan covers the CONTRACT as well as the envelope (fold
      // F-Sm3a). The contract is bound for the system slot, which is the most trusted
      // position in the request — a credential reaching it would be the worst case of
      // the leak this scan exists to stop.
      const scan = scanForCredentialValues({ envelope: appRequest.envelope, ...(contract !== undefined ? { contract } : {}) });
      if (scan.rejects.length > 0) {
        return reply.status(400).send({
          code: 'CREDENTIAL_REJECTED',
          message: `credential-shaped value in envelope at: ${scan.rejects
            .map((finding) => `${finding.path} (${finding.reason})`)
            .join(', ')}`,
          retryable: false,
        });
      }
      // App path: envelope is self-contained — NO thread history, JSON-only (no tools),
      // raw passthrough (the runner parses the reply; the server never does).
      // The RUNTIME assembly (ADR-0018 D1), with the contract appended as a system
      // SUFFIX after the stable layers (ADR-0012's end-of-system rule). The app-builder
      // layers no longer ride app turns in ANY mode.
      // No platform seat, deliberately: /invoke is the hub (web) path — the desktop shell is direct-mode only and never calls it (TASK-20260812 P2).
      const runtimeSystem = buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true });
      return streamTurn(reply, turnDeps, {
        system:
          contract === undefined
            ? runtimeSystem
            : `${runtimeSystem}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`,
        messages: [{ role: 'user', content: message }],
        withTools: false,
        // Owner rule (TASK-20260812 AC1): a request carrying a responseSchema is NEVER
        // bound by the contract's maxOutputTokens — a structured reply cut off mid-JSON
        // is unparseable, and the runner bridge would blame the model for the cap.
        ...(appRequest.envelope.responseSchema === undefined && contract?.maxOutputTokens !== undefined
          ? { maxOutputTokens: contract.maxOutputTokens }
          : {}),
      });
    }

    // Chat path: thread history + app-builder/artifact tools.
    if (threadId !== undefined) {
      if (inFlight.has(threadId)) {
        return reply.status(409).send({
          code: ERROR_CODES.THREAD_CONFLICT,
          message: 'another request is in flight for this thread',
          retryable: true,
        });
      }
      inFlight.add(threadId);
    }
    try {
      const history: AdapterMessage[] =
        threadId === undefined ? [] : deps.threads.history(threadId).map((m) => ({ role: m.role, content: m.content }));
      return await streamTurn(reply, turnDeps, {
        // No platform seat, deliberately: /invoke is the hub (web) path — the desktop shell is direct-mode only and never calls it (TASK-20260812 P2).
        system: buildHostSystemPrompt({ appBuilder: true, artifacts: true }),
        messages: [...history, { role: 'user', content: message }],
        withTools: true,
        persist:
          threadId === undefined
            ? undefined
            : (text) => {
                deps.threads.append(threadId, { role: 'user', content: message });
                deps.threads.append(threadId, { role: 'assistant', content: text });
              },
      });
    } finally {
      if (threadId !== undefined) inFlight.delete(threadId);
    }
  });
}

interface TurnPlan {
  system: string;
  messages: AdapterMessage[];
  /**
   * Tools offered on this turn — and, because the two coincide exactly, the
   * discriminator for prompt caching (AC12).
   *
   * `true` is the BUILDER path: a large system prompt plus a fixed tool list, repeated
   * many times within one build — the shape caching pays off on, and the highest-value
   * caching path in the product since every hub user's turns share that prefix.
   * `false` is the APP-FRAME path: short self-contained envelopes (a Chess move) below
   * the model-dependent minimum, where a breakpoint would pay a 1.25x write premium on a
   * prefix that is never read (D0/Q2).
   *
   * Derived rather than a separate flag so the two can never drift apart.
   */
  withTools: boolean;
  /**
   * Per-turn output ceiling from the app's runtime contract (ADR-0018 D4). App path only,
   * and only when the contract asks for one — absent leaves today's default exactly, so a
   * contract-less app is never silently truncated (AC-F1-4).
   */
  maxOutputTokens?: number;
  /** Called with the final text on success (chat path with a threadId). */
  persist?: (text: string) => void;
}

async function streamTurn(reply: FastifyReply, deps: InvokeRouteDeps, plan: TurnPlan): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  // Preserve headers set by plugins (CORS) — hijack bypasses fastify's serialization.
  raw.writeHead(200, {
    ...collectHeaders(reply),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown): void => {
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => raw.write(':hb\n\n'), deps.heartbeatMs);

  const abort = new AbortController();
  let settled = false;
  raw.on('close', () => {
    if (!settled) abort.abort(); // client went away mid-turn — stop the adapter
  });

  try {
    const result = await runAgentTurn({
      adapter: deps.adapter,
      system: plan.system,
      messages: plan.messages,
      tools: plan.withTools
        ? buildServerTools(deps.artifacts, {
            onArtifact: (artifact) => send('artifact', { artifactId: artifact.id, displayName: artifact.displayName }),
          })
        : [],
      maxIterations: deps.maxIterations,
      // Builder turns only — never the app-frame envelopes (AC12, D0/Q2).
      ...(plan.withTools ? { cache: true } : {}),
      ...(plan.maxOutputTokens !== undefined ? { maxOutputTokens: plan.maxOutputTokens } : {}),
      signal: abort.signal,
      onDelta: (delta) => send('delta', { text: delta }),
      // Progress for the client's step timeline. Tool NAME and phase only — never the
      // tool input or output, which carry prompt content (mirrors the runner
      // inspector's structural-only rule). `round_trip` stays server-side.
      onEvent: (event) => {
        if (event.type === 'tool_call') send('step', { phase: 'start', tool: event.call.name });
        else if (event.type === 'tool_result') send('step', { phase: 'end', tool: event.call.name });
      },
    });
    settled = true;
    if (result.ok) {
      plan.persist?.(result.text);
      // stopReason lets the client's bridge tell a cap-truncated reply from model
      // non-compliance (TASK-20260812 AC3); older clients ignore the extra field.
      send('done', { text: result.text, stopReason: result.stopReason });
    } else {
      send('error', { code: result.code, message: result.message, retryable: result.retryable });
    }
  } catch (err) {
    // runAgentTurn returns errors as data; this is a last-resort guard.
    settled = true;
    send('error', {
      code: ERROR_CODES.HOST_ERROR,
      message: err instanceof Error ? err.message : 'internal error',
      retryable: false,
    });
  } finally {
    clearInterval(heartbeat);
    raw.end();
  }
}

function normalizeHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}

function collectHeaders(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (typeof value === 'string') out[name] = value;
    else if (typeof value === 'number') out[name] = String(value);
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}
