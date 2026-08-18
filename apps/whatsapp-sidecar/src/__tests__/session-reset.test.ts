/**
 * A HALF-LINKED SESSION MUST NOT WEDGE THE HELPER (owner report, 2026-08-17).
 *
 * THE INCIDENT. The owner scanned the QR successfully — their phone listed the linked device
 * — but the flow died afterwards (the minted token was not being stored yet), so the wizard
 * never completed. `useMultiFileAuthState` had by then written ~3,000 files including a
 * `creds.json` with `me` populated (the scan happened) and `registered: false` (it never
 * finished). On the next "start linking", Baileys loaded that store, tried to RESUME the
 * dead session instead of pairing, and WhatsApp answered "Connection Failure". No QR, no
 * session, and — because nothing in the helper ever cleared this directory — no way out from
 * the UI at all. Reinstalling would not have helped; only deleting a folder nobody documents.
 *
 * THE RULE, and why it is safe: `POST /pair/start` means "I want to link a device". If we are
 * NOT currently linked, any credentials on disk are by definition not a working session, so
 * they are cleared before the socket opens. If we ARE linked, the reset must never fire —
 * that would throw away a good session every time the wizard was reopened.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isHalfLinkedStore, resetAuthStore, shouldResetAuthStore } from '../baileys-socket.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-session-reset-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A store shaped like the one the incident produced: identity present, registration absent. */
function seedHalfLinkedStore(): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'creds.json'),
    JSON.stringify({ registered: false, me: { id: '1234:36@s.whatsapp.net', name: 'Someone' } }),
  );
  writeFileSync(path.join(dir, 'app-state-sync-key-AAAAAK4.json'), '{"keyData":"x"}');
  writeFileSync(path.join(dir, 'session-1234.0.json'), '{"x":1}');
}

describe('shouldResetAuthStore', () => {
  it('resets when a link is requested and we are NOT linked', () => {
    // The wedge case. Anything on disk while unlinked is not a working session.
    expect(shouldResetAuthStore('idle')).toBe(true);
    expect(shouldResetAuthStore('waiting')).toBe(true);
    expect(shouldResetAuthStore('closed')).toBe(true);
  });

  it('NEVER resets while linked — a good session is not thrown away', () => {
    // Reopening the wizard on a working connection must not unlink the user's phone.
    expect(shouldResetAuthStore('linked')).toBe(false);
  });
});

describe('resetAuthStore', () => {
  it('clears a half-linked store so the next start pairs fresh', () => {
    seedHalfLinkedStore();
    expect(readdirSync(dir).length).toBeGreaterThan(2);

    resetAuthStore(dir);

    // The directory itself survives — `useMultiFileAuthState` writes into it — but nothing
    // that could make Baileys believe it has a session to resume may remain.
    expect(existsSync(dir), 'the auth directory still exists for the new session').toBe(true);
    expect(readdirSync(dir), 'every credential file is gone').toEqual([]);
  });

  it('is a no-op on a directory that does not exist yet', () => {
    // First run: there is nothing to clear, and that must not throw on the path that starts
    // the very first link.
    const fresh = path.join(dir, 'not-created-yet');
    expect(() => resetAuthStore(fresh)).not.toThrow();
  });

  it('does not throw when the directory is unreadable', () => {
    // A reset that threw would take down `startLink` and leave the user with the same wedge
    // this function exists to clear — failing to clean up must never be worse than not
    // trying.
    vi.spyOn(require('node:fs'), 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => resetAuthStore(dir)).not.toThrow();
  });
});

// ============================ detecting the wedge ============================
//
// OWNER-REPORTED (2026-08-17): after a helper restart the app showed "no chats yet —
// history is still syncing from your phone" indefinitely. The session was half-linked
// (`registered: false` WITH a saved `me`), so Baileys tried to RESUME a registration that
// never finished, WhatsApp refused, and history sync never began.
//
// `shouldResetAuthStore` already clears this — but only on a pairing attempt. Until the
// user happens to re-pair, a wedged session is INDISTINGUISHABLE from a slow first sync,
// which is what made a 30-second fix cost an evening. The state is cheaply detectable on
// disk, so the helper reports it and the app can say "re-link" instead of "still syncing".

describe('isHalfLinkedStore — the wedge, named', () => {
  it('is TRUE for the wedge: a scan happened but registration never finished', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-wedge-'));
    writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: false, me: { id: '1@s.whatsapp.net' } }));
    expect(isHalfLinkedStore(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is FALSE for a healthy registered session', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-ok-'));
    writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '1@s.whatsapp.net' } }));
    expect(isHalfLinkedStore(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is FALSE for a never-paired store — that is a first run, not a wedge', () => {
    // The distinction that matters: no `me` means nobody has scanned anything yet, and
    // telling that user to "re-link" would be nonsense.
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-fresh-'));
    writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ registered: false }));
    expect(isHalfLinkedStore(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is FALSE when there is no store at all, and never throws on junk', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-junk-'));
    expect(isHalfLinkedStore(dir)).toBe(false); // no creds.json
    writeFileSync(path.join(dir, 'creds.json'), 'not json at all');
    expect(isHalfLinkedStore(dir)).toBe(false); // unreadable is not a claim
    expect(isHalfLinkedStore(path.join(dir, 'nope'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
