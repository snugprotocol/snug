// Where the kit page is, and whether it is the page this install was built with (D8).
//
// ONE locator, used by the release entry and the test entry alike. It used to be two
// hand-written lookups that disagreed (the test entry knew one home, the release entry two,
// and the second once climbed one directory too few — silently, because a missing page is
// served as a placeholder with HTTP 200).
//
// THE PIN. When a file `<page>.sha256` sits beside the page, the page's bytes must hash to
// it; otherwise there is NO page, and the process refuses to lead (`page-damaged`).
// That catches what actually happens to an installed plugin — a partial copy, or a stale
// mix of two versions' files — and both of those look healthy over HTTP. It does NOT stop
// another process running as this user, which can rewrite the page and its pin together;
// that is the standard desktop trust boundary and is recorded as such in the threat model.
// No pin beside the page (a developer's tree) → the page is served as it is.
//
// A DAMAGED INSTALL SERVES NOTHING (decided 2026-10-03). This module used to hand back a
// fixed "this install is damaged" document, which the damaged process served from a bare
// listener on the fixed port. Holding that port while holding no lock pushed a HEALTHY
// install started beside it onto an ephemeral port — and the OAuth redirect is registered
// against the fixed one. So a damaged result carries no bytes at all: the process answers
// the handshake and says why through its tools, and that is its whole channel.
//
// The page is read ONCE, at boot: bytes that were checked are the bytes that are served.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The page's homes, relative to the bundle's own directory, in order of how the process is
 * actually run (K1 — there is ONE page, `snug-host.html`, and nothing ships a second copy):
 *   1. the PLUGIN layout — the bundle is `<plugin>/scripts/snug-mcp.mjs` and the page is the
 *      skill's asset, `<plugin>/skills/snug/assets/snug-host.html`: the same file the
 *      artifact route hands in to. `scripts/build-plugin.test.mjs` resolves this entry
 *      inside a tree it builds, so a moved asset reds there rather than serving the
 *      placeholder below with HTTP 200.
 *   2. the REPO layout — a developer running `apps/host-mcp/dist/snug-mcp.mjs` straight out
 *      of the checkout. That path is relative to `apps/host-mcp/dist/`, so it climbs TWO
 *      levels, not one.
 *   3. a SIBLING of the bundle — a scratch install (the browser suite copies the bundle and
 *      a page into one directory, so it can serve a page it has altered).
 */
export const PAGE_CANDIDATES = ['../skills/snug/assets/snug-host.html', '../../host/dist/snug-host.html', 'snug-host.html'] as const;

/** Served when no page exists anywhere: missing, which is not the same thing as damaged. */
export const MISSING_PAGE = '<!doctype html><title>Snug</title><p>The Snug runner page is missing from this install.';

export type LocatedPage =
  | {
      damaged: false;
      /** What the process serves at `/`. */
      html: string;
      /** The file it came from; absent for the missing-page placeholder. */
      file?: string;
    }
  | {
      /** The page exists (or its pin does) and the two disagree. Nothing here is servable. */
      damaged: true;
      /** The page the pin sits beside. */
      file: string;
    };

const read = (file: string): Buffer | undefined => {
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
};

/** The digest a pin file names: its first token, as `shasum -a 256` writes it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function locatePage(bundleDir: string): LocatedPage {
  for (const candidate of PAGE_CANDIDATES) {
    const file = path.join(bundleDir, candidate);
    const bytes = read(file);
    const pin = read(`${file}.sha256`);
    if (bytes === undefined && pin === undefined) continue;
    if (pin === undefined) return { html: bytes!.toString('utf8'), file, damaged: false };

    // A pin exists, so this is the home an installer wrote — the search STOPS here. Falling
    // through to another candidate would serve exactly the stale mix the pin exists to stop.
    const expected = pin.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const actual = bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex');
    if (bytes === undefined || !SHA256_HEX.test(expected) || actual !== expected) return { damaged: true, file };
    return { html: bytes.toString('utf8'), file, damaged: false };
  }
  return { html: MISSING_PAGE, damaged: false };
}
