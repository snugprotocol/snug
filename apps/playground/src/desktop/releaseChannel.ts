// releaseChannel.ts — ADR-0047: the ONE home of the desktop release-channel URLs.
//
// Dependency direction (plan-review finding 16): this lives in the PLAYGROUND and the
// desktop shell consumes it through its `@playground` alias — never the other way.
// `tauri.conf.json` cannot import TS, so the desktop's updaterConfig test BYTE-COMPARES
// its `plugins.updater.endpoints` against `DESKTOP_RELEASE_MANIFEST_URL` (the
// one-contract-two-artifacts rule, lessons 2026-07-31). If you change a URL here, that
// test names the config edit you owe.
//
// Hosting is GitHub Releases on snugprotocol/snug (owner choice, ADR-0047 §1). While
// the repo is private, anonymous fetches of these URLs 404 — the launch-time update
// check is quiet about it by design, and the Settings manual check names it. The
// stable `latest/download/<asset>` shape is what makes one constant serve every
// release; the release script uploads assets under these exact names.

/** The Tauri updater endpoint: the newest release's manifest. */
export const DESKTOP_RELEASE_MANIFEST_URL =
  'https://github.com/snugprotocol/snug/releases/latest/download/latest.json';

/** The human download: the newest release's DMG, uploaded under this stable name. */
export const DESKTOP_DOWNLOAD_URL =
  'https://github.com/snugprotocol/snug/releases/latest/download/Snug.dmg';

/** The browsable releases page (linked from the download surface, not fetched). */
export const DESKTOP_RELEASES_PAGE_URL = 'https://github.com/snugprotocol/snug/releases';

/**
 * The structured release-notes asset uploaded beside latest.json. The update sheet
 * fetches it to render Tesla-style notes for versions NEWER than the running build —
 * and treats it as UNTRUSTED display data (plain text, no actionable links): the
 * minisign signature covers the update ARTIFACT only, never this file (ADR-0047 §5).
 */
export const DESKTOP_RELEASE_NOTES_URL =
  'https://github.com/snugprotocol/snug/releases/latest/download/desktop-releases.json';
