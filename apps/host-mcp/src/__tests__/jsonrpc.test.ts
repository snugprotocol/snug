// The stdio JSON-RPC framing (D-B2′: hand-rolled, the `apps/whatsapp-sidecar/src/server.ts`
// precedent — a small auditable parser for a surface of five methods, rather than an SDK
// whose runtime half is HTTP transports and auth this process never uses).
//
// Every case here is about a frame that is NOT well-formed, because that is the half a
// reference client never exercises: the interop test (mcp-interop.test.ts) proves the happy
// path against the real SDK client, and these prove what happens to everything else.

import { describe, expect, it, vi } from 'vitest';

import { createLineFramer, MAX_RPC_LINE_BYTES, parseRpcMessage } from '../mcp/jsonrpc.js';

describe('createLineFramer — newline-delimited JSON over a stream', () => {
  it('emits one message per complete line', () => {
    const seen: string[] = [];
    const framer = createLineFramer((line) => seen.push(line));
    framer.push(Buffer.from('{"a":1}\n{"b":2}\n'));
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds a partial line until its newline arrives — a chunk boundary is not a message boundary', () => {
    const seen: string[] = [];
    const framer = createLineFramer((line) => seen.push(line));
    framer.push(Buffer.from('{"a":'));
    expect(seen).toEqual([]);
    framer.push(Buffer.from('1}\n'));
    expect(seen).toEqual(['{"a":1}']);
  });

  it('splits a multi-byte character across chunks without corrupting it', () => {
    // A naive `chunk.toString()` per chunk mangles any UTF-8 sequence that straddles the
    // boundary — the app's display names and an instructions string are not ASCII.
    const seen: string[] = [];
    const framer = createLineFramer((line) => seen.push(line));
    const bytes = Buffer.from('{"s":"é"}\n', 'utf8');
    framer.push(bytes.subarray(0, 6));
    framer.push(bytes.subarray(6));
    expect(seen).toEqual(['{"s":"é"}']);
  });

  it('tolerates \\r\\n and blank lines', () => {
    const seen: string[] = [];
    const framer = createLineFramer((line) => seen.push(line));
    framer.push(Buffer.from('{"a":1}\r\n\n{"b":2}\n'));
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('REFUSES a line above the cap instead of buffering it — an unbounded peer must not exhaust us', () => {
    const seen: string[] = [];
    const onOverflow = vi.fn();
    const framer = createLineFramer((line) => seen.push(line), { onOverflow });
    framer.push(Buffer.from('x'.repeat(MAX_RPC_LINE_BYTES + 1)));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    // and it RESYNCS at the next newline rather than treating the tail as a message
    framer.push(Buffer.from('rest-of-the-giant-line\n{"a":1}\n'));
    expect(seen).toEqual(['{"a":1}']);
  });
});

describe('parseRpcMessage — what a malformed frame becomes', () => {
  it('reads a well-formed request', () => {
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      kind: 'request',
      id: 1,
      method: 'ping',
      params: undefined,
    });
  });

  it('reads a notification (no id) as a notification, never as a request', () => {
    // The distinction is load-bearing: a notification must never be answered, and an
    // answered notification is a protocol violation the client may drop the session over.
    expect(parseRpcMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({
      kind: 'notification',
      method: 'notifications/initialized',
      params: undefined,
    });
  });

  it('maps unparseable JSON to -32700', () => {
    expect(parseRpcMessage('{not json')).toEqual({ kind: 'error', code: -32700 });
  });

  it('maps a valid JSON non-object to -32600', () => {
    expect(parseRpcMessage('[]')).toEqual({ kind: 'error', code: -32600 });
    expect(parseRpcMessage('"hello"')).toEqual({ kind: 'error', code: -32600 });
  });

  it('maps a missing or non-string method to -32600', () => {
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":1}')).toEqual({ kind: 'error', code: -32600, id: 1 });
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":1,"method":7}')).toEqual({ kind: 'error', code: -32600, id: 1 });
  });

  it('carries the id back on an error so the client can settle its promise', () => {
    // Without the id the caller waits forever; with it the failure is attributable.
    const parsed = parseRpcMessage('{"jsonrpc":"2.0","id":"abc","method":null}');
    expect(parsed).toEqual({ kind: 'error', code: -32600, id: 'abc' });
  });

  it('accepts a string id as well as a number — the spec allows both', () => {
    expect(parseRpcMessage('{"jsonrpc":"2.0","id":"x1","method":"ping"}')).toMatchObject({ kind: 'request', id: 'x1' });
  });
});
