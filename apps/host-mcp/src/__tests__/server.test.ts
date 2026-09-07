// The five methods (ADR-0068 §4). The interop test drives the real SDK client against the
// built bundle; this one covers the shapes a well-behaved client never sends.

import { describe, expect, it, vi } from 'vitest';

import { createMcpServer, SUPPORTED_PROTOCOL_VERSIONS } from '../mcp/server.js';

const server = (callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))) => ({
  mcp: createMcpServer({ callTool }),
  callTool,
});

const send = async (line: string): Promise<Record<string, unknown> | undefined> => {
  const answer = await server().mcp.handleLine(line);
  return answer === undefined ? undefined : (JSON.parse(answer) as Record<string, unknown>);
};

const rpc = (method: string, params?: unknown, id: number | string = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

describe('initialize', () => {
  it('echoes a protocol version it supports', async () => {
    const out = await send(rpc('initialize', { protocolVersion: '2024-11-05' }));
    expect((out?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
  });

  it('answers its own newest version when the client asks for one it does not know', async () => {
    // Silently agreeing to an unimplemented version is worse than naming ours.
    const out = await send(rpc('initialize', { protocolVersion: '1999-01-01' }));
    expect((out?.result as { protocolVersion: string }).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('declares the tools capability and carries the launch protocol', async () => {
    const out = await send(rpc('initialize', {}));
    const result = out?.result as { capabilities: Record<string, unknown>; instructions: string };
    expect(result.capabilities).toHaveProperty('tools');
    expect(result.instructions).toMatch(/snug_status/);
  });
});

describe('the dispatcher', () => {
  it('lists exactly the allowlisted tools', async () => {
    const out = await send(rpc('tools/list'));
    const names = (out?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names.sort()).toEqual(['snug_hand_in', 'snug_list_apps', 'snug_open', 'snug_status']);
  });

  it('answers ping', async () => {
    expect(await send(rpc('ping'))).toMatchObject({ result: {} });
  });

  it('refuses an unknown method with -32601', async () => {
    expect((await send(rpc('resources/list')))?.error).toMatchObject({ code: -32601 });
  });

  it('refuses a tool that is not on the allowlist, by name', async () => {
    const out = await send(rpc('tools/call', { name: 'snug_fetch', arguments: {} }));
    expect(out?.error).toMatchObject({ code: -32601 });
    expect(JSON.stringify(out)).toMatch(/snug_fetch/);
  });

  it('runs an allowlisted tool', async () => {
    const s = server();
    const answer = await s.mcp.handleLine(rpc('tools/call', { name: 'snug_status', arguments: {} }));
    expect(s.callTool).toHaveBeenCalledWith('snug_status', {});
    expect(JSON.parse(answer!)).toMatchObject({ result: { content: [{ text: 'ok' }] } });
  });

  it('turns a throwing tool into an isError RESULT, never a dropped session', async () => {
    const s = server(vi.fn(async () => { throw new Error('the runner is not open'); }));
    const answer = await s.mcp.handleLine(rpc('tools/call', { name: 'snug_open', arguments: {} }));
    expect(JSON.parse(answer!)).toMatchObject({ result: { isError: true, content: [{ text: 'the runner is not open' }] } });
  });
});

describe('notifications are never answered', () => {
  it('stays silent on notifications/initialized', async () => {
    expect(await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeUndefined();
  });

  it('stays silent on an unknown notification', async () => {
    expect(await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }))).toBeUndefined();
  });

  it('stays silent on a malformed line that carries no id', async () => {
    // Answering with id:null would be a reply to something nobody asked.
    expect(await send('{not json')).toBeUndefined();
  });

  it('DOES answer a malformed request that carries an id', async () => {
    const out = await send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 42 }));
    expect(out).toMatchObject({ id: 7, error: { code: -32600 } });
  });
});

describe('attach', () => {
  it('reads a stream and writes one reply per request', async () => {
    const written: string[] = [];
    const listeners: Array<(chunk: Uint8Array) => void> = [];
    const input = { on: (_e: 'data', l: (chunk: Uint8Array) => void) => listeners.push(l) };
    server().mcp.attach(input, (line) => written.push(line));
    listeners[0]!(new TextEncoder().encode(`${rpc('ping')}\n${rpc('ping', undefined, 2)}\n`));
    await new Promise((r) => setTimeout(r, 10));
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[1]!)).toMatchObject({ id: 2 });
  });
});
