// The local page's platform (ADR-0068 §1, D-B14).
//
// This is the one binding with connected apps, so it is the one that carries `fetchImpl`
// and turns `connections` on. Two absences are as deliberate as anything present:
//
//  * NO `oauth` SEAT. `getPlatform().oauth !== undefined` is the wizard's single
//    "not a browser" discriminator, and setting it disables the popup-blocker escape,
//    installs a handle-less pseudo-popup with no null check, and swaps the register copy.
//    On a real browser page `openExternal` can only be `window.open`, which by then has
//    lost transient activation (the click awaits crypto for PKCE and the state HMAC),
//    returns null, and parks the flow on `awaiting_callback` forever. So the page takes the
//    WEB path, whose redirect URI is `${origin}/oauth/callback` — a route the app already
//    routes and the process already serves.
//  * NO `lanFetch` / `lanHttpPrivate`. The LAN rungs are out of scope for this task, and
//    the executor's own named refusal is the honest answer for a LAN row rather than a
//    silent fallback through the ordinary transport.

import { localAdapter } from '@snugprotocol/adapters';
import { createFileBackend, type PersistenceBackend } from '@snugprotocol/db';

import type { CustodySeat, CustodyState, SnugPlatform } from '@playground/platform/platform';

import type { LocalClient, LocalStatus } from './client.js';

export interface LocalComposition {
  platform: SnugPlatform;
  /** Set when the file is held by another product: the page shows this instead of opening. */
  refusal?: { heldBy: string };
}

export interface CustodyStoreLike {
  get(): CustodyState;
  subscribe(listener: () => void): () => void;
  patch(next: Partial<CustodyState>): void;
}

/** A tiny store so the chip re-renders when the holder appears or leaves. */
export function createLocalCustodyStore(initial: CustodyState = { dirty: false, readOnly: false }): CustodyStoreLike {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    patch(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

const origin = typeof location === 'undefined' ? 'http://127.0.0.1:43127' : location.origin;

/**
 * What the brain chip says (D-B35).
 *
 * The owner's walk found a logged-out CLI surfacing as a bare HTTP 502 the first time an
 * app tried to think — no remedy, and no sign that the BRAIN was the problem rather than
 * the app. The chip is where that belongs, before the user asks for anything.
 *
 * An absent `brain` means the probe has not answered yet, which is NOT a claim that the
 * CLI works: the plain label is what the seat has always said, and the chip corrects
 * itself a moment later when the `status` event arrives.
 */
/**
 * Where the brain probe's late verdict lands (D-B35). The platform is composed once and set
 * once; this holder is what the `status` event writes so the chip's getter can see it.
 */
export const brainState: { current?: { state: string; detail?: string } } = {};

export function brainLabel(brain: { state: string; detail?: string } | undefined): string {
  switch (brain?.state) {
    case 'logged-out':
      // The remedy IS the label: a chip that only says "unavailable" makes the user hunt.
      return 'Claude · your CLI — not logged in, run `claude` then `/login`';
    case 'absent':
      return 'demo brain — no host brain found';
    case 'unknown':
      return 'Claude · your CLI — could not check';
    default:
      return 'Claude · your CLI';
  }
}

export function composeLocalPlatform(
  client: LocalClient,
  status: LocalStatus,
  /**
   * The sql.js engine as bytes. Both builds swap the `?url` locator for a stub that must
   * never run, so the engine can ONLY arrive through this seat — without it the user db
   * never opens and the page renders an empty shell with a console error. Caught by the
   * first real-browser run; no unit test could see it, because every one of them injects
   * its own backend.
   */
  sqlJsWasmBinary?: Uint8Array,
  backendOverride?: PersistenceBackend,
  /** The bearer, so the brain adapter can reach the shim on the same origin. */
  token?: string,
): LocalComposition {
  // The holder check decides whether we open AT ALL. Both of the db's save paths swallow a
  // failed write with a bare `catch`, and no persist-error seam exists — so a page that
  // opened read-only would take an hour of the user's work and lose it on tab close.
  if (status.heldBy !== undefined) {
    return {
      refusal: { heldBy: status.heldBy },
      platform: minimalPlatform(),
    };
  }

  const custody = createLocalCustodyStore({ dirty: false, readOnly: false });
  const custodySeat: CustodySeat = {
    state: custody,
    dismissNote: () => custody.patch({ note: undefined }),
  };

  return {
    platform: {
      kind: 'host',
      binding: 'local-host',
      // The one binding whose page can reach the network — through the process, which
      // re-runs the executor's own gates on the far side of the socket.
      fetchImpl: (input, init) => client.fetchImpl(input, init),
      ...(sqlJsWasmBinary !== undefined ? { sqlJsWasmBinary } : {}),
      // THE BRAIN (D5, D-B7). The user's own `claude` CLI behind the process's shim,
      // reached through the adapter the playground already has — `localAdapter` accepts a
      // key, and the host arm of `createTurnAdapter` reads no BYOK key and skips the F15
      // endpoint confirm, so no mode, setting or secret is involved. `streaming: false` is
      // an app-facing declaration in `host-ready`, not a transport switch: the shim answers
      // SSE regardless, because `openaiAdapter` always streams.
      ...(token !== undefined
        ? {
            brain: {
              kind: 'host' as const,
              // A GETTER, not a value. The probe answers after boot (it spawns the user's
              // CLI), and the platform is set ONCE — `setPlatform` throws on a second call
              // and on any call after `getPlatform` has been read, so a page cannot swap in
              // a recomposed platform to update this. The chip reads `label` at render, so
              // a getter over a mutable holder lets a late verdict reach the user without
              // touching the singleton.
              get label(): string {
                return brainLabel(brainState.current ?? status.brain);
              },
              adapter: localAdapter({ baseUrl: `${origin}/v1`, apiKey: token, model: 'claude' }),
              streaming: false,
              tools: false,
            },
          }
        : {}),
      userdbBackend: backendOverride ?? createFileBackend(client.fs, 'Snug'),
      custody: custodySeat,
      capabilities: {
        subscriptionMode: false,
        hubSyncOrigin: false,
        lanHttpPrivate: false,
        hubAuth: false,
        // D15: the brain is the host's and is never chosen.
        brainSettings: false,
        account: false,
        sync: false,
        // THE difference from Binding A. `RunView` keys its net handler on this, so
        // `host-ready.net` becomes true structurally rather than by a flag an app must trust.
        connections: true,
        // The relay is reachable from a browser, but no acceptance criterion covers it here.
        share: false,
        appExport: true,
      },
    },
  };
}

/** What the page carries when it is refusing to open: enough to render the refusal, no seams. */
function minimalPlatform(): SnugPlatform {
  return {
    kind: 'host',
    binding: 'local-host',
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
      appExport: false,
    },
  };
}
