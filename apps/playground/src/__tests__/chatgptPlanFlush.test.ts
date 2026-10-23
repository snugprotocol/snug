// chatgptPlanFlush.test.ts — TASK-20261023-siwc-chatgpt-plan L4 (plan §1 D4; §11 amendment
// "L4-11 addition": the keeper exposes a pending persist and `state/chatgptPlan.ts` exports
// `chatgptPlanFlush()`, which the desktop's close-requested flush awaits before `close_flush_done`).
//
// THE HOLE. A refresh rotates the refresh token: the POST succeeds, the keeper writes the rotated set
// to the custody file. A window close landing between the POST and the write loses the ONLY valid
// refresh token — the next launch is signed out, and the server has already burned the old one. The
// desktop shell therefore asks the page to flush before it destroys the window, and that flush must
// wait for whatever the keeper is writing right now.
//
// Pinned here, each with the mutation it catches:
//   - no persist in flight → the flush resolves at once (a flush that waits for nothing must not hang);
//   - a `write` in flight on the SEAT'S store holds the flush until it settles (the write is tracked
//     where the keeper makes it — the seat's own store, the one `bootChatgptPlan` hands the keeper);
//   - a `clear` in flight holds it too (sign-out's delete is a persist as much as a write);
//   - a persist that REJECTS still releases the flush — settled, never a rejection the close must catch;
//   - several persists in flight → the flush waits for every one of them, not just the first;
//   - no seat (web, the host kit) → nothing was ever booted and the flush resolves at once.
//
// Fresh module graph per test (the keeper test's harness): the platform is set once per graph, and
// the keeper is page-wide state.

import { describe, expect, it, vi } from 'vitest';

import type { ChatgptSessionFile } from '@snugprotocol/auth';

import type { ChatgptPlanSeat, SnugPlatform } from '../platform/platform.js';
import { READY, fakeChatgptSession, recordingFactory, settle } from './chatgptPlanTestHelper.js';

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

/** A custody seat whose persists the TEST settles — each `write`/`clear` answers the next queued deferred. */
function controllableSeat(): ChatgptPlanSeat & { persists: Array<Deferred<void>>; nextPersist(): Deferred<void> } {
  const persists: Array<Deferred<void>> = [];
  const nextPersist = (): Deferred<void> => {
    const d = deferred<void>();
    persists.push(d);
    return d;
  };
  return {
    persists,
    nextPersist,
    sessionStore: {
      read: () => Promise.resolve(undefined),
      write: () => nextPersist().promise,
      clear: () => nextPersist().promise,
    },
    loopback: {
      begin: (path) => Promise.resolve({ redirectUri: `http://127.0.0.1:1455${path}` }),
      onCallback: () => () => undefined,
      cancel: () => Promise.resolve(),
    },
    openExternal: () => Promise.resolve(),
  };
}

const FILE: ChatgptSessionFile = { v: 1, hostId: 'urn:uuid:host', planGranted: true };

async function fresh(platform?: SnugPlatform): Promise<Keeper> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const keeper = await import('../state/chatgptPlan.js');
  keeper.resetChatgptPlanForTests();
  return keeper;
}

async function bootedOn(seat: ChatgptPlanSeat): Promise<Keeper> {
  const keeper = await fresh({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true }, chatgptPlan: seat });
  await keeper.bootChatgptPlan(recordingFactory(fakeChatgptSession(READY)).create);
  return keeper;
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

describe('chatgptPlanFlush() — the close-requested flush waits for the keeper’s persist in flight (D4)', () => {
  it('nothing in flight → resolves at once', async () => {
    const keeper = await bootedOn(controllableSeat());
    expect(await settled(keeper.chatgptPlanFlush())).toBe(true);
  });

  it('a write in flight on the seat’s store holds the flush until that write settles', async () => {
    const seat = controllableSeat();
    const keeper = await bootedOn(seat);
    void seat.sessionStore.write(FILE);
    const flush = keeper.chatgptPlanFlush();
    expect(await settled(flush), 'the flush must not resolve while the rotated set is still being written').toBe(false);

    seat.persists[0]?.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('a clear in flight holds it too — sign-out’s delete is a persist', async () => {
    const seat = controllableSeat();
    const keeper = await bootedOn(seat);
    void seat.sessionStore.clear();
    const flush = keeper.chatgptPlanFlush();
    expect(await settled(flush)).toBe(false);

    seat.persists[0]?.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('a persist that REJECTS releases the flush as a resolution — the close never has to catch it', async () => {
    const seat = controllableSeat();
    const keeper = await bootedOn(seat);
    const write = seat.sessionStore.write(FILE);
    write.catch(() => undefined); // the keeper's own handling, stood in for here
    const flush = keeper.chatgptPlanFlush();
    expect(await settled(flush)).toBe(false);

    seat.persists[0]?.reject(new Error('disk full'));
    await expect(flush).resolves.toBeUndefined();
  });

  it('several persists in flight → the flush waits for EVERY one, not only the first', async () => {
    const seat = controllableSeat();
    const keeper = await bootedOn(seat);
    void seat.sessionStore.write(FILE);
    void seat.sessionStore.write({ ...FILE, clientId: 'oaiapp_rotated' });
    const flush = keeper.chatgptPlanFlush();

    seat.persists[0]?.resolve();
    expect(await settled(flush), 'the second write is still out').toBe(false);

    seat.persists[1]?.resolve();
    await expect(flush).resolves.toBeUndefined();
  });

  it('once the in-flight persists settled, a later flush resolves at once again', async () => {
    const seat = controllableSeat();
    const keeper = await bootedOn(seat);
    void seat.sessionStore.write(FILE);
    seat.persists[0]?.resolve();
    await settle();
    expect(await settled(keeper.chatgptPlanFlush())).toBe(true);
  });

  it('no seat (web, the host kit) → nothing was booted and the flush resolves at once', async () => {
    const keeper = await fresh();
    expect(await settled(keeper.chatgptPlanFlush())).toBe(true);
  });
});
