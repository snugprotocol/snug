/**
 * desktopReleases — the desktop shell's structured release notes (ADR-0047).
 *
 * SHAPE, not schema, is shared with ADR-0045's starter changelog: sections/items render
 * through the same Tesla-style notes family, but `version` here is a SEMVER STRING —
 * the starter rule ("integers, no semver") is starters-only (plan-review finding 9).
 * The bundled `desktop-releases.json` beside this module is the canonical history: the
 * release script refuses to build a version without an entry here, the /download page
 * renders it, and the update sheet prefers it for versions it already knows.
 *
 * TOLERANT AT RUNTIME, STRICT AT THE GATE (the starterMeta doctrine): at runtime a
 * malformed file or fetch degrades to "no notes available", never a crash; the
 * release-script tests and the desktop config tests hold the strict end.
 *
 * FETCHED notes (a NEWER version's entries pulled from the release asset) are UNTRUSTED
 * display data: the minisign signature covers the update artifact only, never the
 * manifest or notes (ADR-0047 §5). `parseDesktopReleases` therefore also gates every
 * field to plain strings, and renderers must never linkify or interpret them.
 */

import rawBundledReleases from './desktop-releases.json?raw';

export interface DesktopReleaseSection {
  title: string;
  items: string[];
}

export interface DesktopRelease {
  /** Semver string, e.g. "0.1.0". */
  version: string;
  date: string;
  title?: string;
  sections: DesktopReleaseSection[];
}

const SEMVER = /^\d+\.\d+\.\d+$/;

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Parse-and-drop: anything short of a well-formed list reads as "no notes". */
export function parseDesktopReleases(raw: string): DesktopRelease[] | undefined {
  try {
    const data = JSON.parse(raw) as { releases?: unknown };
    if (!Array.isArray(data.releases) || data.releases.length === 0) return undefined;
    const releases: DesktopRelease[] = [];
    for (const entry of data.releases as Array<Record<string, unknown>>) {
      if (!isSemver(entry.version) || typeof entry.date !== 'string') return undefined;
      if (!Array.isArray(entry.sections) || entry.sections.length === 0) return undefined;
      const sections: DesktopReleaseSection[] = [];
      for (const section of entry.sections as Array<Record<string, unknown>>) {
        if (typeof section.title !== 'string' || !Array.isArray(section.items)) return undefined;
        if (!section.items.every((item): item is string => typeof item === 'string')) return undefined;
        sections.push({ title: section.title, items: section.items });
      }
      releases.push({
        version: entry.version,
        date: entry.date,
        ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
        sections,
      });
    }
    return releases;
  } catch {
    return undefined;
  }
}

/** The bundled history (newest first). Undefined only if the bundled file is malformed. */
export function bundledDesktopReleases(): DesktopRelease[] | undefined {
  return parseDesktopReleases(rawBundledReleases);
}

/** The newest bundled release — the version this build's download page advertises. */
export function newestBundledRelease(): DesktopRelease | undefined {
  return bundledDesktopReleases()?.[0];
}
