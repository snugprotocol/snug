// site.ts — the ONE home of every cross-surface URL on the website (AC3, ADR-0048).
//
// Production download URLs come from the playground's releaseChannel.ts (ADR-0047 §2's
// single-homed constants) via the @playground alias — never restated here. Everything
// else the site links to (playground subdomain, GitHub org/repos, security contact) is
// spelled exactly once, in this module.
//
// AC12 — local E2E mode: `PUBLIC_SITE_MODE=local` (the `dev:local` script) repoints
// the playground at the local vite dev server and the download at a DMG staged by
// `pnpm --filter website stage-local-desktop`, so the whole flow — website → playground
// → desktop download — can be walked end-to-end with zero deployed infrastructure.
import {
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_RELEASES_PAGE_URL,
} from '@playground/desktop/releaseChannel';

export type SiteMode = 'production' | 'local';

export interface SiteLinks {
  /** The hosted playground (its own subdomain in production, vite dev locally). */
  playground: string;
  /** The GitHub org — the surface that shows BOTH repos (snug + spec). */
  githubOrg: string;
  githubRepo: string;
  specRepo: string;
  securityEmail: string;
  download: {
    /** The macOS DMG. */
    dmg: string;
    /** The browsable releases page (versions, notes, checksums). */
    releasesPage: string;
  };
}

const PRODUCTION_LINKS: SiteLinks = {
  playground: 'https://playground.snugprotocol.org',
  githubOrg: 'https://github.com/snugprotocol',
  githubRepo: 'https://github.com/snugprotocol/snug',
  specRepo: 'https://github.com/snugprotocol/spec',
  securityEmail: 'security@snugprotocol.org',
  download: {
    dmg: DESKTOP_DOWNLOAD_URL,
    releasesPage: DESKTOP_RELEASES_PAGE_URL,
  },
};

const LOCAL_LINKS: SiteLinks = {
  ...PRODUCTION_LINKS,
  playground: 'http://localhost:5173',
  download: {
    // Staged from apps/desktop's build output into public/local-artifacts/ (gitignored).
    dmg: '/local-artifacts/Snug.dmg',
    releasesPage: DESKTOP_RELEASES_PAGE_URL,
  },
};

export function resolveSiteLinks(mode: SiteMode): SiteLinks {
  return mode === 'local' ? LOCAL_LINKS : PRODUCTION_LINKS;
}

/** 'local' only on the explicit flag; anything else (or nothing) is production. */
export function currentMode(env: Record<string, unknown>): SiteMode {
  return env.PUBLIC_SITE_MODE === 'local' ? 'local' : 'production';
}

export const siteMode: SiteMode = currentMode(import.meta.env ?? {});
export const site: SiteLinks = resolveSiteLinks(siteMode);
