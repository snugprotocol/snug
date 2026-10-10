// access/provenance.ts — the line under the asking app's name on the consent sheet
// (TASK-20261010-cross-app-access AC18; ADR-0075 §5; D11 — a security blocker of the plan
// review): *built here · v12* / *installed from a share link on 3 Oct · not built by you* /
// *handed in by your agent* / *a starter from Snug*, plus *another app has this name* when
// two apps in the library share a display name.
//
// WHY THE HOST DERIVES IT. The app's announce `displayName` is written into its library row,
// so a reader's NAME is text the reader chose — an app called "Ledger" can ask to read the
// real Ledger. The provenance line comes from `installSource`, which only the host's install
// paths write, and the collision note says out loud when the name alone cannot be trusted.
//
// A SOURCE THE HOST DOES NOT KNOW IS NEVER "BUILT HERE". `install_source` is free text; only
// its ABSENCE means the user's own builder made the app. Any other value — an unknown prefix,
// an empty string — reads as the share line ("not built by you"), the conservative claim.

import { AGENT_INSTALL_SOURCE_PREFIX, SHARE_INSTALL_SOURCE_PREFIX, type AppRecord } from '@snugprotocol/db';

import { PROVENANCE, dayMonth } from './copy.js';

export type ReaderProvenanceKind = 'built' | 'share' | 'agent' | 'starter';

/** The starter install identity (`starter:<folder>`) — the starter module's own prefix, read-only here. */
const STARTER_INSTALL_SOURCE_PREFIX = 'starter:';

export function readerProvenanceKind(app: Pick<AppRecord, 'installSource'>): ReaderProvenanceKind {
  const source = app.installSource;
  if (source === undefined) return 'built';
  if (source.startsWith(AGENT_INSTALL_SOURCE_PREFIX)) return 'agent';
  if (source.startsWith(STARTER_INSTALL_SOURCE_PREFIX)) return 'starter';
  if (source.startsWith(SHARE_INSTALL_SOURCE_PREFIX)) return 'share';
  return 'share';
}

export function provenanceLine(
  app: Pick<AppRecord, 'installSource' | 'createdAt' | 'currentVersion'>,
  opts: { collides: boolean; now?: number },
): string {
  const kind = readerProvenanceKind(app);
  const line =
    kind === 'built'
      ? PROVENANCE.built(app.currentVersion)
      : kind === 'share'
        ? PROVENANCE.share(dayMonth(app.createdAt, opts.now ?? Date.now()))
        : kind === 'agent'
          ? PROVENANCE.agent
          : PROVENANCE.starter;
  return opts.collides ? `${line} · ${PROVENANCE.collides}` : line;
}

/**
 * Cyrillic and Greek letters a person reads as Latin ones (lower case — the fold runs after
 * `toLowerCase`, so an upper-case twin like Cyrillic В lands here as в). Deliberately small: the
 * letters that render identically or nearly so in common UI fonts. Not a full confusables table
 * (Unicode TR39) — a residual W6's copy/security review may widen.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y',
  // Greek
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  // Latin look-alikes NFKC keeps
  ı: 'i',
};

/**
 * Display names compared as a person READS them: width-folded (NFKC), accents and other
 * combining marks dropped (NFKD, then `\p{M}`), invisible format characters dropped (`\p{Cf}`),
 * case-folded, Cyrillic/Greek look-alikes read as the Latin letter, spacing collapsed — so a
 * homoglyph twin of an installed app's name draws the collision note (D11).
 */
const readAs = (name: string): string =>
  [...name.normalize('NFKC').normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()]
    .map((char) => LOOK_ALIKES[char] ?? char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether ANOTHER app in the library reads as the same name as `appId`'s. */
export function nameCollides(apps: ReadonlyArray<Pick<AppRecord, 'appId' | 'displayName'>>, appId: string): boolean {
  const self = apps.find((app) => app.appId === appId);
  if (self === undefined) return false;
  const name = readAs(self.displayName);
  return apps.some((app) => app.appId !== appId && readAs(app.displayName) === name);
}
