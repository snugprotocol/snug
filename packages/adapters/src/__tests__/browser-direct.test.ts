// Child-2 ACs 3,4 (TASK-20260803-serverless-run): browser-direct provider calls.
// anthropic must send the CORS opt-in header (BYOK runs in the page, ADR-0008);
// the local adapter targets an OpenAI-compatible localhost endpoint and turns bare
// network failures into actionable Ollama CORS / mixed-content guidance (F17).
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../anthropic.js';
import { localAdapter, LOCAL_DEFAULT_BASE_URL } from '../local.js';
import type { FetchLike } from '../types.js';

const sseOk = (): Response =>
  new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

describe('anthropic browser-direct header (AC3)', () => {
  it('sends anthropic-dangerous-direct-browser-access on every request', async () => {
    let captured: Record<string, string> | undefined;
    const fetch: FetchLike = (_input, init) => {
      captured = init?.headers as Record<string, string>;
      return Promise.resolve(sseOk());
    };
    const adapter = anthropicAdapter({ apiKey: 'k', fetch });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(captured?.['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});

describe('local adapter (AC4)', () => {
  it('targets the configured base URL and model with an OpenAI-compatible request', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const fetch: FetchLike = (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const adapter = localAdapter({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', fetch });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(body.model).toBe('llama3.2');
  });

  it('defaults to the Ollama endpoint and needs no real API key', async () => {
    let auth: string | undefined;
    const fetch: FetchLike = (_input, init) => {
      auth = (init?.headers as Record<string, string>).authorization;
      return Promise.resolve(
        new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    };
    const adapter = localAdapter({ fetch });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(LOCAL_DEFAULT_BASE_URL).toBe('http://localhost:11434/v1');
    expect(auth).toBe('Bearer local');
  });

  it('maps network failures to guidance about OLLAMA_ORIGINS and https pages (F17)', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const adapter = localAdapter({ fetch });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('OLLAMA_ORIGINS');
    expect(result.message).toContain('https');
  });
});
