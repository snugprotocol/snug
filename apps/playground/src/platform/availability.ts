// platform/availability.ts — can THIS host run THAT app? (TASK-20261003, ADR-0072 §4.)
//
// ONE derivation for every surface that offers an app: the starter shelf, the installed
// tiles, the run route, the connection wizard's walls. What an app NEEDS comes from what it
// already declares (a starter's connection requirement; an installed app's connection rows).
// What a host OFFERS is read from seats the platform already carries — never from
// `platform.kind`, and never from a flag a shell could forget to set.
//
// This file is the CONTRACT (types only). The derivation itself — `needsOfRequirement`,
// `needsOfConnections`, `offersOf`, `availabilityOf` — lands with the task's R3 range.

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
  /** The hosts that CAN run it, most capable first. Never empty. */
  runsIn: readonly RunsIn[];
}

export type Availability = { ok: true } | { ok: false; blockers: readonly AvailabilityBlocker[] };

/** What a host offers, one boolean per need. */
export type HostOffers = Readonly<Record<AppNeed, boolean>>;
