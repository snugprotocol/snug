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
import { buildHostSystemPrompt } from '@snugprotocol/knowledge';
import {
  ERROR_CODES,
  LIMITS,
  parseAppRequest,
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
  artifacts: ArtifactStore;
  threads: ThreadStore;
  heartbeatMs: number;
  rateLimiter: RateLimiter;
  maxIterations?: number;
}

const invokeBodySchema = z.object({
  message: z.string().min(1),
  threadId: z.string().min(1).max(LIMITS.ID_CHARS).optional(),
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
    const { message, threadId } = parsedBody.data;

    const appRequest = parseAppRequest(message);
    if (appRequest.ok) {
      // C1 value scan over the ENTIRE parsed envelope — the app path streams the raw
      // wire string to the adapter, so every field (payload, state, responseSchema,
      // ids, action) is LLM-bound. High-confidence rejects only: key-name-only hits
      // like {token:'rook'} are warnings, never rejects.
      const scan = scanForCredentialValues(appRequest.envelope);
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
      return streamTurn(reply, deps, {
        system: buildHostSystemPrompt({ appBuilder: true, artifacts: false }),
        messages: [{ role: 'user', content: message }],
        withTools: false,
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
      return await streamTurn(reply, deps, {
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
  withTools: boolean;
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
      signal: abort.signal,
      onDelta: (delta) => send('delta', { text: delta }),
    });
    settled = true;
    if (result.ok) {
      plan.persist?.(result.text);
      send('done', { text: result.text });
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
