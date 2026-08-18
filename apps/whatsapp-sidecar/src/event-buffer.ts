/**
 * THE HINT RING BUFFER behind `GET /events` (ADR-0034, TASK-20260817-telepath).
 *
 * One implementation for the real adapter and the fake alike — cursor semantics that lived
 * in two places would drift, and a drifted cursor renders a gap as "nothing new", which is
 * a message the user never sees.
 *
 * A row is a HINT — `{seq, jid, kind, ts}` and nothing else, enforced at push by
 * construction rather than by caller discipline. The host pump forwards these into the app
 * frame over the ordinary 256 KB frame class, and the runner's `post()` drops an oversized
 * frame SILENTLY, so the shape of a row is a delivery guarantee: hints cannot outgrow the
 * frame class because they cannot carry content. The doorbell is not the delivery.
 */

export type WaEventKind = 'message' | 'chat-update';

export interface WaEventHint {
  /** Monotonic within one process life, starting at 1. Restarts restart it — see resync. */
  readonly seq: number;
  readonly jid: string;
  readonly kind: WaEventKind;
  /** Unix seconds of the underlying change, as WhatsApp reports them. */
  readonly ts: number;
}

export interface WaEventsPage {
  readonly hints: readonly WaEventHint[];
  /** Hand this back as `?cursor=` on the next call. */
  readonly nextCursor: number;
  /**
   * True when the buffer cannot honestly answer "everything after your cursor": eviction
   * opened a gap, or the cursor is from a previous process life (ahead of every live seq).
   * The consumer refetches its lists and takes `nextCursor` — never trusts the gap.
   */
  readonly resync: boolean;
}

export interface EventBuffer {
  push(hint: { jid: string; kind: WaEventKind; ts: number }): void;
  since(cursor: number | undefined): WaEventsPage;
  /** Resolve when a hint newer than `cursor` exists, or after `timeoutMs` — whichever first. */
  wait(cursor: number | undefined, timeoutMs: number): Promise<void>;
}

export function createEventBuffer(capacity: number): EventBuffer {
  const rows: WaEventHint[] = [];
  let lastSeq = 0;
  let waiters: Array<() => void> = [];

  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    push(hint) {
      lastSeq += 1;
      // Rebuilt field-by-field: whatever extra keys a caller's object carries, they do not
      // enter the buffer. The shape IS the guarantee.
      rows.push({ seq: lastSeq, jid: hint.jid, kind: hint.kind, ts: hint.ts });
      if (rows.length > capacity) rows.splice(0, rows.length - capacity);
      wake();
    },

    since(cursor) {
      // No cursor = subscribe from NOW. History belongs to the list routes; replaying the
      // buffer to a fresh consumer would hand it hints for state it is about to fetch anyway.
      if (cursor === undefined) return { hints: [], nextCursor: lastSeq, resync: false };

      // A cursor ahead of every live seq is from a previous process life.
      if (cursor > lastSeq) return { hints: [...rows], nextCursor: lastSeq, resync: true };

      // Eviction gap: the oldest retained row is more than one past the cursor.
      const oldest = rows[0]?.seq;
      const gapped = oldest !== undefined ? cursor < oldest - 1 : cursor < lastSeq;
      const hints = rows.filter((row) => row.seq > cursor);
      return {
        hints,
        nextCursor: hints.length > 0 ? hints[hints.length - 1]!.seq : cursor,
        resync: gapped,
      };
    },

    wait(cursor, timeoutMs) {
      const behind = cursor === undefined ? lastSeq : cursor;
      if (behind < lastSeq) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== wrapped);
          resolve();
        }, timeoutMs);
        // Node keeps the process alive for a bare timer; a held long-poll must not.
        (timer as { unref?: () => void }).unref?.();
        const wrapped = (): void => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push(wrapped);
      });
    },
  };
}
