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
//
// AN IMPORTED APP OVERRIDES ALL OF IT (TASK-20261010-host-broker PR-5; D-PR5-9; R-77). An
// untrusted import carries `install_source` verbatim, so a file can claim any origin. The db marks
// every app such an import brought in or changed (`appProvenance:<appId>`); `importedMarkerOf`
// reads that marker FAIL CLOSED — a row it cannot read still marks the app, with no date — and
// the caller hands it here, where it beats every install source: *arrived with a file you imported
// on 3 Oct · Snug can't tell who made it*.

import {
  AGENT_INSTALL_SOURCE_PREFIX,
  SHARE_INSTALL_SOURCE_PREFIX,
  STARTER_INSTALL_SOURCE_PREFIX,
  appProvenanceKey,
  readAppProvenance,
  type AppRecord,
  type UserDb,
} from '@snugprotocol/db';

import { PROVENANCE, dayMonth } from './copy.js';

export type ReaderProvenanceKind = 'built' | 'share' | 'agent' | 'starter' | 'imported';

/** The imported marker as the provenance reads it: present (with its date when the row had a readable one), or absent. */
export interface ImportedMarker {
  at?: string;
}

/**
 * The app's imported marker, FAIL CLOSED (D-PR5-9, F14): absent → `undefined`; a valid row → its
 * date; a row that does not parse — or a read that throws — → imported with no date. A row Snug
 * cannot read never makes an app look like the person's own.
 */
export function importedMarkerOf(db: UserDb, appId: string): ImportedMarker | undefined {
  let marker: { imported: true; at?: string } | undefined;
  try {
    marker = readAppProvenance(db.getSetting(appProvenanceKey(appId)));
  } catch {
    return {};
  }
  if (marker === undefined) return undefined;
  return marker.at !== undefined ? { at: marker.at } : {};
}

export function readerProvenanceKind(app: Pick<AppRecord, 'installSource'>, opts: { imported?: ImportedMarker } = {}): ReaderProvenanceKind {
  if (opts.imported !== undefined) return 'imported';
  const source = app.installSource;
  if (source === undefined) return 'built';
  if (source.startsWith(AGENT_INSTALL_SOURCE_PREFIX)) return 'agent';
  if (source.startsWith(STARTER_INSTALL_SOURCE_PREFIX)) return 'starter';
  if (source.startsWith(SHARE_INSTALL_SOURCE_PREFIX)) return 'share';
  return 'share';
}

export function provenanceLine(
  app: Pick<AppRecord, 'installSource' | 'createdAt' | 'currentVersion'>,
  opts: { collides: boolean; now?: number; imported?: ImportedMarker },
): string {
  const now = opts.now ?? Date.now();
  const kind = readerProvenanceKind(app, opts.imported !== undefined ? { imported: opts.imported } : {});
  const line = ((): string => {
    switch (kind) {
      case 'imported':
        return PROVENANCE.imported(opts.imported?.at !== undefined ? dayMonth(opts.imported.at, now) : undefined);
      case 'built':
        return PROVENANCE.built(app.currentVersion);
      case 'share':
        return PROVENANCE.share(dayMonth(app.createdAt, now));
      case 'agent':
        return PROVENANCE.agent;
      case 'starter':
        return PROVENANCE.starter;
    }
  })();
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
