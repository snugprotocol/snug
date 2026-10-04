// The RELEASE entry (ADR-0068).
//
// Two shapes, one binary. Spawned by a host with no arguments it speaks MCP over stdio; run
// by a person as `snug status | open | stop` it talks to the primary over the control socket
// and prints the answer to THEIR terminal — which is how the launch address reaches a user
// without ever riding an MCP message (D-B8).
//
// Everything the process DOES is `startProcess` (K5); this file is only what the shipped
// build is allowed that nothing else is: the user's real home, their real browser, their
// real agent CLIs, and the process table that says whether Snug for Mac holds their file.

import { createBrainRegistry, machineDrivers } from './brains/registry.js';
import { detectHolder } from './holder.js';
import { openInBrowser } from './opener.js';
import { startProcess } from './process.js';

void startProcess({
  hooks: {
    // The shipped process is the ONE caller that may reach the user's real home (D-B34).
    allowRealHome: true,
    heldBy: detectHolder,
    openBrowser: openInBrowser,
    // The user's OWN agents, on their own logins (D5, ADR-0071): `claude`, then `codex`.
    // Nothing is probed here — the first page contact does that.
    brains: ({ home }) => createBrainRegistry({ drivers: machineDrivers({ home }) }),
  },
});
