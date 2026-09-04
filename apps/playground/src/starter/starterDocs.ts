/**
 * starterDocs — seeds an installed starter's wiki from its `authoring/` bundle (ADR-0035).
 *
 * WHY THIS EXISTS. ADR-0031's AC9 gate requires every connected starter to ship an
 * `authoring/` bundle whose doc slugs are deliberately 1:1 with `snug_app_docs` — held for
 * "a future ingestion phase the owner will specify". The owner specified it: an installed
 * app should carry its own vision/requirements/plan/lessons AND the verbatim prompt that
 * built it, in the user's own file, where the app-attached chat can compound on them.
 *
 * SAME SHAPE AS `installStarterRuntimeContract` (its `?raw` glob, its degrade-quietly
 * posture, its never-overwrite rule), with two deliberate differences:
 *  - THE GLOB LIVES HERE, in its own module. `starterApps.ts` stays single-glob because the
 *    AC9 shape pin asserts every glob in THAT file is app-html-shaped — a second glob there
 *    would fail it, and loosening that assertion would weaken the guard that keeps
 *    provenance out of the shipped artifact.
 *  - SEEDING IS PER SLUG, absent-only. The wiki is the app's LIVING memory (ADR-0010), so a
 *    re-install fills gaps and never clobbers what the user's sessions have written — and a
 *    PARTIAL prior state (a deleted page, an install that died mid-loop) is a supported
 *    starting point rather than an all-or-nothing branch.
 */

import { seedDocsAbsentOnly } from '@snugprotocol/db';
import type { UserDb } from '@snugprotocol/db';

/**
 * The authoring bundle, raw. `?raw` for the same reason the manifest glob uses it: Vite
 * never parses these at transform time, so a malformed file degrades to "this starter
 * seeds nothing" instead of breaking the build.
 *
 * The pattern reaches ONLY `authoring/docs/*.md` and `authoring/prompts/*.md` — pinned by
 * its own assertion in `examples/validate.test.mjs`, so this channel can never quietly
 * widen into "bundle whatever sits under the starter folder".
 */
const docModules = import.meta.glob('../../../../examples/*/authoring/{docs,prompts}/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** One starter's bundle: `{ docs: { 'vision.md': '…' }, prompts: { '01-build.md': '…' } }`. */
export interface StarterAuthoringBundle {
  docs: Record<string, string>;
  prompts: Record<string, string>;
}

/** Test seam: starter folder → bundle. */
let fixtures: Record<string, StarterAuthoringBundle> | undefined;

export function __setStarterDocFixturesForTests(next: Record<string, StarterAuthoringBundle>): void {
  fixtures = next;
}

export function __resetStarterDocFixturesForTests(): void {
  fixtures = undefined;
}

/** Every bundled starter's authoring files, keyed by starter folder. */
export async function bundledStarterAuthoring(): Promise<Record<string, StarterAuthoringBundle>> {
  if (fixtures !== undefined) return fixtures;
  const out: Record<string, StarterAuthoringBundle> = {};
  for (const [path, load] of Object.entries(docModules)) {
    const match = /examples\/([^/]+)\/authoring\/(docs|prompts)\/([^/]+\.md)$/.exec(path);
    if (match === null) continue;
    const [, folder, kind, file] = match as unknown as [string, string, 'docs' | 'prompts', string];
    const bundle = out[folder] ?? { docs: {}, prompts: {} };
    bundle[kind][file] = await load();
    out[folder] = bundle;
  }
  return out;
}

const STARTER_SOURCE_PREFIX = 'starter:';

/** `vision.md` → `vision`. Slugs are the filenames the AC9 gate already constrains. */
function slugOf(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

/** The first H1, when the file leads with one — the doc's own title beats a derived one. */
function titleOf(markdown: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  const title = heading?.[1]?.trim();
  return title !== undefined && title.length > 0 ? title : undefined;
}

/**
 * Seed `appId`'s wiki from the starter it was installed from.
 *
 * Every failure path is a silent no-op by design: an install must not fail because a bonus
 * artifact was missing or malformed, and a doc-less app is a fully supported state.
 */
export async function installStarterDocs(db: UserDb, appId: string): Promise<void> {
  const app = db.getApp(appId);
  if (app === undefined) return;

  const source = app.installSource;
  if (source === undefined || !source.startsWith(STARTER_SOURCE_PREFIX)) return;
  const folder = source.slice(STARTER_SOURCE_PREFIX.length);
  if (folder === '') return;

  try {
    const bundle = (await bundledStarterAuthoring())[folder];
    if (bundle === undefined) return; // no authoring bundle — an LLM-free starter, typically

    // The seed set: one doc per authoring file, plus the prompts concatenated into ONE
    // `build-prompt` page in numbered order — chapters of a single story (the brief,
    // then each follow-up); the owner asked for "the prompt which drove the app
    // building" as a readable thing, not a file listing.
    const docs: { slug: string; title?: string; content: string }[] = [];
    for (const [filename, content] of Object.entries(bundle.docs)) {
      if (content.trim().length === 0) continue;
      const title = titleOf(content);
      docs.push({ slug: slugOf(filename), ...(title !== undefined ? { title } : {}), content });
    }
    const ordered = Object.keys(bundle.prompts).sort();
    const body = ordered
      .map((name) => bundle.prompts[name] ?? '')
      .filter((content) => content.trim().length > 0)
      .join('\n\n---\n\n');
    if (body.trim().length > 0) docs.push({ slug: 'build-prompt', title: 'Build prompt', content: body });

    // ABSENT-ONLY, through the one generic seeder a shared bundle's install uses too
    // (TASK-20260904, plan-review finding 20): a starter and a shared app seed docs by
    // the same rule, from one definition.
    seedDocsAbsentOnly(db, appId, docs);
  } catch {
    // A glob miss, a malformed file, a write refusal — all the same outcome: no seed.
  }
}
