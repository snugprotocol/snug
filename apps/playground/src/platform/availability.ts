// platform/availability.ts — can THIS host run THAT app? (TASK-20261003, ADR-0072 §4.)
//
// ONE derivation for every surface that offers an app: the starter shelf, the installed
// tiles, the run route, the connection wizard's walls. What an app NEEDS comes from what it
// already declares (a starter's connection requirement; an installed app's connection rows).
// What a host OFFERS is read from seats the platform already carries — never from
// `platform.kind`, and never from a flag a shell could forget to set.
//
// WHY SEATS AND NOT `kind`. The gate this replaced was a `desktopOnly` flag in the hub's look
// table, tested against `kind !== 'desktop'`, with one reason ("a web page cannot reach your
// home network") that was true for one of the three starters it locked. It was also wrong
// under the local runner, where a Node process — not a browser page — carries the request:
// Coinbase's missing CORS is no wall there, and Trade Copilot was locked anyway. A seat is
// the thing that DOES the work, so a host that carries it can and a host that does not cannot;
// a `kind` is a name, and a second host with the same abilities would have needed a second
// special case (found 2026-10-03; a `nativeFetch` flag was rejected for the mirror reason —
// the real desktop platform would never have set it).
//
// Pure: no store, no `getPlatform()`. The caller hands in the platform, so each shell proves
// `offersOf` on its REAL platform object (apps/desktop, apps/host) rather than on a fixture.

import { lookupWellKnownProvider } from '@snugprotocol/auth';
import type { ConnectionRow } from '@snugprotocol/db';
import type { ConnectionRequirement } from '@snugprotocol/protocol';

import type { SnugPlatform } from './platform.js';

/**
 * What an app may need from its host beyond a sandbox and a brain.
 *  - `network`      — a connected fetch to a provider over the internet
 *  - `native-fetch` — that provider cannot be called from a browser page (no CORS)
 *  - `oauth`        — an OAuth redirect has to come back to this host
 *  - `lan`          — a device on the user's own network (pinned TLS)
 *  - `helper`       — the linked-device helper process
 */
export type AppNeed = 'network' | 'native-fetch' | 'oauth' | 'lan' | 'helper';

/** Where an app that cannot run here does run. */
export type RunsIn = 'desktop' | 'runner' | 'web';

/** One reason an app cannot run on this host, in words a person can act on. */
export interface AvailabilityBlocker {
  need: AppNeed;
  /** A few words for the tile (`needs your home network`). */
  title: string;
  /** One sentence: what the app reaches for and why this host cannot give it. */
  sentence: string;
  /**
   * The host CLASSES that can run it, most capable first. Never empty. Judged against
   * `HOST_OFFERS` — each class as it is when nothing is wrong with it — so it does not know
   * which host is asking: the presentation leaves out the class the user is already in
   * (`AvailabilityNote.tsx`), which matters on a runner that is blocked for a degraded seat.
   */
  runsIn: readonly RunsIn[];
}

export type Availability = { ok: true } | { ok: false; blockers: readonly AvailabilityBlocker[] };

/** What a host offers, one boolean per need. */
export type HostOffers = Readonly<Record<AppNeed, boolean>>;

/** The order a need set is reported in — and so the order a tile reads its blockers. */
const NEED_ORDER: readonly AppNeed[] = ['network', 'native-fetch', 'oauth', 'lan', 'helper'];

/**
 * The ONE sentence for "this host has no connections" (K4). The run view's install
 * disclosure, the chat log's directive card and the `network` blocker below all say it
 * through this constant; before, three surfaces said it three ways, and one of them added
 * "so it runs in its sample mode" — false for `weather`, which has none.
 */
export const CONNECTIONS_UNAVAILABLE = 'connections aren’t available in this host';

/**
 * What ONE declared connection asks of its host. `undefined` (the app declares nothing)
 * needs nothing.
 *
 * The two device families are EXCLUSIVE, not additive: a LAN requirement rides the pinned
 * transport and a linked device rides the helper's socket, so neither touches the ordinary
 * network path — and each gets its own reason on a tile rather than "needs live connections".
 * A LAN row stays LAN-class after its address is collected (`declaredApiHosts` is then that
 * one private address).
 *
 * `native-fetch` is TRI-STATE on purpose (the 2026-08-12 BYOK CORS advisory): only a
 * REVIEWED `browserCallable: false` in the registry earns it. An absent seat is unknown, and
 * an unknown provider must not be locked out of a browser on a guess.
 */
export function needsOfRequirement(requirement: ConnectionRequirement | undefined): readonly AppNeed[] {
  if (requirement === undefined) return [];
  if (requirement.kind === 'linked_device') return ['helper'];
  if (requirement.lanHost !== undefined) return ['lan'];
  const needs: AppNeed[] = ['network'];
  if (lookupWellKnownProvider(requirement.provider.name)?.browserCallable === false) needs.push('native-fetch');
  if (requirement.kind === 'oauth2_auth_code') needs.push('oauth');
  return needs;
}

/**
 * What an INSTALLED app asks of its host, from its connection rows: the same rule per row,
 * as a union. `declared` and `approved` rows count; a `revoked` row is a tombstone the user
 * said no to, so it asks for nothing; an app with no row needs nothing.
 */
export function needsOfConnections(rows: readonly Pick<ConnectionRow, 'status' | 'requirement'>[]): readonly AppNeed[] {
  const found = new Set<AppNeed>();
  for (const row of rows) {
    if (row.status !== 'declared' && row.status !== 'approved') continue;
    for (const need of needsOfRequirement(row.requirement)) found.add(need);
  }
  return NEED_ORDER.filter((need) => found.has(need));
}

/**
 * What this host offers, read from seats it already carries.
 *
 *  - `network`      — the connections surface is on (the same bit `allows('connections')` reads)
 *  - `native-fetch` — `fetchImpl`: the request leaves from a process, not from a page
 *  - `oauth`        — connections, and the redirect can come back (`oauthRedirect` is absent
 *                     everywhere but the runner, which says `false` when its fixed port was taken)
 *  - `lan`          — BOTH LAN seats: the pinned transport and the pairing exchange
 *  - `helper`       — all THREE sidecar seats: lifecycle, the app door and the wizard door
 *
 * The pairs and the triple are ANDs for the reason the seats' own comments give: a flow
 * offered on half a seam fails midway.
 */
export function offersOf(platform: SnugPlatform): HostOffers {
  const connections = platform.capabilities.connections !== false;
  return {
    network: connections,
    'native-fetch': platform.fetchImpl !== undefined,
    oauth: connections && platform.capabilities.oauthRedirect !== false,
    lan: platform.lanFetch !== undefined && platform.lanPair !== undefined,
    helper: platform.sidecarCtl !== undefined && platform.sidecarFetch !== undefined && platform.sidecarWizardFetch !== undefined,
  };
}

/**
 * What each place an app can run offers when nothing is wrong with it — the table `runsIn`
 * is judged against, most capable first. Each row is pinned to its shell's REAL platform
 * object by that shell's own test (`WEB_DEFAULT` here, `createDesktopPlatform` in
 * apps/desktop, `composeLocalPlatform` in apps/host), so a shell that gains or loses a seat
 * moves this table by a red test rather than by a stale sentence on a tile.
 */
export const HOST_OFFERS: Readonly<Record<RunsIn, HostOffers>> = {
  desktop: { network: true, 'native-fetch': true, oauth: true, lan: true, helper: true },
  runner: { network: true, 'native-fetch': true, oauth: true, lan: false, helper: false },
  web: { network: true, 'native-fetch': false, oauth: true, lan: false, helper: false },
};

const RUNS_IN_ORDER: readonly RunsIn[] = ['desktop', 'runner', 'web'];

/** What a person would call each of those places. */
export const RUNS_IN_LABEL: Readonly<Record<RunsIn, string>> = {
  desktop: 'Snug for Mac',
  runner: 'your agent’s plugin',
  web: 'the web playground',
};

/**
 * The words for each need a host cannot meet. Lowercase and plain, never "unsupported": the
 * title says what the APP needs (a tile reads it under the app's own name), and the sentence
 * is written to follow the app's name or a dash — "… — it talks to a device on your home
 * network, and this host cannot reach your home network".
 */
const BLOCKER_COPY: Readonly<Record<AppNeed, { title: string; sentence: string }>> = {
  network: {
    title: 'needs live connections',
    sentence: `it connects to an outside service, and ${CONNECTIONS_UNAVAILABLE}`,
  },
  'native-fetch': {
    title: 'needs more than a browser',
    sentence: 'its provider turns away requests sent from a web page, and a web page is all this host can send them from',
  },
  oauth: {
    title: 'needs a provider sign-in',
    sentence: 'it signs you in with its provider, and that sign-in has no way back to this host',
  },
  lan: {
    title: 'needs your home network',
    sentence: 'it talks to a device on your home network, and this host cannot reach your home network',
  },
  helper: {
    title: 'needs the phone helper',
    sentence: 'it links your phone through a small helper program, and this host cannot run one',
  },
};

/**
 * The verdict: `{ ok: true }`, or every need this host cannot meet, in `NEED_ORDER`.
 *
 * `runsIn` is judged on the app's WHOLE need set, not on the one blocker it rides: under an
 * artifact Trade Copilot's first blocker is the network, and "runs in the web playground"
 * would still be false there — its provider refuses browsers. Never empty: the desktop
 * offers every need.
 */
export function availabilityOf(needs: readonly AppNeed[], offers: HostOffers): Availability {
  const missing = NEED_ORDER.filter((need) => needs.includes(need) && !offers[need]);
  if (missing.length === 0) return { ok: true };
  const runsIn = RUNS_IN_ORDER.filter((host) => needs.every((need) => HOST_OFFERS[host][need]));
  return { ok: false, blockers: missing.map((need) => ({ need, ...BLOCKER_COPY[need], runsIn })) };
}
