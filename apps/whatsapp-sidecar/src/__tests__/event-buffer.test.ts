/**
 * TASK-20260817-telepath Phase B (ADR-0034): the hint ring buffer behind `GET /events`.
 *
 * ONE implementation, used by the real adapter and the fake alike — a buffer each would
 * hand-roll is a buffer whose cursor semantics drift. The properties worth testing hard:
 *
 *   (1) HINTS ONLY. A row is `{seq, jid, kind, ts}` — no message text, no thumbnails, no
 *       names. The pump forwards these into the app frame over the ordinary 256 KB frame
 *       class, and `post()` drops oversized frames SILENTLY (host.ts F9), so the shape of
 *       a row is a delivery guarantee, not a style choice.
 *   (2) THE CURSOR NEVER LIES. A consumer holding cursor N gets everything after N or an
 *       explicit `resync: true` — never a silent gap. A gap rendered as "nothing new" is a
 *       message the user never sees.
 *   (3) A RESTART IS DETECTABLE. Sequence numbers restart with the process; a cursor from
 *       a previous life must read as resync, not as "wait forever for seq 58".
 */

import { describe, expect, it } from 'vitest';
import { createEventBuffer } from '../event-buffer.js';

const hint = (jid: string, ts = 1) => ({ jid, kind: 'message' as const, ts });

describe('cursor semantics', () => {
  it('subscribes from NOW when no cursor is given — history is the list routes’ job', () => {
    const buffer = createEventBuffer(10);
    buffer.push(hint('a@g.us'));
    buffer.push(hint('b@g.us'));
    const page = buffer.since(undefined);
    expect(page.hints).toEqual([]);
    expect(page.resync).toBe(false);
    // The cursor handed back is LIVE: the next push is visible from it.
    buffer.push(hint('c@g.us'));
    expect(buffer.since(page.nextCursor).hints.map((h) => h.jid)).toEqual(['c@g.us']);
  });

  it('returns everything after the cursor, in order, with a monotonic seq', () => {
    const buffer = createEventBuffer(10);
    buffer.push(hint('a@g.us', 1));
    const start = buffer.since(undefined).nextCursor;
    buffer.push(hint('b@g.us', 2));
    buffer.push(hint('c@g.us', 3));
    const page = buffer.since(start);
    expect(page.hints.map((h) => h.jid)).toEqual(['b@g.us', 'c@g.us']);
    expect(page.hints[1]!.seq).toBeGreaterThan(page.hints[0]!.seq);
    expect(page.nextCursor).toBe(page.hints[1]!.seq);
    expect(page.resync).toBe(false);
  });

  it('an up-to-date cursor gets an empty page and keeps its position', () => {
    const buffer = createEventBuffer(10);
    buffer.push(hint('a@g.us'));
    const cursor = buffer.since(undefined).nextCursor;
    const page = buffer.since(cursor);
    expect(page.hints).toEqual([]);
    expect(page.nextCursor).toBe(cursor);
    expect(page.resync).toBe(false);
  });

  it('flags resync when eviction has opened a gap — never renders a gap as "nothing new"', () => {
    const buffer = createEventBuffer(2);
    buffer.push(hint('a@g.us'));
    const cursor = buffer.since(undefined).nextCursor; // holds seq 1
    buffer.push(hint('b@g.us'));
    buffer.push(hint('c@g.us'));
    buffer.push(hint('d@g.us')); // capacity 2: b evicted — seq 2 is gone
    const page = buffer.since(cursor);
    expect(page.resync).toBe(true);
    // What remains is still handed over; the consumer refetches lists and takes nextCursor.
    expect(page.nextCursor).toBe(buffer.since(undefined).nextCursor);
  });

  it('flags resync for a cursor FROM A PREVIOUS LIFE (ahead of every live seq)', () => {
    const buffer = createEventBuffer(10);
    buffer.push(hint('a@g.us'));
    const page = buffer.since(9_999);
    expect(page.resync).toBe(true);
  });
});

describe('hint purity — the delivery-guarantee shape', () => {
  it('stores exactly {seq, jid, kind, ts}, whatever extra keys a caller passes', () => {
    const buffer = createEventBuffer(10);
    buffer.push({ jid: 'a@g.us', kind: 'message', ts: 7, text: 'SECRET BODY', name: 'Alice' } as never);
    buffer.push({ jid: 'a@g.us', kind: 'chat-update', ts: 8 });
    const rows = buffer.since(0).hints;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['jid', 'kind', 'seq', 'ts']);
    }
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});

describe('waiting — the long-poll hold', () => {
  it('resolves early when a newer hint arrives', async () => {
    const buffer = createEventBuffer(10);
    const cursor = buffer.since(undefined).nextCursor;
    const waited = buffer.wait(cursor, 5_000);
    buffer.push(hint('a@g.us'));
    // Resolving is the assertion: a 5 s hold that ran to its timer would blow the suite's
    // own timeout long before vitest's default.
    await waited;
    expect(buffer.since(cursor).hints).toHaveLength(1);
  });

  it('resolves at the timeout when nothing arrives — the hold is a hold, not a hang', async () => {
    const buffer = createEventBuffer(10);
    const start = Date.now();
    await buffer.wait(buffer.since(undefined).nextCursor, 20);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('resolves immediately when the cursor is already behind', async () => {
    const buffer = createEventBuffer(10);
    const cursor = buffer.since(undefined).nextCursor;
    buffer.push(hint('a@g.us'));
    const start = Date.now();
    await buffer.wait(cursor, 5_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
