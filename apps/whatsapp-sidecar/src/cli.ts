#!/usr/bin/env node
/**
 * THE PROCESS ENTRY POINT — what `sidecar_ctl` spawns.
 *
 * The contract is fixed by the Rust side (`sidecar.rs`, the `start` arm) and restated here
 * ONCE, in the two env names it reads:
 *
 *   node <~/Snug>/helpers/whatsapp-sidecar/index.js
 *     SNUG_SIDECAR_SOCKET=<~/Snug>/whatsapp-sidecar.sock
 *     SNUG_SIDECAR_NONCE=<256-bit hex>
 *
 * NEITHER value is ever accepted from anywhere else. The shell is the sole writer of both:
 * the socket path because a webview-supplied path would let an app point the helper at a
 * socket of its choosing, and the nonce because it is the only thing standing between a
 * process that wins a race and the pairing flow.
 *
 * FAIL LOUD, NEVER DEFAULT. A missing socket path or nonce exits nonzero rather than picking
 * something sensible: a helper listening somewhere nobody expects, or pairing with a nonce it
 * invented, is worse than a helper that did not start — the first two fail silently and this
 * one shows up immediately in the wizard as "the helper is not running".
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSidecar } from './index.js';
import { watchParent } from './parent-watch.js';

/**
 * The CLI body, exported so `index.ts` (which is what `sidecar_ctl` actually spawns) runs the
 * SAME assembly rather than a second copy of it.
 */
export async function runCli(): Promise<void> {
  return main();
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    process.stderr.write(`snug-whatsapp-sidecar: ${name} is required and was not set\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const socketPath = required('SNUG_SIDECAR_SOCKET');
  const spawnNonce = required('SNUG_SIDECAR_NONCE');
  // Session keys live beside the socket, inside ~/Snug, and never transit any route.
  const authDir = path.join(path.dirname(socketPath), 'whatsapp-session');

  const server = await startSidecar({ socketPath, spawnNonce, authDir });
  process.stderr.write(`snug-whatsapp-sidecar: listening on ${socketPath}\n`);

  const shutdown = (): void => {
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // DIE WITH THE SHELL, even when the shell dies badly (TASK-20260818-sidecar-orphan-reap).
  // `sidecar_ctl` reaps this process on a clean exit; a crash, a `kill -9`, or a `tauri dev`
  // rebuild skips that, and an orphan holding the session makes the next launch's helper
  // fight it for the one connection WhatsApp allows. Same `shutdown` as SIGTERM, so the
  // thread cache's final flush still runs (ADR-0037 §1).
  watchParent({ onOrphaned: shutdown });
}

/** Run when invoked as the bin. `index.ts` has its own equivalent guard. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main().catch(reportAndExit);
}

/**
 * The message goes to stderr, which the shell owns — never onto a route, where it could
 * reach the webview and name paths or session internals.
 */
export function reportAndExit(error: unknown): never {
  process.stderr.write(`snug-whatsapp-sidecar: failed to start: ${String(error)}\n`);
  process.exit(1);
}
