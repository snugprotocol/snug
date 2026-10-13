// provenance.test.ts — TASK-20261010-host-broker PR-5, AC38 (UI half; contract v2 D-PR5-9; D16):
// the reader's provenance line gains *imported*.
//
// An untrusted import carries `install_source` verbatim, so an imported app can claim to be a
// starter, an agent hand-in or the user's own build (R-77). The db now writes an app-level marker
// (`appProvenance:<appId>` = `{imported: true, at}`) for every incoming app whose identity differs
// from the local one; `access/provenance.ts` reads that fact — handed to it by its caller — and it
// OVERRIDES EVERY `installSource`: *arrived with a file you imported on 3 Oct · Snug can't tell who
// made it*, or, when the marker carries no readable date (the fail-closed read of an unparseable
// row), *arrived with a file you imported · Snug can't tell who made it*.
//
// The marker reaches this pure module through an OPTION (Q, lane T-B — the contract names the kind
// and the words, not the seat): `readerProvenanceKind(app, { imported: { at? } })` and
// `provenanceLine(app, { collides, now, imported: { at? } })`. Absent, every line is today's (the
// guards below stay green).

import { describe, expect, it } from 'vitest';

import * as copy from '../access/copy.js';
import { PROVENANCE, dayMonth } from '../access/copy.js';
import * as provenance from '../access/provenance.js';

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime(); // Oct 12, 3 pm, local
const IMPORTED_AT = new Date(2026, 9, 3, 12, 0, 0).toISOString(); // 3 Oct
const CREATED = new Date(2026, 8, 20, 12, 0, 0).toISOString();

/** The PR-5 seats (D-PR5-9) — LOCAL structural types until provenance.ts / copy.ts export them. */
interface ImportedOpt {
  imported?: { at?: string };
}
const kindOf = provenance.readerProvenanceKind as unknown as (app: { installSource?: string }, opts?: ImportedOpt) => string;
const lineOf = provenance.provenanceLine as unknown as (
  app: { installSource?: string; createdAt: string; currentVersion: number },
  opts: { collides: boolean; now?: number } & ImportedOpt,
) => string;
const IMPORTED = (copy as unknown as { PROVENANCE: { imported(day?: string): string } }).PROVENANCE;

/** Every install source an imported file can carry verbatim — including the ones that would forge a trusted line. */
const SOURCES: ReadonlyArray<string | undefined> = [undefined, 'share:7e2d', 'agent:6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f', 'starter:weather', 'market:x', ''];

describe('D-PR5-9 readerProvenanceKind — imported overrides EVERY installSource', () => {
  it.each(SOURCES.map((source) => [source === undefined ? '(absent — "built here")' : JSON.stringify(source), source] as const))(
    'installSource %s with the marker → imported',
    (_label, installSource) => {
      expect(kindOf(installSource === undefined ? {} : { installSource }, { imported: { at: IMPORTED_AT } })).toBe('imported');
      expect(kindOf(installSource === undefined ? {} : { installSource }, { imported: {} })).toBe('imported');
    },
  );

  it('GUARD: without the marker every kind is today’s (built / share / agent / starter)', () => {
    expect(kindOf({})).toBe('built');
    expect(kindOf({ installSource: 'share:7e2d' })).toBe('share');
    expect(kindOf({ installSource: 'agent:abc' })).toBe('agent');
    expect(kindOf({ installSource: 'starter:weather' })).toBe('starter');
    expect(kindOf({ installSource: 'market:x' })).toBe('share');
  });
});

describe('D-PR5-9 provenanceLine — the imported line, both word forms', () => {
  it('the dated form: "arrived with a file you imported on 3 Oct · Snug can\'t tell who made it" — whatever the app claims to be', () => {
    for (const installSource of SOURCES) {
      const app = { ...(installSource !== undefined ? { installSource } : {}), createdAt: CREATED, currentVersion: 4 };
      const line = lineOf(app, { collides: false, now: NOW, imported: { at: IMPORTED_AT } });
      expect(line, String(installSource)).toBe("arrived with a file you imported on 3 Oct · Snug can't tell who made it");
      expect(line).toBe(IMPORTED.imported(dayMonth(IMPORTED_AT, NOW)));
    }
  });

  it('the dateless form — the marker could not be read (fail closed): "arrived with a file you imported · Snug can\'t tell who made it"', () => {
    expect(lineOf({ installSource: 'starter:weather', createdAt: CREATED, currentVersion: 1 }, { collides: false, now: NOW, imported: {} })).toBe(
      "arrived with a file you imported · Snug can't tell who made it",
    );
    expect(lineOf({ createdAt: CREATED, currentVersion: 12 }, { collides: false, now: NOW, imported: {} })).toBe(IMPORTED.imported());
  });

  it('the date is the provenance line’s own day-month form — another year carries the year', () => {
    const lastYear = new Date(2025, 11, 3, 12).toISOString();
    expect(lineOf({ createdAt: CREATED, currentVersion: 1 }, { collides: false, now: NOW, imported: { at: lastYear } })).toBe(
      "arrived with a file you imported on 3 Dec 2025 · Snug can't tell who made it",
    );
  });

  it('a name collision is still said after the imported line', () => {
    expect(lineOf({ installSource: 'agent:abc', createdAt: CREATED, currentVersion: 4 }, { collides: true, now: NOW, imported: { at: IMPORTED_AT } })).toBe(
      `${IMPORTED.imported('3 Oct')} · ${PROVENANCE.collides}`,
    );
  });

  it('the imported line never claims a trusted origin: no "built here", "starter", "agent" or "share link" words in it', () => {
    const line = lineOf({ installSource: 'starter:weather', createdAt: CREATED, currentVersion: 1 }, { collides: false, now: NOW, imported: { at: IMPORTED_AT } });
    for (const trusted of [PROVENANCE.starter, PROVENANCE.agent, 'built here', 'share link']) expect(line).not.toContain(trusted);
  });

  it('GUARD: without the marker the four lines are today’s, byte for byte', () => {
    expect(lineOf({ createdAt: CREATED, currentVersion: 12 }, { collides: false, now: NOW })).toBe('built here · v12');
    expect(lineOf({ installSource: 'starter:weather', createdAt: CREATED, currentVersion: 1 }, { collides: false, now: NOW })).toBe('a starter from Snug');
    expect(lineOf({ installSource: 'agent:abc', createdAt: CREATED, currentVersion: 4 }, { collides: false, now: NOW })).toBe('handed in by your agent');
    expect(lineOf({ installSource: 'share:7e2d', createdAt: CREATED, currentVersion: 2 }, { collides: false, now: NOW })).toBe(
      'installed from a share link on 20 Sep · not built by you',
    );
  });
});
