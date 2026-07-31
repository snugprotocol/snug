// starterApps.ts — the "starter apps" shelf: curated single-file example apps from
// examples/*/app.html, bundled lazily via vite glob so they run without any server.

const modules = import.meta.glob('../../../../examples/*/app.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

export const STARTER_PREFIX = 'starter--';

export interface StarterApp {
  /** Library-style id, e.g. "starter--chess" — routable as /run/starter--chess. */
  id: string;
  name: string;
  load: () => Promise<string>;
}

function folderName(path: string): string {
  const match = /examples\/([^/]+)\/app\.html$/.exec(path);
  return match?.[1] ?? path;
}

export function listStarterApps(): StarterApp[] {
  return Object.entries(modules)
    .map(([path, load]) => {
      const folder = folderName(path);
      return { id: `${STARTER_PREFIX}${folder}`, name: folder.replace(/-/g, ' '), load };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isStarterId(id: string): boolean {
  return id.startsWith(STARTER_PREFIX);
}

export async function loadStarterHtml(id: string): Promise<string | undefined> {
  const app = listStarterApps().find((candidate) => candidate.id === id);
  return app === undefined ? undefined : app.load();
}
