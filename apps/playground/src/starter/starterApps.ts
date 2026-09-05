// starterApps.ts — the "starter apps" shelf: curated single-file example apps from
// examples/*/app.html, read through the ONE starter source (`starterSource.ts` owns the
// glob — TASK-20260905-host-kit AC14) so they run without any server on web and desktop,
// and on demand in the host kit.

import { starterSource } from './starterSource.js';

export const STARTER_PREFIX = 'starter--';

export interface StarterApp {
  /** Library-style id, e.g. "starter--chess" — routable as /run/starter--chess. */
  id: string;
  name: string;
  load: () => Promise<string>;
}

export function listStarterApps(): StarterApp[] {
  const source = starterSource();
  return source
    .appFolders()
    .map((folder) => ({
      id: `${STARTER_PREFIX}${folder}`,
      name: folder.replace(/-/g, ' '),
      load: async () => {
        const html = await source.html(folder);
        // Unreachable for a listed folder — the catalogue and the html come from one source.
        if (html === undefined) throw new Error(`starter '${folder}' listed but its app.html is missing`);
        return html;
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isStarterId(id: string): boolean {
  return id.startsWith(STARTER_PREFIX);
}

/**
 * The starter→`install_source` identity rule. ONE rule, ONE place: the hub's dedup map,
 * the hub's open action and the run view's redirect all derive "is this starter already
 * installed?" from this function. An adversarial review found three inline copies of the
 * literal, which happened to agree — a second convention here would let the hub and the
 * run view silently disagree about whether a starter is installed.
 */
export function starterInstallSource(starterId: string): string {
  return `starter:${starterId.slice(STARTER_PREFIX.length)}`;
}

export async function loadStarterHtml(id: string): Promise<string | undefined> {
  const app = listStarterApps().find((candidate) => candidate.id === id);
  return app === undefined ? undefined : app.load();
}
