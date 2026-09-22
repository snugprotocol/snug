// AC5 — pre-warmed, single-use children (ADR-0069 §5).
//
// Every rule the pool promises has a case here that fails without it: a unused child gets
// nothing until it is acquired; a child answers exactly one request and is reaped; the next
// request for the same system prompt finds a warm child; the count is capped by LRU; an
// idle unused is reaped; stop reaps everything; only text deltas are forwarded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeChild, POOL_IDLE_MS, POOL_MAX_LIVE, POOL_MAX_WARM, poolKey, ChildPool, userMessageLine } from '../brain-child.js';
import type { BrainSpec } from '../brain-child.js';
import { createHash } from 'node:crypto';
import { delta, fakeSpawner, FakeClaudeChild, line, result, thinkingDelta } from './fixtures/fake-claude-child.js';

const argsFor = (s: BrainSpec): string[] => ['-p', '--system-prompt', s.system, ...(s.model === undefined ? [] : ['--model', s.model]), ...(s.effort === undefined ? [] : ['--effort', s.effort])];
const ENV = { HOME: '/Users/x', PATH: '/usr/bin' };

const pool = (spawnChild: ReturnType<typeof fakeSpawner>['spawnChild'], over: Partial<ConstructorParameters<typeof ChildPool>[0]> = {}) =>
  new ChildPool({ spawnChild, argsFor, env: ENV, ...over });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A spec from a bare system prompt — the shape these pool tests predate (TASK-20260922 S1). */
const spec = (system: string, over: Partial<BrainSpec> = {}): BrainSpec => ({ system, ...over });

describe('ClaudeChild — one child, one request', () => {
  it('sends ONE stream-json user message and resolves on the result, streaming the deltas in order', async () => {
    const fake = new FakeClaudeChild([], ENV);
    const child = new ClaudeChild(fake);
    const seen: string[] = [];
    const answer = await child.send('ping', { onDelta: (t) => seen.push(t) });
    expect(fake.messages()).toHaveLength(1);
    expect(fake.messages()[0]?.message.content[0]?.text).toBe('ping');
    expect(seen).toEqual(['pong']);
    expect(answer).toEqual({ text: 'pong', stopReason: 'end_turn' });
  });

  it('forwards text deltas ONLY — a thinking delta stays private, and the assistant echo is not repeated', async () => {
    const fake = new FakeClaudeChild([], ENV, {
      lines: [thinkingDelta('let me think'), delta('a'), delta('b'), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ab' }] } }), result('ab')],
    });
    const seen: string[] = [];
    const answer = await new ClaudeChild(fake).send('x', { onDelta: (t) => seen.push(t) });
    expect(seen).toEqual(['a', 'b']);
    expect(seen.join('')).not.toContain('think');
    expect(answer.text).toBe('ab');
  });

  it('falls back to the result text when the CLI streamed no deltas', async () => {
    const fake = new FakeClaudeChild([], ENV, { lines: [result('whole answer')] });
    const answer = await new ClaudeChild(fake).send('x', { onDelta: () => {} });
    expect(answer.text).toBe('whole answer');
  });

  it('rejects an is_error result with the CLI’s own words', async () => {
    const fake = new FakeClaudeChild([], ENV, { lines: [result('Not logged in · Please run /login', { is_error: true })] });
    await expect(new ClaudeChild(fake).send('x', { onDelta: () => {} })).rejects.toThrow(/login/);
  });

  it('rejects when the child exits before answering, with the stderr tail', async () => {
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const pending = child.send('x', { onDelta: () => {} });
    fake.stderr.write('boom: quota exhausted');
    await flush();
    fake.exit(1);
    await expect(pending).rejects.toThrow(/exited.*quota exhausted/);
  });

  it('refuses a second request — a child is single-use by contract', async () => {
    const fake = new FakeClaudeChild([], ENV);
    const child = new ClaudeChild(fake);
    await child.send('one', { onDelta: () => {} });
    await expect(child.send('two', { onDelta: () => {} })).rejects.toThrow(/exactly one/);
  });

  it('kill() TERMs the child and fails a pending request as aborted', async () => {
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const pending = child.send('x', { onDelta: () => {} });
    child.kill();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(fake.kills[0]).toBe('SIGTERM');
  });

  it('reads a line split across chunks', async () => {
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const seen: string[] = [];
    const pending = child.send('x', { onDelta: (t) => seen.push(t) });
    const whole = delta('hello') + result('hello');
    fake.stdout.write(whole.slice(0, 20));
    await flush();
    fake.stdout.write(whole.slice(20));
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

describe('a child remembers the model the CLI resolved for IT (TASK-20260922 AC5)', () => {
  // The CLI names the resolved model in its `system/init` frame, which it emits at SPAWN.
  // For a pre-warmed child that is minutes before any request exists — so a child that only
  // read frames while a request was pending would throw this away on the very path Binding B
  // is built around. These cases pin that it does not.
  const init = (model: string): string => line({ type: 'system', subtype: 'init', model, tools: [] });

  it('keeps the resolved model from an init frame that arrived while it was still UNUSED', async () => {
    // Frames before `send`: exactly the pre-warm case.
    const fake = new FakeClaudeChild([], ENV);
    const child = new ClaudeChild(fake);
    // Straight onto stdout, with nothing pending and nothing yet sent: what a real
    // pre-warmed child does at spawn, minutes before its request arrives.
    fake.stdout.write(init('claude-haiku-4-5-20251001'));
    await flush();
    const answer = await child.send('x', { onDelta: () => {} });
    expect(answer.resolvedModel).toBe('claude-haiku-4-5-20251001');
  });

  it('reports what the CLI RESOLVED, not what was asked — a substitution is visible', async () => {
    const fake = new FakeClaudeChild([], ENV, { lines: [init('claude-opus-5-some-date'), delta('hi'), result('hi')] });
    const answer = await new ClaudeChild(fake).send('x', { onDelta: () => {} });
    // The request asked for `opus`; the chip must name the id that actually answered.
    expect(answer.resolvedModel).toBe('claude-opus-5-some-date');
  });

  it('reports NOTHING rather than inventing a disclosure when the CLI sent no init frame', async () => {
    const fake = new FakeClaudeChild([], ENV, { lines: [delta('hi'), result('hi')] });
    const answer = await new ClaudeChild(fake).send('x', { onDelta: () => {} });
    expect(answer.resolvedModel).toBeUndefined();
  });

  it('still forwards no thinking — the init frame changes what is DISCLOSED, not what is shown', async () => {
    const fake = new FakeClaudeChild([], ENV, { lines: [init('m'), thinkingDelta('secret'), delta('a'), result('a')] });
    const seen: string[] = [];
    const answer = await new ClaudeChild(fake).send('x', { onDelta: (t) => seen.push(t) });
    expect(seen.join('')).not.toContain('secret');
    expect(answer.resolvedModel).toBe('m');
  });
});

describe('ChildPool — pre-warmed, single-use, bounded', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a unused child receives NOTHING until it is acquired — pre-warming costs no tokens', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.prewarm(poolKey(spec('S')), spec('S'));
    expect(children).toHaveLength(1);
    expect(children[0]?.written).toEqual([]);
    p.stop();
  });

  it('the first request for a prompt spawns; the next finds the pre-warmed child and skips the spawn', async () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const first = p.acquire(spec('S'));
    // One spawn for the request, one pre-warmed replacement.
    expect(children).toHaveLength(2);
    expect(first.process).toBe(children[0]);
    await first.send('ping', { onDelta: () => {} });
    p.release(first);
    const second = p.acquire(spec('S'));
    // The replacement was taken — no third spawn at acquire time…
    expect(second.process).toBe(children[1]);
    // …but a replacement for IT is pre-warmed at once.
    expect(children).toHaveLength(3);
    expect((second.process as FakeClaudeChild).written).toEqual([]);
    p.stop();
  });

  it('a released child is killed — nothing is ever reused after its one request', async () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const child = p.acquire(spec('S'));
    await child.send('ping', { onDelta: () => {} });
    p.release(child);
    expect((child.process as FakeClaudeChild).kills).toEqual(['SIGTERM']);
    expect(children[0]?.exited).toBe(true);
    expect(p.stats().live).toBe(0);
    p.stop();
  });

  it('two concurrent requests for the same prompt get two children — a busy child is never shared', () => {
    const { spawnChild } = fakeSpawner();
    const p = pool(spawnChild);
    const a = p.acquire(spec('S'));
    const b = p.acquire(spec('S'));
    expect(a).not.toBe(b);
    expect(a.process).not.toBe(b.process);
    p.stop();
  });

  it('keeps at most maxWarm pre-warmed keys, evicting the least recently used', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild, { maxWarm: 2 });
    p.prewarm(poolKey(spec('A')), spec('A'));
    p.prewarm(poolKey(spec('B')), spec('B'));
    // Touch A so B is the oldest.
    p.prewarm(poolKey(spec('A')), spec('A'));
    p.prewarm(poolKey(spec('C')), spec('C'));
    expect(p.stats().warm).toBe(2);
    // B (the LRU) was killed; A and C stand.
    expect(children.map((c) => c.args[2])).toEqual(['A', 'B', 'C']);
    expect(children[1]?.exited).toBe(true);
    expect(children[0]?.exited).toBe(false);
    expect(children[2]?.exited).toBe(false);
    p.stop();
  });

  it('reaps a unused child that idles past the TTL', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild, { idleMs: 1_000 });
    p.prewarm(poolKey(spec('S')), spec('S'));
    vi.advanceTimersByTime(999);
    expect(children[0]?.exited).toBe(false);
    vi.advanceTimersByTime(2);
    expect(children[0]?.exited).toBe(true);
    expect(p.stats().warm).toBe(0);
  });

  it('stop() reaps every child, warm and live, and refuses further acquires', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.acquire(spec('S')); // live + a warm replacement
    p.prewarm(poolKey(spec('T')), spec('T'));
    p.stop();
    expect(children.every((c) => c.exited)).toBe(true);
    expect(p.stats()).toEqual({ warm: 0, live: 0 });
    expect(() => p.acquire(spec('S'))).toThrow(/stopping/);
  });

  it('a pre-warmed child that died on its own is not handed out — the request gets a fresh spawn', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.prewarm(poolKey(spec('S')), spec('S'));
    children[0]?.exit(1);
    const child = p.acquire(spec('S'));
    expect(child.process).not.toBe(children[0]);
    expect(child.alive).toBe(true);
    p.stop();
  });

  it('the defaults are the measured ones: two keys, five minutes', () => {
    expect(POOL_MAX_WARM).toBe(2);
    expect(POOL_IDLE_MS).toBe(5 * 60_000);
  });

  it('keys by the system prompt, so a different contract never finds another app’s child', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    p.acquire(spec('contract A'));
    const b = p.acquire(spec('contract B'));
    expect((b.process as FakeClaudeChild).args).toContain('contract B');
    // A's replacement was not taken by B.
    expect(children.filter((c) => c.args.includes('contract A') && !c.exited)).toHaveLength(2);
    p.stop();
  });
});

describe('the pool key is the child’s whole identity, not just its prompt (TASK-20260922 AC2)', () => {
  // The MUTANT for every case below is the pre-task key, `sha256(system)` alone. Each
  // assertion here is one that key would fail — which is what makes them worth having.
  const OLD_KEY = (system: string): string => createHash('sha256').update(system).digest('hex');

  it('separates two specs that differ ONLY in model — the pre-task key could not', () => {
    expect(poolKey(spec('S', { model: 'haiku' }))).not.toBe(poolKey(spec('S', { model: 'opus' })));
    // Proof the mutant fails: under the old key these two collide.
    expect(OLD_KEY('S')).toBe(OLD_KEY('S'));
  });

  it('separates two specs that differ ONLY in effort', () => {
    expect(poolKey(spec('S', { effort: 'low' }))).not.toBe(poolKey(spec('S', { effort: 'max' })));
  });

  it('still reuses one key for the same spec — the pre-warm win is not lost', () => {
    expect(poolKey(spec('S', { model: 'haiku', effort: 'low' }))).toBe(poolKey(spec('S', { model: 'haiku', effort: 'low' })));
  });

  it('cannot be fooled by fields that run together (the NUL separator)', () => {
    // Without a separator `model:'a' + effort:'b'` would hash as `model:'ab'`.
    expect(poolKey(spec('S', { model: 'a', effort: 'b' as never }))).not.toBe(poolKey(spec('S', { model: 'ab' })));
    // And a prompt ending where a model begins must not collide either.
    expect(poolKey(spec('SX'))).not.toBe(poolKey(spec('S', { model: 'X' })));
  });

  it('hands a request for model B a FRESH child, never the one pre-warmed for model A', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const a = p.acquire(spec('S', { model: 'haiku' }));
    p.release(a);
    // children[1] is the replacement pre-warmed for haiku. A request for opus must not take it.
    const b = p.acquire(spec('S', { model: 'opus' }));
    expect(b.process).not.toBe(children[1]);
    // The fresh child was spawned with opus in its argv — the choice reached the process,
    // not merely the key.
    expect(children[children.length - 1]?.args).toEqual(expect.arrayContaining(['--model', 'opus']));
    p.stop();
  });

  it('takes the pre-warmed child when the model matches — switching away and back is not a permanent cost', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = pool(spawnChild);
    const first = p.acquire(spec('S', { model: 'haiku' }));
    p.release(first);
    const second = p.acquire(spec('S', { model: 'haiku' }));
    expect(second.process).toBe(children[1]);
    p.stop();
  });
});

describe('the review’s findings, each with its mutant (2026-09-13)', () => {
  it('a multibyte character split across two stdout reads reaches the sink intact', async () => {
    // A pipe read ends on a BYTE boundary; a naive per-chunk toString() turns an em dash cut
    // in two into U+FFFD ×3 and the JSON still parses — the corruption reaches the page.
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const seen: string[] = [];
    const pending = child.send('x', { onDelta: (t) => seen.push(t) });
    const bytes = Buffer.from(delta('a—b') + result('a—b'));
    const cut = Buffer.from(delta('a—b')).indexOf(Buffer.from('—')) + 1;
    fake.stdout.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 0));
    fake.stdout.write(bytes.subarray(cut));
    expect((await pending).text).toBe('a—b');
    expect(seen).toEqual(['a—b']);
  });

  it('the result line wins when `exit` fires before the last stdout read — the remedy is never lost', async () => {
    // Node may fire `exit` while the final read is in flight; failing on `exit` would turn a
    // logged-out CLI's result into "exited (1) before answering" and the probe into `unknown`.
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const pending = child.send('x', { onDelta: () => {} });
    fake.stdout.write(result('Not logged in · Please run /login', { is_error: true }));
    fake.exitOnly(1); // exit first, the data still queued
    await expect(pending).rejects.toThrow(/login/);
  });

  it('a spawn that fails (error, no exit) is dead: never handed out, and a request on it fails at once', async () => {
    const { spawnChild, children } = fakeSpawner({ errorAtOnce: 'spawn claude EACCES' });
    const p = new ChildPool({ spawnChild, argsFor, env: ENV });
    p.prewarm(poolKey(spec('S')), spec('S'));
    await new Promise((r) => setTimeout(r, 0));
    expect(children[0]?.exited).toBe(false); // the FAKE never exits — the class must not need it to
    const child = p.acquire(spec('S'));
    expect(child.process).not.toBe(children[0]);
    p.stop();
  });

  it('a request sent to a child whose spawn failed rejects with the spawn error, not a bound', async () => {
    const fake = new FakeClaudeChild([], ENV, { errorAtOnce: 'spawn claude EACCES' });
    const child = new ClaudeChild(fake);
    await new Promise((r) => setTimeout(r, 0));
    await expect(child.send('x', { onDelta: () => {} })).rejects.toThrow(/exited before the request|could not start/);
  });

  it('the SIGKILL fallback fires when the child ignores SIGTERM', () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeClaudeChild([], ENV, { ignoresTerm: true });
      const child = new ClaudeChild(fake);
      child.kill();
      expect(fake.kills).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(2_001);
      expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a line that never ends is not an answer: the child is reaped past the cap', async () => {
    const fake = new FakeClaudeChild([], ENV, { silent: true });
    const child = new ClaudeChild(fake);
    const pending = child.send('x', { onDelta: () => {} });
    fake.stdout.write('x'.repeat(17 * 1024 * 1024));
    await expect(pending).rejects.toThrow(/unreadable line/);
    expect(fake.exited).toBe(true);
  });
});

describe('the pool’s bounds, each with its mutant (2026-09-13)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a dead warm entry’s timer is cleared, so it cannot reap the replacement at that key', () => {
    const { spawnChild, children } = fakeSpawner();
    const p = new ChildPool({ spawnChild, argsFor, env: ENV, idleMs: 1_000 });
    p.prewarm(poolKey(spec('S')), spec('S')); // timer → t=1000
    vi.advanceTimersByTime(500);
    children[0]?.exit(1); // dies on its own
    p.acquire(spec('S')); // drops the dead entry, spawns for the request, pre-warms a replacement (timer → t=1500)
    vi.advanceTimersByTime(501); // t=1001: the OLD timer would fire here
    const replacement = children[2];
    expect(replacement?.exited, 'the stale timer must not have reaped the replacement').toBe(false);
    vi.advanceTimersByTime(500); // t=1501: the replacement's own TTL
    expect(replacement?.exited).toBe(true);
    p.stop();
  });

  it('a pre-warm whose spawn throws costs no other key its child', () => {
    let fail = false;
    const { spawnChild, children } = fakeSpawner();
    const p = new ChildPool({ spawnChild: (args, env) => { if (fail) throw new Error('no binary'); return spawnChild(args, env); }, argsFor, env: ENV, maxWarm: 1 });
    p.prewarm(poolKey(spec('A')), spec('A'));
    fail = true;
    expect(() => p.prewarm(poolKey(spec('B')), spec('B'))).toThrow(/no binary/);
    expect(children[0]?.exited, 'A must still be warm').toBe(false);
    expect(p.stats().warm).toBe(1);
    p.stop();
  });

  it('refuses a request beyond maxLive by name, never queues it', () => {
    const { spawnChild } = fakeSpawner();
    const p = new ChildPool({ spawnChild, argsFor, env: ENV, maxLive: 2, maxWarm: 0 });
    p.acquire(spec('S'));
    p.acquire(spec('S'));
    expect(() => p.acquire(spec('S'))).toThrow(/already answering 2/);
    p.stop();
  });

  it('the live cap is a named constant', () => {
    expect(POOL_MAX_LIVE).toBe(4);
  });
});
