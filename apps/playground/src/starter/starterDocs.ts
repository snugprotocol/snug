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
 *  - THE GLOB LIVES IN `starterSource.ts` with the other four (TASK-20260905-host-kit AC14),
 *    pinned there to `authoring/{docs,prompts}/*.md` and nothing wider by the examples
 *    validator — the guard that keeps provenance out of the shipped artifact is the
 *    pattern, wherever it is declared.
 *  - SEEDING IS PER SLUG, absent-only. The wiki is the app's LIVING memory (ADR-0010), so a
 *    re-install fills gaps and never clobbers what the user's sessions have written — and a
 *    PARTIAL prior state (a deleted page, an install that died mid-loop) is a supported
 *    starting point rather than an all-or-nothing branch.
 */

import { seedDocsAbsentOnly } from '@snugprotocol/db';
import type { UserDb } from '@snugprotocol/db';

import { starterSource, type StarterAuthoringBundle } from './starterSource.js';

export type { StarterAuthoringBundle } from './starterSource.js';

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
  return starterSource().authoring();
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
