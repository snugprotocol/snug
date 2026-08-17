/**
 * The helper's public surface AND its executable entry point.
 *
 * BOTH, deliberately, because `sidecar.rs` spawns `node <~/Snug>/helpers/whatsapp-sidecar/index.js`
 * — the shell runs THIS file, so a pure export barrel here would start no process and the
 * wizard would sit at "the helper is not running" forever. The bin (`cli.ts`) delegates to
 * the same `startSidecar`, so there is one assembly with two ways in rather than two
 * assemblies that can drift.
 *
 * The run-on-import is guarded: it fires only when this module IS the process entry, so
 * importing it from a test never starts a server.
 */

export { createSidecarServer, type SidecarServer, type SidecarServerDeps } from './server.js';
export { createRouter, SPAWN_NONCE_HEADER, type SidecarRouter } from './router.js';
export { createMemoryStore, type SidecarStore } from './store.js';
export { createBaileysWaSocket, toWaMessage } from './baileys-socket.js';
export type { WaChat, WaHistoryState, WaLinkState, WaMessage, WaSocket } from './wa-socket.js';

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBaileysWaSocket } from './baileys-socket.js';
import { createRouter } from './router.js';
import { createSidecarServer, type SidecarServer } from './server.js';
import { createMemoryStore } from './store.js';
import { reportAndExit, runCli } from './cli.js';

export interface StartSidecarOptions {
  socketPath: string;
  /** Handed over by `sidecar_ctl` at spawn; the wizard proves it holds the same value. */
  spawnNonce: string;
  /** Where Baileys keeps the session keys — inside the helper, never on any route. */
  authDir: string;
}

/**
 * Start the helper: real WhatsApp socket, router, unix-socket server.
 *
 * The access token is minted by the router on link, using a 256-bit CSPRNG here (ADR-0032 §2)
 * — the mint function is injected rather than reached for inside the router so the router's
 * tests can pin a value without weakening the real one.
 */
export async function startSidecar(options: StartSidecarOptions): Promise<SidecarServer> {
  const socket = await createBaileysWaSocket({ authDir: options.authDir });
  const store = createMemoryStore();
  const router = createRouter({
    socket,
    store,
    spawnNonce: options.spawnNonce,
    mintToken: () => randomBytes(32).toString('base64url'),
    now: () => Date.now(),
  });
  const server = createSidecarServer({ router, socketPath: options.socketPath });
  await server.listen();
  return server;
}

/**
 * Run as a process when THIS file is what node was pointed at (the `sidecar_ctl` contract).
 *
 * The guard matters: `index.js` is also the package's importable surface, and a bare
 * top-level `main()` would try to bind a socket every time a test imported a type from here.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void runCli().catch(reportAndExit);
}
