// router.tsx — which router the kit mounts (K3, ADR-0072 §2).
//
// The kit runs from `file://`, inside an artifact viewer, and from a loopback server — none
// of which has an SPA fallback — so it has always used a HASH router. One kind of document
// breaks that: an `about:srcdoc` document at origin `null`, where the History API refuses
// every URL (plan review, 2026-10-03) — what T1 measured September's chat artifacts to be.
// (The owner's 2026-10-03 probe found a chat artifact at a real origin with a working History
// API; the fallback stays for any document that refuses.) `HashRouter` navigates with
// `pushState(state, '', '#/…')`, and what react-router does when that is refused is
// `location.assign` — a navigation of the DOCUMENT rather than a route change, in a frame
// whose address is not its own to navigate (what that does in the real viewer is unmeasured;
// the kit does not depend on finding out).
//
// The choice is made by a guarded CAPABILITY probe, not by origin: the one call a hash
// router cannot work without is tried, once. An origin check would be a list of hosts that
// behave this way today; the probe is the behaviour itself, and a viewer that changes its
// sandbox moves the kit with it.

import type { ReactElement, ReactNode } from 'react';
import { HashRouter, MemoryRouter } from 'react-router';

export type RouterChoice = { kind: 'hash' } | { kind: 'memory'; initialEntries: [string] };

/** What the probe reads: the address (fragment, href) and the History API. */
export interface RouterWindow {
  location: { hash: string; href: string };
  history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void };
}

/**
 * The route a fragment names: `#/settings` → `/settings`. Anything that is not a route — no
 * fragment, a bare `#`, an anchor — is the hub, which is what the hash router makes of it.
 */
export function entryFromHash(hash: string): string {
  const route = hash.startsWith('#') ? hash.slice(1) : hash;
  return route.startsWith('/') ? route : '/';
}

/**
 * The probe replaces the current entry WITH ITSELF — same state, same fragment (or `#/`,
 * what the hash router would normalise an empty one to) — so where it succeeds nothing has
 * changed that a user or the router can observe. Where it throws, the fragment the page
 * was opened with still seeds the memory router, so a deep link opens on its route.
 */
export function pickRouter(win: RouterWindow): RouterChoice {
  let hash = '';
  try {
    hash = win.location.hash;
    win.history.replaceState(win.history.state, '', hash || '#/');
    // react-router 7.18 resolves every navigation target against the document URL —
    // `history.createURL('/')`, i.e. `new URL('/', origin === 'null' ? href : origin)` — so a
    // document whose History API accepts the hash but whose URL cannot serve as a base
    // (`about:srcdoc` at origin null) would throw `Invalid URL` on EVERY navigate. A document
    // with a real origin always has a resolvable href, so probing the href alone is the same
    // question; `file://` (origin "null" too) resolves and keeps the hash router.
    // (TASK-20261008-p0-clearance W2, Gate 5.)
    new URL('/', win.location.href);
    return { kind: 'hash' };
  } catch {
    return { kind: 'memory', initialEntries: [entryFromHash(hash)] };
  }
}

export function KitRouter({ choice, children }: { choice: RouterChoice; children: ReactNode }): ReactElement {
  return choice.kind === 'hash' ? <HashRouter>{children}</HashRouter> : <MemoryRouter initialEntries={choice.initialEntries}>{children}</MemoryRouter>;
}
