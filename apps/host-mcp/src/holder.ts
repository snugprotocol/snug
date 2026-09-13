// Is Snug Desktop holding the user file? (D-B10)
//
// There is no lock, pidfile or marker for `~/Snug/user.snug`: the desktop relies on
// `tauri-plugin-single-instance`, which is invisible from outside the app. So the only
// signal available today is the process table, matched on the shell's binary name
// (`snug-desktop`, from its Cargo manifest) by COMMAND IDENTITY rather than by a pid.
//
// This decides whether the page opens at all. Both of the db's save paths swallow a failed
// write with a bare `catch`, and no persist-error seam exists, so a page that opened
// read-only would accept an hour of work and lose it silently on tab close. Refusing to
// open is what "read-only and says so" honestly means here. A shared marker written by both
// products is the durable fix and is queued in next-steps.

import { execFileSync } from 'node:child_process';

const DESKTOP_BINARY = 'snug-desktop';

export interface HolderDeps {
  /** The process table, injected so tests never depend on what is running. */
  processList?(): string;
}

export function detectHolder(deps: HolderDeps = {}): string | undefined {
  const list = deps.processList ?? (() => {
    try {
      return execFileSync('/bin/ps', ['-Ao', 'comm'], { encoding: 'utf8', timeout: 2_000 });
    } catch {
      // A process table we cannot read is not evidence the desktop is absent — but it is
      // also not evidence it is present, and refusing to open on a failed probe would
      // strand the user. Absence is the safe direction here: the 423 on write is the
      // backstop if we guessed wrong.
      return '';
    }
  });
  let lines: string[];
  try {
    lines = list().split('\n');
  } catch {
    // Applies to the INJECTED reader too, not only the default one: a probe that throws is
    // no evidence either way, and refusing to open on it would make an unrelated OS hiccup
    // look like a Snug fault. The 423 on write is the backstop if this guessed wrong.
    return undefined;
  }
  for (const line of lines) {
    const command = line.trim();
    if (command.length === 0) continue;
    // Match the binary's own name, never a substring of some other path: a user's folder
    // called `snug-desktop-notes` must not read as the app.
    const name = command.slice(command.lastIndexOf('/') + 1);
    if (name === DESKTOP_BINARY) return 'Snug for Mac';
  }
  return undefined;
}
