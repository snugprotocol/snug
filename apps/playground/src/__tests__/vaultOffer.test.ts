// TASK-20260820 — when Snug offers to protect a file (AC29, review B8).
//
// THREE THINGS THE REVIEW CAUGHT, EACH PINNED BELOW.
//
// 1. "Genuinely new" was undefined. `openUserDb` returns status 'ok' for a loaded file
//    and for a brand-new empty one alike, so the caller cannot tell them apart. The
//    proxy has to be something inside the file.
//
// 2. The only existing first-run latch is DESKTOP-ONLY (`firstRun.ts` returns early on
//    web), yet D3 promises a prominent offer on both surfaces.
//
// 3. `completeDesktopFirstRun()` writes its dismissal on ANY exit including the skip.
//    Hanging protection off that latch would mean anyone who dismissed the welcome is
//    never offered protection again — which is exactly the Settings-only outcome D3
//    rejected ("nobody finds it; the threat-model gain stays theoretical").
//
// Hence a SEPARATE key with its own lifecycle, and "not now" that genuinely means not
// now rather than never.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
const fakeDb = {
  getSetting: (k: string) => settings.get(k),
  setSetting: (k: string, v: unknown) => settings.set(k, v),
  listApps: () => [],
};
vi.mock('../state/userdb.js', () => ({
  getUserDb: () => Promise.resolve(fakeDb),
  userDbStatusStore: { get: () => ({ state: 'ready' }) },
}));

describe('the protection offer (AC29)', () => {
  beforeEach(() => {
    vi.resetModules();
    settings.clear();
  });

  it('is offered on a file that has never been asked', async () => {
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    expect(vault.protectOfferStore.get()).toBe(true);
  });

  it('is NOT offered on a file that is already protected', async () => {
    settings.set('protectionEnabled', true);
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    expect(vault.protectOfferStore.get()).toBe(false);
  });

  it('uses its OWN key — dismissing the desktop welcome does not silence it (B8)', async () => {
    // The welcome's dismissal must not double as "never mention protection". These are
    // different questions asked at different moments about different things.
    settings.set('desktopWelcomeDone', true);
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    expect(vault.protectOfferStore.get()).toBe(true);
  });

  it('"not now" means NOT NOW — it is re-offered on a later launch (AC29)', async () => {
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    vault.deferProtectOffer();
    expect(vault.protectOfferStore.get()).toBe(false);

    // A fresh launch over the same file asks again. Permanent dismissal from a single
    // "not now" is how a security feature becomes theoretical.
    vi.resetModules();
    const again = await import('../vault/protectOffer.js');
    await again.initProtectOffer();
    expect(again.protectOfferStore.get()).toBe(true);
  });

  it('stops asking once the user says never', async () => {
    // Re-offering forever is nagging, and nagging teaches people to dismiss without
    // reading. An explicit, deliberate "don't ask again" is respected.
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    vault.declineProtectOfferPermanently();

    vi.resetModules();
    const again = await import('../vault/protectOffer.js');
    await again.initProtectOffer();
    expect(again.protectOfferStore.get()).toBe(false);
  });

  it('stops asking once protection is actually turned on', async () => {
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    vault.markProtectionEnabled();
    expect(vault.protectOfferStore.get()).toBe(false);

    vi.resetModules();
    const again = await import('../vault/protectOffer.js');
    await again.initProtectOffer();
    expect(again.protectOfferStore.get()).toBe(false);
  });

  it('is platform-independent — web gets the offer too (B8)', async () => {
    // The existing first-run latch is desktop-only. This one must not inherit that,
    // or every browser user silently never hears about protection.
    const vault = await import('../vault/protectOffer.js');
    await vault.initProtectOffer();
    expect(vault.protectOfferStore.get()).toBe(true);
  });
});
