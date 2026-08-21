// protectOffer.ts — deciding when to OFFER to protect a file (TASK-20260820, D3).
//
// WHY THIS IS NOT THE DESKTOP FIRST-RUN LATCH. `desktop/firstRun.ts` looks like the
// obvious home, and reusing it would have been a real bug for three reasons the plan
// review named:
//
//   - it is DESKTOP-ONLY (it returns early on web), and D3 promises the offer on both
//     surfaces. Hanging protection off it would silence every browser user;
//   - its dismissal is written on ANY exit, including "I'll look around first". One
//     shrug at the welcome would mean never being offered protection again;
//   - the two questions are about different things at different moments. Entangling
//     their state is how a later change to one silently breaks the other.
//
// So: its own key, its own lifecycle, and a "not now" that genuinely means not now.
// Re-offering on the next launch is deliberate — a single deferral must not become a
// permanent opt-out, or the whole feature degrades to the Settings-only outcome D3
// explicitly rejected ("nobody finds it; the threat-model gain stays theoretical").
// Equally deliberate: an explicit "don't ask again" IS honored, because nagging trains
// people to dismiss dialogs without reading them.
import { createStore, useStore, type Store } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';

/** True once the user's file is protected. Also the "stop offering" signal. */
export const SETTING_PROTECTION_ENABLED = 'protectionEnabled';
/** True once the user has said "don't ask again". A plain deferral does NOT set this. */
export const SETTING_PROTECTION_DECLINED = 'protectionOfferDeclined';

export const protectOfferStore: Store<boolean> = createStore<boolean>(false);

/**
 * Boot hook. Runs on web and desktop alike.
 *
 * Note what is NOT consulted: whether the file is "new". `openUserDb` reports status
 * 'ok' for a freshly created database and a loaded one identically, so newness is not
 * observable from here — and it is the wrong question anyway. A veteran file that has
 * never been offered protection should still be offered it.
 */
export async function initProtectOffer(): Promise<void> {
  const db = await getUserDb();
  const enabled = db.getSetting(SETTING_PROTECTION_ENABLED) === true;
  const declined = db.getSetting(SETTING_PROTECTION_DECLINED) === true;
  protectOfferStore.set(!enabled && !declined);
}

/** "not now" — hidden for this session, asked again next launch. Persists nothing. */
export function deferProtectOffer(): void {
  protectOfferStore.set(false);
}

/** "don't ask again" — an explicit, deliberate choice, and it is respected. */
export function declineProtectOfferPermanently(): void {
  protectOfferStore.set(false);
  void getUserDb().then((db) => db.setSetting(SETTING_PROTECTION_DECLINED, true));
}

/** Protection is on: the question is answered for good. */
export function markProtectionEnabled(): void {
  protectOfferStore.set(false);
  void getUserDb().then((db) => db.setSetting(SETTING_PROTECTION_ENABLED, true));
}

/** Protection was turned OFF again: the offer becomes eligible once more. */
export function markProtectionDisabled(): void {
  void getUserDb().then((db) => db.setSetting(SETTING_PROTECTION_ENABLED, false));
}

export function useProtectOffer(): boolean {
  return useStore(protectOfferStore);
}
