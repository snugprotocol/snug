// Why this runner cannot run, in words a person can act on (L2).
//
// THE DEFECT THIS REPLACES. Every start failure used to be a thrown error in `main()`,
// before the MCP handshake. The host then reports the only thing it saw — "Connection
// closed" — which names a pipe, not a cause, and offers nothing to do. Measured 2026-10-03
// on the owner's Mac: the plugin failed exactly that way while a healthy runner held the
// lock.
//
// Now no failure after Node is found precedes the handshake. A runner that can neither lead
// nor attach answers `initialize` and `tools/list`, and says WHY through this table:
// `snug_status` returns the row, every other tool returns its sentence as an error.
//
// ONE TABLE. The rows are derived from the places a start can fail — the home, the lock,
// the control socket, the listener, the page — plus the one found by the plan review: a
// primary from an OLDER build, which answers every control op with a success-shaped hello
// and must never be mistaken for one that did what was asked. A new failure is a new row
// here, a new case in `lifecycle-interop.test.ts`, and nowhere else.

import path from 'node:path';

export const REFUSAL_CODES = [
  'home-unresolved',
  'home-unwritable',
  'lock-held-by-stranger',
  'lock-contended',
  'older-build',
  'socket-path-too-long',
  'socket-in-use',
  'listen-failed',
  'page-damaged',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  code: RefusalCode;
  /** What is wrong. */
  message: string;
  /** What to do about it. */
  remedy: string;
}

/** What a row may name. Everything but `cli` is optional: a row must read as a sentence without it. */
export interface RefusalFacts {
  /** How the human CLI is run on this install — the launcher's real path (L5). */
  cli: string;
  /** The Snug home, when it was resolved. */
  home?: string;
  /** The process the lock or the socket names. */
  pid?: number;
  /** The system's own reason (an errno, a byte count). */
  detail?: string;
}

const holder = (facts: RefusalFacts): string => (facts.pid === undefined ? '' : ` (pid ${facts.pid})`);
const because = (facts: RefusalFacts): string => (facts.detail === undefined ? '' : ` (${facts.detail})`);
const inHost = (facts: RefusalFacts, name: string): string => (facts.home === undefined ? name : path.join(facts.home, 'host', name));
const again = 'then call snug_status again.';

const TABLE: Record<RefusalCode, { message(facts: RefusalFacts): string; remedy(facts: RefusalFacts): string }> = {
  'home-unresolved': {
    message: () => 'Snug cannot tell where to keep your file: this process was started with neither HOME nor SNUG_HOME set.',
    remedy: () => 'Start your agent from an environment that sets HOME, or set SNUG_HOME to the folder Snug should use, then restart the agent.',
  },
  'home-unwritable': {
    message: (facts) => `Snug cannot use its folder ${facts.home ?? '(unknown)'}${because(facts)}.`,
    remedy: () => `Make that folder writable, or set SNUG_HOME to one that is, ${again}`,
  },
  // ONLY WHAT IS KNOWN. This row is reached by a command line that could not be read, or did
  // not read as ours — and neither proves the process is not a Snug runner (a process table
  // that would not answer, a Node binary under a path `ps` cannot split). It used to say
  // "is not a Snug runner" and offer the lock's deletion as the whole remedy: for a runner
  // of ours that is wedged, that is a second writer on a file the first still holds. So the
  // sentence claims no more than the lookup found, and the session goes before the lock does.
  'lock-held-by-stranger': {
    message: (facts) => `Snug’s lock (${inHost(facts, 'lock.json')}) names another process${holder(facts)} that could not be identified as a Snug runner.`,
    remedy: () =>
      `Snug never signals a process it cannot identify. If it is a Snug runner, quit the agent session that started it first; once no Snug is running, delete that lock file, ${again}`,
  },
  'lock-contended': {
    message: (facts) => `Another Snug runner${holder(facts)} holds this home and could not be joined.`,
    remedy: (facts) => `If it does not clear in a moment, stop that runner with: ${facts.cli} stop — ${again}`,
  },
  'older-build': {
    message: (facts) => `An older Snug runner${holder(facts)} is already running, and this session cannot work through it.`,
    remedy: (facts) => `Restart the agent session that started it, or stop it with: ${facts.cli} stop — ${again}`,
  },
  'socket-path-too-long': {
    message: (facts) => `Snug’s control socket path is too long for this system${because(facts)}: ${inHost(facts, 'ctl.sock')}.`,
    remedy: () => 'Set SNUG_HOME to a folder with a shorter path, then restart the agent.',
  },
  'socket-in-use': {
    message: (facts) => `Something is already listening on Snug’s control socket (${inHost(facts, 'ctl.sock')}).`,
    remedy: (facts) => `Stop the runner that owns it with: ${facts.cli} stop — ${again}`,
  },
  'listen-failed': {
    message: (facts) => `Snug could not open a local address on 127.0.0.1${because(facts)}.`,
    remedy: () => `Check that nothing on this machine (a firewall, a sandbox) blocks local connections, ${again}`,
  },
  'page-damaged': {
    message: () => 'This Snug install is damaged: the runner page does not match the one the plugin was built with.',
    remedy: () => 'Reinstall the Snug plugin, then restart your agent.',
  },
};

export function refusalFor(code: RefusalCode, facts: RefusalFacts): Refusal {
  const row = TABLE[code];
  return { code, message: row.message(facts), remedy: row.remedy(facts) };
}

/** The one sentence every tool but `snug_status` returns while the runner is refused. */
export function refusalSentence(refusal: Refusal): string {
  return `${refusal.message} ${refusal.remedy}`;
}
