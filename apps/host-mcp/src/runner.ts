// The composition root: lock → listener → control socket → tools (ADR-0068 §3).
//
// LIFETIME (D-B9). The primary lives while ANY session is attached, not while the session
// that spawned it lives. Two Claude Code windows are one Snug: the second attaches over the
// control socket instead of spawning a rival, and the first closing its stdin must not take
// the runner away from the second. So stdin-close and the parent watch both START a grace
// rather than exiting, and the grace only completes when no client remains.

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { parseAppBundle } from '@snugprotocol/protocol';

import { createControlSocket, probeControlSocket, type ControlSocket } from './control-socket.js';
import { createFetchProxy } from './fetch-proxy.js';
import { acquireLock, releaseLock, type LockDeps } from './lock.js';
import { createLoopbackServer, type LoopbackServer } from './loopback-server.js';
import { nodeHttpsSend } from './node-transport.js';
import { createUserFileStore } from './userdb-fs.js';
import type { ToolName } from './tools.js';

/**
 * The fixed port (D-B13). The OAuth redirect URI is `${origin}/oauth/callback` and the user
 * registers that exact string in a provider's dashboard, so the origin must survive a
 * restart. A busy port falls back to an ephemeral one and DISABLES the OAuth rows with a
 * reason — never silently changes a URI the user has already registered somewhere.
 */
export const SNUG_LOCAL_PORT = 43127;

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface RunnerOptions {
  home?: string;
  /** The kit page's bytes. */
  page: () => string;
  /** Opens a URL in the user's browser. Injected so tests never launch one. */
  openBrowser?(url: string): Promise<void>;
  /** Names the product holding the user file, when one does (D-B10). */
  heldBy?(): string | undefined;
  lockDeps?: Partial<LockDeps>;
  /** How long after the last session leaves before exiting. */
  graceMs?: number;
}

export interface Runner {
  start(): Promise<{ role: 'primary' | 'attached'; port: number; url: string }>;
  callTool(name: ToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** stdin closed, or the parent went away: begin the grace if nobody else is attached. */
  beginGrace(onExit: () => void): void;
  stop(): Promise<void>;
  /** The launch URL, fragment included. Never crosses an MCP message (D-B8). */
  launchUrl(): string;
}

const text = (value: string, isError = false): ToolCallResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

export function createRunner(options: RunnerOptions): Runner {
  const home = options.home ?? path.join(process.env.HOME ?? '.', 'Snug');
  const hostDir = path.join(home, 'host');
  const graceMs = options.graceMs ?? 3_000;

  // 256 bits, memory only. It reaches the page in the launch URL's fragment and is written
  // nowhere: the lock keeps only its hash.
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  let server: LoopbackServer | undefined;
  let control: ControlSocket | undefined;
  let port = 0;
  let role: 'primary' | 'attached' = 'primary';
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const socketPath = path.join(hostDir, 'ctl.sock');
  const url = (): string => `http://127.0.0.1:${port}/#token=${token}`;

  const runner: Runner = {
    async start() {
      mkdirSync(hostDir, { recursive: true });

      const deps: LockDeps = {
        pid: process.pid,
        isAlive: (pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        commandLineOf: () => undefined,
        // The control socket answers a general shape; the lock needs a definite identity.
        // Narrowing HERE rather than widening the lock's contract keeps "an answer without
        // an identity is not an answer" true at the one place that decides take-over.
        probeSocket: async (target) => {
          const answer = await probeControlSocket(target);
          return answer?.tokenHash !== undefined && answer.port !== undefined ? { tokenHash: answer.tokenHash, port: answer.port } : undefined;
        },
        now: () => Date.now(),
        ...options.lockDeps,
      };

      const acquired = await acquireLock(hostDir, { port: SNUG_LOCAL_PORT, tokenHash, socket: socketPath }, deps);
      if (acquired.role === 'attached') {
        role = 'attached';
        port = acquired.port;
        return { role, port, url: `http://127.0.0.1:${port}/` };
      }
      if (acquired.role === 'refused') throw new Error(acquired.reason);

      const store = createUserFileStore(home);
      server = createLoopbackServer({
        token,
        page: options.page,
        proxy: createFetchProxy({ send: nodeHttpsSend }),
        store,
        ...(options.heldBy !== undefined ? { heldBy: options.heldBy } : {}),
      });

      // The fixed port first; an ephemeral fallback keeps the runner usable, and the page
      // is told the OAuth rows are unavailable rather than being handed a changed origin.
      try {
        ({ port } = await server.listen(SNUG_LOCAL_PORT));
      } catch {
        ({ port } = await server.listen(0));
      }

      control = createControlSocket({
        handle: async (request) => {
          if (request.op === 'open') {
            await options.openBrowser?.(url());
            // The URL — fragment and all — goes to the USER's terminal over this socket,
            // never through an MCP message.
            return { url: url(), port, running: true };
          }
          return { tokenHash, port, running: true, clients: control?.clientCount() ?? 0 };
        },
        onClientCountChange: () => {
          // A newcomer during the grace CANCELS it: the runner belongs to whoever is still
          // here, not to the session that happened to spawn it.
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
            graceTimer = undefined;
          }
        },
      });
      await control.listen(socketPath);

      return { role, port, url: url() };
    },

    async callTool(name, args) {
      if (role === 'attached') {
        const answer = await probeControlSocket(socketPath);
        if (answer === undefined) return text('the Snug runner went away — try again', true);
        if (name === 'snug_status') return text(JSON.stringify({ running: true, port: answer.port, attached: true }));
        if (name === 'snug_open') {
          const opened = await (async () => {
            const { createConnection } = await import('node:net');
            return new Promise<string | undefined>((resolve) => {
              const socket = createConnection(socketPath);
              socket.on('error', () => resolve(undefined));
              socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'open' })}\n`));
              socket.on('data', (chunk: Buffer) => {
                try {
                  resolve((JSON.parse(chunk.toString('utf8').split('\n')[0]!) as { url?: string }).url);
                } catch {
                  resolve(undefined);
                }
                socket.destroy();
              });
            });
          })();
          return opened === undefined
            ? text('could not reach the running Snug — try again', true)
            : text(`Snug is open at http://127.0.0.1:${answer.port ?? port}/`);
        }
      }

      switch (name) {
        case 'snug_status':
          return text(
            JSON.stringify({
              running: server !== undefined,
              port,
              pages: server?.subscriberCount() ?? 0,
              file: path.join(home, 'user.snug'),
              heldBy: options.heldBy?.(),
              binding: 'local-host',
            }),
          );

        case 'snug_open': {
          if (server === undefined) return text('the runner is not running', true);
          try {
            await options.openBrowser?.(url());
            // The address WITHOUT the fragment: the token never rides an MCP message.
            return text(`Snug is open at http://127.0.0.1:${port}/`);
          } catch {
            return text(
              `could not open a browser here. Ask the user to run: node <plugin>/scripts/snug-mcp.mjs open`,
              true,
            );
          }
        }

        case 'snug_hand_in': {
          if (server === undefined) return text('the runner is not running', true);
          const bundle = args.bundle;
          if (bundle === undefined) return text('snug_hand_in needs a bundle', true);
          const parsed = parseAppBundle(typeof bundle === 'string' ? bundle : JSON.stringify(bundle));
          if (!parsed.ok) {
            // `reason` is the parser's own vocabulary; its `issues` name the field when the
            // shape is close but wrong, which is the case an agent can actually fix.
            const detail = parsed.reason === 'invalid' ? (parsed.issues ?? []).map((i) => `${i.path}: ${i.message}`).join('; ') : parsed.reason;
            return text(`that is not a valid snug-app-bundle/1 (${detail})`, true);
          }
          // D4 is the PAGE's decision; refusing here too gives the agent a clear error
          // instead of a silent no-op, and the page refuses again at its own boundary.
          if (parsed.bundle.connections.length > 0) {
            return text(
              `"${parsed.bundle.app.displayName}" asks for a connection. The user connects apps in the runner's own wizard — a bundle cannot bring one.`,
              true,
            );
          }
          if (server.subscriberCount() === 0) {
            return text('no Snug page is open — call snug_open first, then hand the app in', true);
          }
          server.emit('hand-in', { bundle: parsed.bundle });
          return text(`handed "${parsed.bundle.app.displayName}" to the open runner`);
        }

        case 'snug_list_apps':
          // The page owns the database; the process never opens it. Until the page reports
          // its library over the control plane, saying so is the honest answer.
          return text(JSON.stringify({ apps: [], note: 'the open runner lists the user’s apps; ask them what they have' }));

        default:
          return text(`unknown tool: ${String(name)}`, true);
      }
    },

    beginGrace(onExit) {
      if (graceTimer !== undefined) return;
      graceTimer = setTimeout(() => {
        // Only when nobody else is here. A second window attaching cancels this.
        if ((control?.clientCount() ?? 0) > 0) {
          graceTimer = undefined;
          return;
        }
        onExit();
      }, graceMs);
      graceTimer.unref?.();
    },

    async stop() {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      server?.emit('shutdown', {});
      await control?.close();
      await server?.close();
      if (role === 'primary') await releaseLock(hostDir, tokenHash);
    },

    launchUrl: url,
  };

  return runner;
}
