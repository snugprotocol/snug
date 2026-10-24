// chatgptPlanFlush.test.ts — TASK-20261023-siwc-chatgpt-plan L4 (plan §1 D4; §11 amendment
// "L4-11 addition"; Gate 5 G5-C2 / ST8): `state/chatgptPlan.ts` exports `chatgptPlanFlush()`, which
// the desktop's close-requested flush awaits before `close_flush_done`.
//
// THE HOLE. A refresh rotates the refresh token: the POST succeeds, the keeper writes the rotated set
// to the custody file. A window close landing between the POST and the write loses the ONLY valid
// refresh token — the next launch is signed out, and the server has already burned the old one. The
// desktop shell therefore asks the page to flush before it destroys the window.
//
// THE SHAPE (Gate 5 G5-C2 / ST8). Two parties know about a persist in flight, and the flush asks BOTH:
//   - the KEEPER's `flush()` — it alone knows about a refresh whose POST has answered but whose write
//     is not yet queued (the window ADR-0078 §4 names; G5-C2), and about a sign-in between its
//     callback and its persist;
//   - the SEAT's own `flush?()` — the desktop store tracks its own IPC writes (ST8), so the page no
//     longer patches the platform's store object to watch them (a patched custody store was a
//     second thing standing between the keeper and the shell).
// Pinned here, each with the mutation it catches:
//   - the flush awaits the keeper's `flush()` AND the seat's `flush()` — both called, both awaited;
//   - a seat flush that REJECTS (or throws synchronously) never rejects the whole — settled, never a
//     rejection the close must catch;
//   - a seat without `flush` (an older shell, the fake seats) → the keeper's flush alone;
//   - no seat (web, the host kit) → nothing was ever booted and the flush resolves at once;
//   - the keeper is still handed the seat's OWN store object (the custody pin, kept).
//
// Fresh module graph per test (the keeper test's harness): the platform is set once per graph, and
// the keeper is page-wide state.

import { describe, expect, it, vi } from 'vitest';

import type { ChatgptPlanSeat, SnugPlatform } from '../platform/platform.js';
import { READY, fakeChatgptSeat, fakeChatgptSession, recordingFactory, settle, type FakeChatgptSession } from './chatgptPlanTestHelper.js';

type Keeper = typeof import('../state/chatgptPlan.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function fresh(platform?: SnugPlatform): Promise<Keeper> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const keeper = await import('../state/chatgptPlan.js');
  keeper.resetChatgptPlanForTests();
  return keeper;
}

async function bootedOn(seat: ChatgptPlanSeat, session: FakeChatgptSession = fakeChatgptSession(READY)): Promise<{ keeper: Keeper; created: ReturnType<typeof recordingFactory>['created'] }> {
  const keeper = await fresh({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true }, chatgptPlan: seat });
  const factory = recordingFactory(session);
  await keeper.bootChatgptPlan(factory.create);
  return { keeper, created: factory.created };
}

/** Whether `promise` has settled after the queue drains — without ever awaiting a pending one. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await settle();
  return done;
}

/** A keeper whose `flush()` the TEST settles. */
function holdingFlush(session: FakeChatgptSession): Deferred<void> {
  const held = deferred<void>();
  session.flush = () => {
    session.calls.flush += 1;
    return held.promise;
  };
  return held;
}

describe('chatgptPlanFlush() — the close-requested flush asks the keeper AND the seat (D4; G5-C2 / ST8)', () => {
  it('nothing in flight → resolves at once, having asked both', async () => {
    const seat = { ...fakeChatgptSeat(), flush: vi.fn(() => Promise.resolve()) };
    const session = fakeChatgptSession(READY);
    const { keeper } = await bootedOn(seat, session);
    expect(await settled(keeper.chatgptPlanFlush())).toBe(true);
    expect(session.calls.flush).toBe(1);
    expect(seat.flush).toHaveBeenCalledTimes(1);
  });

  it('the keeper’s flush() holds the whole flush — a refresh between its POST and its write is what it knows about', async () => {
    const seat = fakeChatgptSeat();
    const session = fakeChatgptSession(READY);
    const held = holdingFlush(session);
    const { keeper } = await bootedOn(seat, session);
    const flush = keeper.chatgptPlanFlush();
    expect(await settled(flush), 'the flush must not resolve while the keeper still has a persist to make').toBe(false);
    held.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('the seat’s flush?() holds it too — the shell’s own IPC writes in flight', async () => {
    const seatFlush = deferred<void>();
    const seat = { ...fakeChatgptSeat(), flush: () => seatFlush.promise };
    const { keeper } = await bootedOn(seat);
    const flush = keeper.chatgptPlanFlush();
    expect(await settled(flush)).toBe(false);
    seatFlush.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('both in flight → the flush waits for BOTH, not only the first to settle', async () => {
    const seatFlush = deferred<void>();
    const seat = { ...fakeChatgptSeat(), flush: () => seatFlush.promise };
    const session = fakeChatgptSession(READY);
    const held = holdingFlush(session);
    const { keeper } = await bootedOn(seat, session);
    const flush = keeper.chatgptPlanFlush();
    held.resolve();
    expect(await settled(flush), 'the seat is still writing').toBe(false);
    seatFlush.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('a seat flush that REJECTS releases the flush as a resolution — the close never has to catch it', async () => {
    const seatFlush = deferred<void>();
    const seat = { ...fakeChatgptSeat(), flush: () => seatFlush.promise };
    const { keeper } = await bootedOn(seat);
    const flush = keeper.chatgptPlanFlush();
    seatFlush.reject(new Error('disk full'));
    await expect(flush).resolves.toBeUndefined();
  });

  it('a seat flush that THROWS synchronously is settled the same way', async () => {
    const seat = {
      ...fakeChatgptSeat(),
      flush: (): Promise<void> => {
        throw new Error('ipc gone');
      },
    };
    const { keeper } = await bootedOn(seat);
    await expect(keeper.chatgptPlanFlush()).resolves.toBeUndefined();
  });

  it('a seat without flush (an older shell, the fake seats) → the keeper’s flush alone', async () => {
    const session = fakeChatgptSession(READY);
    const { keeper } = await bootedOn(fakeChatgptSeat(), session);
    await expect(keeper.chatgptPlanFlush()).resolves.toBeUndefined();
    expect(session.calls.flush).toBe(1);
  });

  it('the seat’s store object is handed to the keeper UNPATCHED — write and clear are the seat’s own functions (ST8: no tracking wrapper)', async () => {
    const seat = fakeChatgptSeat();
    const write = seat.sessionStore.write;
    const clear = seat.sessionStore.clear;
    const { created } = await bootedOn(seat);
    expect(created[0]?.store).toBe(seat.sessionStore);
    expect(seat.sessionStore.write).toBe(write);
    expect(seat.sessionStore.clear).toBe(clear);
  });

  it('no seat (web, the host kit) → nothing was booted and the flush resolves at once', async () => {
    const keeper = await fresh();
    expect(await settled(keeper.chatgptPlanFlush())).toBe(true);
  });
});
