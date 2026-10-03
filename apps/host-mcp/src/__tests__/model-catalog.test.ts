// model-catalog — TASK-20260922 S9. The CLI keeps its own catalogue of the models it will
// accept, at ~/.claude/cache/model-catalog/*.json. Reading it gives the chip EXACT ids (a
// typo breaks a call) with no LLM call and no tools — the brain cannot web-search, because
// `--tools ''` is what makes it single-turn (D5/AC7), and that must not widen.
//
// It is an INTERNAL cache, so every case here is about failing soft: a missing dir, a shape
// that changed, a stale file. The chip keeps free text as its fallback rung, so "no list"
// must degrade to "type an id", never to a broken control.
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readModelCatalog, MODEL_CATALOG_MAX } from '../model-catalog.js';

// FIXTURE ONLY (2026-10-03, no assertion touched): every case made a home under the OS temp
// dir and none removed it — ten directories a run, 320 of them on the owner's machine by the
// time anybody counted. A home is now remembered when it is made and removed after the case.
const homes: string[] = [];
const tempHome = (prefix: string): string => {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home), `${home} was left behind`).toBe(false);
  }
});

const homeWith = (files: Record<string, string>): string => {
  const home = tempHome('snug-catalog-');
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return home;
};

const entry = (id: string, name: string, section: string, effort = true): unknown => ({
  id,
  name,
  section,
  thinking: { type: effort ? 'effort' : 'none' },
});

const catalogue = (models: unknown[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 2, fetchedAt: Date.now(), staleAt: Date.now() + 3_600_000, catalog: { surface: 'cc', config: { id: 'cc', models } }, ...over });

describe('the models offered come from the CLI’s own catalogue', () => {
  it('lists the main-section models, in catalogue order, with their exact ids', () => {
    const home = homeWith({
      'a.json': catalogue([
        entry('claude-opus-5-5', 'Opus 5.5', 'main'),
        entry('claude-sonnet-5', 'Sonnet 5', 'main'),
        entry('claude-fable-5', 'Fable 5', 'overflow'),
      ]),
    });
    expect(readModelCatalog(home)).toEqual([
      { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: true },
      { id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true },
    ]);
  });

  it('carries whether a model HAS an effort axis — Haiku has none, and a dead control is worse than none (AC8)', () => {
    const home = homeWith({ 'a.json': catalogue([entry('claude-haiku-4-5-20251001', 'Haiku 4.5', 'main', false)]) });
    expect(readModelCatalog(home)[0]?.effort).toBe(false);
  });

  it('caps the list, so a catalogue that grows cannot turn the chip into a wall of options', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`claude-m-${i}`, `M${i}`, 'main'));
    expect(readModelCatalog(homeWith({ 'a.json': catalogue(many) }))).toHaveLength(MODEL_CATALOG_MAX);
  });

  it('prefers the NEWEST file when the CLI has written more than one', () => {
    const home = homeWith({
      'old.json': catalogue([entry('claude-old', 'Old', 'main')], { fetchedAt: 1 }),
      'new.json': catalogue([entry('claude-new', 'New', 'main')], { fetchedAt: Date.now() }),
    });
    expect(readModelCatalog(home)[0]?.id).toBe('claude-new');
  });
});

describe('it fails SOFT — the chip falls back to free text, never to a broken control', () => {
  it('returns nothing when the cache directory does not exist', () => {
    expect(readModelCatalog(tempHome('snug-nocache-'))).toEqual([]);
  });

  it('returns nothing for a file that is not JSON', () => {
    expect(readModelCatalog(homeWith({ 'a.json': '{not json' }))).toEqual([]);
  });

  it('returns nothing when the SHAPE changed — this is an internal cache and may move', () => {
    expect(readModelCatalog(homeWith({ 'a.json': JSON.stringify({ version: 3, somethingElse: true }) }))).toEqual([]);
  });

  it('drops entries missing an id rather than offering a blank option', () => {
    const home = homeWith({ 'a.json': catalogue([{ name: 'No id', section: 'main' }, entry('claude-ok', 'Ok', 'main')]) });
    expect(readModelCatalog(home).map((m) => m.id)).toEqual(['claude-ok']);
  });

  it('never returns an id that is not a string — a non-string would reach argv', () => {
    const home = homeWith({ 'a.json': catalogue([{ id: 42, name: 'Bad', section: 'main' }]) });
    expect(readModelCatalog(home)).toEqual([]);
  });

  it('still reads a STALE catalogue: a month-old exact id beats no list at all', () => {
    const home = homeWith({ 'a.json': catalogue([entry('claude-opus-5-5', 'Opus 5.5', 'main')], { staleAt: 1 }) });
    expect(readModelCatalog(home)).toHaveLength(1);
  });
});
