// AC5 — pre-warmed, single-use children (ADR-0069 §5).
//
// Every rule the pool promises has a case here that fails without it: a virgin child gets
// nothing until it is acquired; a child answers exactly one request and is reaped; the next
// request for the same system prompt finds a warm child; the count is capped by LRU; an
// idle virgin is reaped; stop reaps everything; only text deltas are forwarded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeSession, POOL_IDLE_MS, POOL_MAX_WARM, poolKey, SessionPool, userMessageLine } from '../brain-session.js';
import { delta, fakeSpawner, FakeClaudeChild, line, result, thinkingDelta } from './fixtures/fake-claude-child.js';

const argsFor = (system: string): string[] => ['-p', '--system-prompt', system];
const ENV = { HOME: '/Users/x', PATH: '/usr/bin' };

const pool = (spawnChild: ReturnType<typeof fakeSpawner>['spawnChild'], over: Partial<ConstructorParameters<typeof SessionPool>[0]> = {}) =>
  new SessionPool({ spawnChild, argsFor, env: ENV, ...over });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ClaudeSession — one child, one request', () => {
  it('sends ONE stream-json user message and resolves on the result, streaming the deltas in order', async () => {
    const child = new FakeClaudeChild([], ENV);
    const session = new ClaudeSession(child);
    const seen: string[] = [];
    const answer = await session.send('ping', { onDelta: (t) => seen.push(t) });
    expect(child.messages()).toHaveLength(1);
    expect(child.messages()[0]?.message.content[0]?.text).toBe('ping');
    expect(seen).toEqual(['pong']);
    expect(answer).toEqual({ text: 'pong', stopReason: 'end_turn' });
  });

  it('forwards text deltas ONLY — a thinking delta stays private, and the assistant echo is not repeated', async () => {
    const child = new FakeClaudeChild([], ENV, {
      lines: [thinkingDelta('let me think'), delta('a'), delta('b'), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ab' }] } }), result('ab')],
    });
    const seen: string[] = [];
    const answer = await new ClaudeSession(child).send('x', { onDelta: (t) => seen.push(t) });
    expect(seen).toEqual(['a', 'b']);
    expect(seen.join('')).not.toContain('think');
    expect(answer.text).toBe('ab');
  });

  it('falls back to the result text when the CLI streamed no deltas', async () => {
    const child = new FakeClaudeChild([], ENV, { lines: [result('whole answer')] });
    const answer = await new ClaudeSession(child).send('x', { onDelta: () => {} });
    expect(answer.text).toBe('whole answer');
  });

  it('rejects an is_error result with the CLI’s own words', async () => {
    const child = new FakeClaudeChild([], ENV, { lines: [result('Not logged in · Please run /login', { is_error: true })] });
    await expect(new ClaudeSession(child).send('x', { onDelta: () => {} })).rejects.toThrow(/login/);
  });

  it('rejects when the child exits before answering, with the stderr tail', async () => {
    const child = new FakeClaudeChild([], ENV, { silent: true });
    const session = new ClaudeSession(child);
    const pending = session.send('x', { onDelta: () => {} });
    child.stderr.write('boom: quota exhausted');
    await flush();
    child.exit(1);
    await expect(pending).rejects.toThrow(/exited.*quota exhausted/);
  });

  it('refuses a second request — a session is single-use by contract', async () => {
    const child = new FakeClaudeChild([], ENV);
    const session = new ClaudeSession(child);
    await session.send('one', { onDelta: () => {} });
    await expect(session.send('two', { onDelta: () => {} })).rejects.toThrow(/exactly one/);
  });

  it('kill() TERMs the child and fails a pending request as aborted', async () => {
    const child = new FakeClaudeChild([], ENV, { silent: true });
    const session = new ClaudeSession(child);
    const pending = session.send('x', { onDelta: () => {} });
    session.kill();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(child.kills[0]).toBe('SIGTERM');
  });

  it('reads a line split across chunks', async () => {
    const child = new FakeClaudeChild([], ENV, { silent: true });
    const session = new ClaudeSession(child);
    const seen: string[] = [];
    const pending = session.send('x', { onDelta: (t) => seen.push(t) });
    const whole = delta('hello') + result('hello');
    child.stdout.write(whole.slice(0, 20));
    await flush();
    child.stdout.write(whole.slice(20));
    await expect(pending).resolves.toEqual({ text: 'hello', stopReason: 'end_turn' });
    expect(seen).toEqual(['hello']);
  });

  it('the user message is one text block, so a prompt with newlines rides inside one line', () => {
    const text = 'User: a\n\nAssistant: b\n\nUser: c';
    const wire = userMessageLine(text);
    expect(wire.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(JSON.parse(wire)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  });
});

describe('SessionPool — pre-warmed, single-use, bounded', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a virgin child receives NOTHING until it is acquired — pre-warming costs no tokens', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.prewarm(poolKey('S'), 'S');
    expect(children).toHaveLength(1);
    expect(children[0]?.written).toEqual([]);
    p.stop();
  });

  it('the first request for a prompt spawns; the next finds the pre-warmed child and skips the spawn', async () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const first = p.acquire('S');
    // One spawn for the request, one pre-warmed replacement.
    expect(children).toHaveLength(2);
    expect(first.child).toBe(children[0]);
    await first.send('ping', { onDelta: () => {} });
    p.release(first);
    const second = p.acquire('S');
    // The replacement was taken — no third spawn at acquire time…
    expect(second.child).toBe(children[1]);
    // …but a replacement for IT is pre-warmed at once.
    expect(children).toHaveLength(3);
    expect((second.child as FakeClaudeChild).written).toEqual([]);
    p.stop();
  });

  it('a released child is killed — nothing is ever reused after its one request', async () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const session = p.acquire('S');
    await session.send('ping', { onDelta: () => {} });
    p.release(session);
    expect((session.child as FakeClaudeChild).kills).toEqual(['SIGTERM']);
    expect(children[0]?.exited).toBe(true);
    expect(p.stats().live).toBe(0);
    p.stop();
  });

  it('two concurrent requests for the same prompt get two children — a busy child is never shared', () => {
    const { spawnChild } = fakeSpawner();
    const p = pool(spawnChild);
    const a = p.acquire('S');
    const b = p.acquire('S');
    expect(a).not.toBe(b);
    expect(a.child).not.toBe(b.child);
    p.stop();
  });

  it('keeps at most maxWarm pre-warmed keys, evicting the least recently used', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild, { maxWarm: 2 });
    p.prewarm(poolKey('A'), 'A');
    p.prewarm(poolKey('B'), 'B');
    // Touch A so B is the oldest.
    p.prewarm(poolKey('A'), 'A');
    p.prewarm(poolKey('C'), 'C');
    expect(p.stats().warm).toBe(2);
    // B (the LRU) was killed; A and C stand.
    expect(children.map((c) => c.args[2])).toEqual(['A', 'B', 'C']);
    expect(children[1]?.exited).toBe(true);
    expect(children[0]?.exited).toBe(false);
    expect(children[2]?.exited).toBe(false);
    p.stop();
  });

  it('reaps a virgin child that idles past the TTL', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild, { idleMs: 1_000 });
    p.prewarm(poolKey('S'), 'S');
    vi.advanceTimersByTime(999);
    expect(children[0]?.exited).toBe(false);
    vi.advanceTimersByTime(2);
    expect(children[0]?.exited).toBe(true);
    expect(p.stats().warm).toBe(0);
  });

  it('stop() reaps every child, warm and live, and refuses further acquires', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.acquire('S'); // live + a warm replacement
    p.prewarm(poolKey('T'), 'T');
    p.stop();
    expect(children.every((c) => c.exited)).toBe(true);
    expect(p.stats()).toEqual({ warm: 0, live: 0 });
    expect(() => p.acquire('S')).toThrow(/stopping/);
  });

  it('a pre-warmed child that died on its own is not handed out — the request gets a fresh spawn', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.prewarm(poolKey('S'), 'S');
    children[0]?.exit(1);
    const session = p.acquire('S');
    expect(session.child).not.toBe(children[0]);
    expect(session.alive).toBe(true);
    p.stop();
  });

  it('the defaults are the measured ones: two keys, five minutes', () => {
    expect(POOL_MAX_WARM).toBe(2);
    expect(POOL_IDLE_MS).toBe(5 * 60_000);
  });

  it('keys by the system prompt, so a different contract never finds another app’s child', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.acquire('contract A');
    const b = p.acquire('contract B');
    expect((b.child as FakeClaudeChild).args).toContain('contract B');
    // A's replacement was not taken by B.
    expect(children.filter((c) => c.args.includes('contract A') && !c.exited)).toHaveLength(2);
    p.stop();
  });
});
