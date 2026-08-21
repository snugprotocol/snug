// TASK-20260820 — the 'locked' boot state and the way out of it (AC28, review B7).
//
// WHY A NEW STATE NEEDS A NEW DOOR. `getUserDb()` deliberately never resolves while
// the database is not ready, and App.tsx's boot effect fires four awaiting calls
// (initSettings, refreshAppMeta, initSync, initDesktopFirstRun) BEFORE any status
// branch renders. That is fine and intended for corrupt/unsupported — those states are
// terminal until the user makes an explicit choice. 'locked' is different: it is meant
// to be *resolved*, by typing a passphrase.
//
// But `retryUserDbBoot()` only re-attempts on 'load-failed', and `bootUserDb()` latches
// `opened = true` on first call. So without a dedicated path, an unlock screen would
// have nowhere to send the secret and those four callers would hang forever. That is
// the whole of review finding B7, pinned here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openUserDb = vi.fn();
vi.mock('@snugprotocol/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openUserDb: (...args: unknown[]) => openUserDb(...args) as unknown,
}));
vi.mock('../run/wasm.js', () => ({ locateWasm: () => 'sql-wasm.wasm' }));

const fakeDb = { listApps: () => [], close: () => Promise.resolve() } as unknown;

describe('the locked state (AC28)', () => {
  beforeEach(() => {
    vi.resetModules();
    openUserDb.mockReset();
  });

  it('surfaces as its own status, never as corrupt or load-failed', async () => {
    openUserDb.mockResolvedValue({ status: 'locked', message: 'this Snug file is protected' });
    const userdb = await import('../state/userdb.js');
    void userdb.bootUserDb().catch(() => undefined);
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).toBe('locked'));
  });

  it('unlockUserDb re-runs the open WITH the secret and resolves the pending waiters', async () => {
    openUserDb.mockResolvedValueOnce({ status: 'locked', message: 'protected' });
    const userdb = await import('../state/userdb.js');

    // A caller that started before the lock was known — exactly what App.tsx's boot
    // effect does — must be released by the unlock, not left hanging forever.
    let released = false;
    void userdb.getUserDb().then(() => {
      released = true;
    });
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).toBe('locked'));
    expect(released).toBe(false);

    openUserDb.mockResolvedValueOnce({ status: 'ok', userDb: fakeDb });
    await userdb.unlockUserDb({ passphrase: 'right' });

    expect(userdb.userDbStatusStore.get()).toEqual({ state: 'ready' });
    await vi.waitFor(() => expect(released).toBe(true));
    // The secret really was handed to the open, not silently dropped.
    expect(openUserDb.mock.calls[1]![0]).toMatchObject({ secrets: { passphrase: 'right' } });
  });

  it('a wrong secret stays locked and can be retried — no lockout, no data touched', async () => {
    openUserDb.mockResolvedValueOnce({ status: 'locked', message: 'protected' });
    const userdb = await import('../state/userdb.js');
    await vi.waitFor(async () => {
      void userdb.bootUserDb().catch(() => undefined);
      expect(userdb.userDbStatusStore.get().state).toBe('locked');
    });

    openUserDb.mockResolvedValueOnce({ status: 'locked', message: 'protected' });
    await expect(userdb.unlockUserDb({ passphrase: 'wrong' })).resolves.toBe(false);
    expect(userdb.userDbStatusStore.get().state).toBe('locked');

    // ...and the right one still works afterwards. A retry budget here would be a
    // gift to nobody: the attacker has the file offline, and the honest user is the
    // only person a lockout could ever hurt.
    openUserDb.mockResolvedValueOnce({ status: 'ok', userDb: fakeDb });
    await expect(userdb.unlockUserDb({ passphrase: 'right' })).resolves.toBe(true);
    expect(userdb.userDbStatusStore.get().state).toBe('ready');
  });

  it('accepts the Recovery Key through the same door', async () => {
    openUserDb.mockResolvedValueOnce({ status: 'locked', message: 'protected' });
    const userdb = await import('../state/userdb.js');
    void userdb.bootUserDb().catch(() => undefined);
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).toBe('locked'));

    openUserDb.mockResolvedValueOnce({ status: 'ok', userDb: fakeDb });
    await expect(userdb.unlockUserDb({ recoveryKey: 'ABCDE-FGHJK' })).resolves.toBe(true);
    expect(openUserDb.mock.calls[1]![0]).toMatchObject({ secrets: { recoveryKey: 'ABCDE-FGHJK' } });
  });

  it('is NOT offered the restore-from-backup path (AC28)', async () => {
    // userDbNeedsRestore drives "your file is unreadable — restore a backup". Offering
    // that to someone who merely mistyped a passphrase would coach them into
    // overwriting perfectly good data with an older copy. A locked file is healthy.
    openUserDb.mockResolvedValue({ status: 'locked', message: 'protected' });
    const userdb = await import('../state/userdb.js');
    void userdb.bootUserDb().catch(() => undefined);
    await vi.waitFor(() => expect(userdb.userDbStatusStore.get().state).toBe('locked'));
    expect(userdb.userDbNeedsRestore()).toBe(false);
  });
});
