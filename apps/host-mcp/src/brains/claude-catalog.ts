// The models the chip offers for the `claude` brain (TASK-20260922 S9, ADR-0070).
//
// WHY A FILE AND NOT A QUESTION. The obvious design is to ask the brain "what models exist?"
// with web search. It cannot: the child runs `--tools ''`, which is what makes a think
// single-turn BY CONSTRUCTION (D5, AC7), and giving it search would hand it an agent loop
// with tools under the user's own login — precisely what C1 forbids. Measured 2026-09-22 with
// real credentials: `TOOLS: []`, and the child answers "no web search or fetch tool is
// available". So the list comes from the CLI's own catalogue instead, which is better than a
// search would have been anyway: the ids are EXACT (a typo breaks a call), it costs no tokens,
// and it works offline.
//
// WHAT THIS FILE IS. `~/.claude/cache/model-catalog/*.json` is the CLI's INTERNAL cache
// (`version: 2`, `fetchedAt`/`staleAt`, ~1 h TTL), not a published interface. It may move or
// change shape between CLI versions. Every read here therefore fails SOFT to an empty list,
// and the chip keeps free text as its fallback rung — a missing catalogue must degrade to
// "type an id", never to a broken control.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The chip lists the CLI's `main` section — the current models — and never more than this. */
export const MODEL_CATALOG_MAX = 8;

export interface CatalogModel {
  /** The exact id passed to `--model`. Never an alias: an alias could resolve elsewhere later. */
  id: string;
  /** The CLI's own display name (`Opus 5.5`), so the chip reads like the CLI does. */
  name: string;
  /**
   * Whether this model HAS a thinking-effort axis. Haiku 4.5 does not (measured), and an
   * effort control on a model that ignores it is a dead control (AC8).
   */
  effort: boolean;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  section?: unknown;
  thinking?: { type?: unknown } | null;
}

/**
 * The models to offer, or `[]` when the catalogue cannot be read or understood.
 * @param home the user's home directory — passed in rather than read, so tests drive it.
 */
export function readModelCatalog(home: string): CatalogModel[] {
  try {
    const dir = path.join(home, '.claude', 'cache', 'model-catalog');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    if (files.length === 0) return [];

    // More than one surface can be cached; take the most recently fetched. A STALE file is
    // still read: a month-old exact id beats no list at all, and the CLI refuses an id it no
    // longer knows BY NAME, so staleness fails loudly rather than silently.
    let newest: { fetchedAt: number; models: RawModel[] } | undefined;
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        continue; // a half-written or non-JSON file teaches nothing
      }
      const root = parsed as { fetchedAt?: unknown; catalog?: { config?: { models?: unknown } } } | null;
      const models = root?.catalog?.config?.models;
      if (!Array.isArray(models)) continue; // the shape changed — fail soft
      const fetchedAt = typeof root?.fetchedAt === 'number' ? root.fetchedAt : 0;
      if (newest === undefined || fetchedAt > newest.fetchedAt) newest = { fetchedAt, models: models as RawModel[] };
    }
    if (newest === undefined) return [];

    const offered: CatalogModel[] = [];
    for (const model of newest.models) {
      // `overflow` is the CLI's own "older models" drawer; the chip offers the current ones.
      if (model?.section !== 'main') continue;
      const { id } = model;
      // A non-string id would reach argv; drop it rather than spawn on it.
      if (typeof id !== 'string' || id === '') continue;
      offered.push({
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
        effort: model.thinking?.type === 'effort',
      });
      if (offered.length >= MODEL_CATALOG_MAX) break;
    }
    return offered;
  } catch {
    // No cache directory, no permission, anything at all: the chip falls back to free text.
    return [];
  }
}
