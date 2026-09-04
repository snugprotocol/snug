// share-links.ts — the desktop half of share LINKS (TASK-20260904 AC18, ADR-0064).
//
// macOS delivers a `snug://s/<id>#<key>` activation to the running app (or starts it);
// `tauri-plugin-deep-link` owns the OS registration and hands the URL string over
// through TWO seats — `onOpenUrl` while running, `getCurrent` for the cold-start race
// (the URL arrives before the webview registers its listener; the same shape as the
// open-file path's `pending_opened_files`). A URL is DATA, not a read capability, so
// there is no single-use Rust allowlist for it (plan-review finding 11): the playground
// parses the grammar strictly (`receiveShareLinkUrl`), ignores every non-`snug:` scheme,
// and fetches from the pinned relay origin only.
//
// The plugin functions are injected so this module tests without a Tauri runtime.

import type { SnugPlatform } from '@playground/platform/platform';

export interface DeepLinkDeps {
  onOpenUrl: (handler: (urls: string[]) => void) => Promise<unknown>;
  getCurrent: () => Promise<string[] | null>;
}

/** Only our own scheme, only the share shape's prefix — the rest is the playground's strict parse. */
export function isSnugShareUrl(url: string): boolean {
  return /^snug:\/\/s\//i.test(url.trim());
}

export function createOnOpenShareLink(deps: DeepLinkDeps): NonNullable<SnugPlatform['onOpenShareLink']> {
  return (cb: (url: string) => void) => {
    const deliver = (urls: string[] | null | undefined): void => {
      for (const url of urls ?? []) if (isSnugShareUrl(url)) cb(url);
    };
    void deps.onOpenUrl(deliver).catch(() => {
      /* the plugin is absent in a dev build without the scheme registered — nothing to hear */
    });
    void deps.getCurrent().then(deliver).catch(() => {
      /* same */
    });
  };
}
