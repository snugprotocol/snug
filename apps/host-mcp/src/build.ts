// Which Snug is this? — the two facts `snug status` leads with (L4).
//
// "Restart your agent after a plugin update" is the README's own warning: an installed
// plugin is a copy under a version directory and a running process keeps the code it loaded.
// So the first question on any walk is which bytes are actually running, and the answer has
// to come from the process itself, not from the directory it was started in.
//
//   VERSION  the package's version — what the plugin manifest names (pinned equal by test).
//   build    the first seven hex digits of the sha256 of the file this code is running
//            from. In a shipped plugin that file is `scripts/snug-mcp.mjs`, so the value is
//            the prefix of the hash `PROVENANCE.json` records for it: a pasted status can be
//            checked against the tree by eye. It needs no build-time stamp, so two builds of
//            one commit still produce identical bytes.
//
// `build` is also how a newer session recognises an OLDER primary: a `hello` that carries
// none was answered by a build from before this field existed (L3).
//
// HASHED AS THE MODULE LOADS — the first thing the process does, before the verb branch,
// the handshake or any ask — and never again. It used to be hashed on the first ask, from
// whatever was on disk by then; and the file CAN change under a running process: the plugin
// build rewrites `dist/plugin/snug/scripts/snug-mcp.mjs` in place while a runner started
// from it is alive (the owner's own dev flow). The stale runner then reported the NEW build's
// id — the one answer this field exists to get right (measured 2026-10-03: started from
// 1a17789, one line appended before the first status, reported 03a71d6). Read at load, the
// bytes hashed are as near as a process can get to the bytes Node has just compiled.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { version } from '../package.json';

export const VERSION: string = version;

const RUNNING_BUILD: string = ((): string => {
  try {
    return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 7);
  } catch {
    // A file that cannot be read back (deleted under a starting process) still has to
    // answer SOMETHING that is recognisably not a real build.
    return 'unknown';
  }
})();

export function buildId(): string {
  return RUNNING_BUILD;
}
