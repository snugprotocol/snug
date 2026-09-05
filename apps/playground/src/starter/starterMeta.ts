/**
 * starterMeta — per-starter release metadata from `examples/<folder>/starter.json`
 * (TASK-20260820-starter-updates, ADR-0045): the starter's current integer version plus
 * its cumulative changelog, which the run header renders as release notes and the update
 * channel compares against the installed copy's recorded version.
 *
 * OWN MODULE, SHARED SOURCE — the glob lives in `starterSource.ts` beside the other four
 * (TASK-20260905-host-kit AC14: one owner, one alias for the host kit), and the examples
 * validator pins each pattern to exactly its file so a widened one can never ship
 * provenance files. This module keeps the artifact class's parsing and its test seam.
 *
 * TOLERANT AT RUNTIME, STRICT AT THE GATE. The examples validator enforces the full
 * shape (including the `appHash` byte-binding) before a starter can ship; here a
 * malformed file degrades to "this starter is unversioned" — no update offers, no
 * release notes, never a crash. `appHash` is deliberately NOT read at runtime: the
 * update channel compares the installed copy's recorded VERSION against the bundle's,
 * and bytes against bytes — the hash exists to make the authoring rule enforceable.
 */

import { starterSource } from './starterSource.js';

export interface StarterReleaseSection {
  title: string;
  items: string[];
}

export interface StarterRelease {
  version: number;
  date: string;
  title?: string;
  sections: StarterReleaseSection[];
}

export interface StarterMeta {
  /** The starter's current version — integers, no semver (ADR-0045 §1). */
  version: number;
  /** Newest first; the validator guarantees the newest entry documents `version`. */
  changelog: StarterRelease[];
}

/** Test seam: starter folder → raw starter.json. */
let fixtures: Record<string, string> | undefined;

export function __setStarterMetaFixturesForTests(next: Record<string, string>): void {
  fixtures = next;
}

export function __resetStarterMetaFixturesForTests(): void {
  fixtures = undefined;
}

/** Parse-and-drop: anything short of a well-formed meta reads as "unversioned". */
export function parseStarterMeta(raw: string): StarterMeta | undefined {
  try {
    const data = JSON.parse(raw) as {
      version?: unknown;
      changelog?: unknown;
    };
    if (!Number.isInteger(data.version) || (data.version as number) < 1) return undefined;
    if (!Array.isArray(data.changelog) || data.changelog.length === 0) return undefined;
    const changelog: StarterRelease[] = [];
    for (const entry of data.changelog as Array<Record<string, unknown>>) {
      if (!Number.isInteger(entry.version) || typeof entry.date !== 'string') return undefined;
      if (!Array.isArray(entry.sections) || entry.sections.length === 0) return undefined;
      const sections: StarterReleaseSection[] = [];
      for (const section of entry.sections as Array<Record<string, unknown>>) {
        if (typeof section.title !== 'string' || !Array.isArray(section.items)) return undefined;
        if (!section.items.every((item): item is string => typeof item === 'string')) return undefined;
        sections.push({ title: section.title, items: section.items });
      }
      changelog.push({
        version: entry.version as number,
        date: entry.date,
        ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
        sections,
      });
    }
    return { version: data.version as number, changelog };
  } catch {
    return undefined;
  }
}

/** The release metadata for one starter folder, or `undefined` for an unversioned one. */
export async function starterMetaFor(folder: string): Promise<StarterMeta | undefined> {
  if (fixtures !== undefined) {
    const raw = fixtures[folder];
    return raw === undefined ? undefined : parseStarterMeta(raw);
  }
  try {
    const raw = await starterSource().meta(folder);
    return raw === undefined ? undefined : parseStarterMeta(raw);
  } catch {
    return undefined;
  }
}
