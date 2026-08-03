// Single-writer + cross-tab invalidation seams for the user DB (F12): one tab holds the
// Web Lock and writes; other tabs are read-only and refresh on BroadcastChannel pings.
// Both APIs take injectable primitives so they are unit-testable in node and degrade to
// single-context behavior where the browser APIs are missing.

/** Stable Web Lock name — part of the single-writer rule, not a per-hub choice. */
export const USERDB_LOCK_NAME = 'snug-userdb';

interface LocksLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface UserDbWriterLock {
  /** false = another tab already writes; open read-only and subscribe to invalidations. */
  acquired: boolean;
  /** Releases the lock (no-op when not acquired). Safe to call more than once. */
  release(): void;
}

export interface AcquireUserDbWriterLockOptions {
  /** Injectable lock manager; defaults to `navigator.locks`. Pass `undefined` explicitly to force the fallback. */
  locks?: LocksLike | undefined;
  name?: string;
}

export async function acquireUserDbWriterLock(
  options: AcquireUserDbWriterLockOptions = {},
): Promise<UserDbWriterLock> {
  const locks =
    'locks' in options
      ? options.locks
      : (globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks;
  if (locks === undefined) {
    // No lock manager (node, very old browsers): single-context environment by definition.
    return { acquired: true, release: () => undefined };
  }
  return new Promise<UserDbWriterLock>((resolve) => {
    const request = locks.request(options.name ?? USERDB_LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        resolve({ acquired: false, release: () => undefined });
        return Promise.resolve();
      }
      let releaseHeld: () => void = () => undefined;
      const held = new Promise<void>((releaseLock) => {
        releaseHeld = releaseLock;
      });
      resolve({ acquired: true, release: () => releaseHeld() });
      return held; // the lock is held until release() resolves this promise
    });
    void Promise.resolve(request).catch(() => undefined);
  });
}

interface BroadcastChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface UserDbInvalidationChannel {
  /** Tell other tabs the user DB changed (they re-read from OPFS). */
  postInvalidate(): void;
  /** Subscribe; returns an unsubscribe function. */
  onInvalidate(callback: () => void): () => void;
  close(): void;
}

export interface CreateUserDbChannelOptions {
  /** Injectable channel factory; defaults to `BroadcastChannel`. Pass `undefined` explicitly for the no-op fallback. */
  factory?: ((name: string) => BroadcastChannelLike) | undefined;
  name?: string;
}

export function createUserDbChannel(options: CreateUserDbChannelOptions = {}): UserDbInvalidationChannel {
  const globalChannel = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  const factory =
    'factory' in options
      ? options.factory
      : globalChannel !== undefined
        ? (name: string) => new globalChannel(name)
        : undefined;
  if (factory === undefined) {
    return { postInvalidate: () => undefined, onInvalidate: () => () => undefined, close: () => undefined };
  }
  const channel = factory(options.name ?? USERDB_LOCK_NAME);
  return {
    postInvalidate: () => channel.postMessage({ kind: 'userdb-invalidate' }),
    onInvalidate(callback) {
      const listener = (): void => callback();
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close: () => channel.close(),
  };
}
