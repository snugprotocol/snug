// state/browserFlags.ts — the per-browser on/off switches, ONE convention in ONE leaf
// (TASK-20261010-cross-app-access W6 fix lane, finding 23): `'1'` in localStorage when on, the
// row absent when off; storage that is denied (a private window, a blocked origin) reads as off
// and a write to it is a no-op — the switch still answers for the session.
//
// A LEAF on purpose: no card, no scheduler, no access engine import, so every reader — the
// schedule card and its intake, the access card and the access ask ladder — shares the one
// convention without pulling a component graph (or an import cycle) in behind it.

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Storage denied (a private window, a blocked origin): the switch still answers for the session.
  }
}
