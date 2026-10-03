// The TEST entry (D-B11) — never shipped.
//
// The e2e drives the real process against a self-signed stub on 127.0.0.1 answering for
// `stub.snug.test`. Two things make that possible, and both are hooks that must not exist
// in the release bundle: a DNS resolver, and a holder override so the read-only path can be
// exercised without running Snug Desktop.
//
// A resolved-address check in the proxy would refuse this stub outright — which is one
// reason (besides its being a new policy the desktop lacks) the proxy has none. The release
// bundle is swept by `check-host-mcp` for the PREFIX every name below shares, so a hook
// added here is covered the day it is added.

import type { LookupFn } from './node-transport.js';

/** `host=ip,host=ip` — the browser's `--host-resolver-rules`, for the process side. */
export function resolverFromEnv(spec: string | undefined): LookupFn | undefined {
  if (spec === undefined || spec.trim() === '') return undefined;
  const table = new Map<string, string>();
  for (const entry of spec.split(',')) {
    const [host, ip] = entry.split('=');
    if (host !== undefined && ip !== undefined) table.set(host.trim(), ip.trim());
  }
  return ((hostname: string, options: { all?: boolean } | undefined, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    const mapped = table.get(hostname);
    if (mapped === undefined) {
      callback(new Error(`no test mapping for ${hostname}`), '', 4);
      return;
    }
    // NODE'S ACTUAL CONTRACT. `node:https` calls a custom lookup with `{ all: true }` and
    // expects an ARRAY of `{address, family}`. Answering with a bare string made every
    // request through the test build fail as `Invalid IP address: undefined` — which is
    // why the AC3/AC4 legs could not reach the stub. Both forms are answered because the
    // single-address form is still the documented one when `all` is not set.
    if (options?.all === true) {
      callback(null, [{ address: mapped, family: 4 }]);
      return;
    }
    callback(null, mapped, 4);
  }) as unknown as LookupFn;
}

export const TEST_RESOLVE_ENV = 'SNUG_MCP_TEST_RESOLVE';
export const TEST_HOLDER_ENV = 'SNUG_MCP_TEST_HOLDER';
/** Pins the brain probe's verdict so the e2e can see a state this machine's CLI is not in. */
export const TEST_BRAIN_ENV = 'SNUG_MCP_TEST_BRAIN';
/**
 * A brain that ANSWERS, pinned to one resolved model id (TASK-20260922 S8). The developer's
 * real CLI answers on whatever it defaults to, so an e2e that used it could not assert which
 * model the chip names. The value is the id the fake reports as having run.
 */
export const TEST_BRAIN_MODEL_ENV = 'SNUG_MCP_TEST_BRAIN_MODEL';
/**
 * The chip's model list for the TEST build, as JSON. The test build never reads the developer's
 * real `~/.claude` catalogue (D-B34's intent): absent = an empty list, i.e. "no catalogue".
 */
export const TEST_MODELS_ENV = 'SNUG_MCP_TEST_MODELS';

/** How long the primary waits after its own session ends, in ms — so an L7 leg takes no three seconds. */
export const TEST_GRACE_ENV = 'SNUG_MCP_TEST_GRACE_MS';
/**
 * The ports to try, comma-separated. One port a test itself holds makes every listen fail
 * for real (`listen-failed`), which the release build's "fixed, then any" can never do.
 */
export const TEST_PORTS_ENV = 'SNUG_MCP_TEST_PORTS';

const numberFrom = (value: string | undefined): number | undefined => {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/* c8 ignore start — the entry half, exercised by the e2e rather than by unit tests */
if (process.env.SNUG_MCP_TEST_ENTRY === '1') {
  const { startProcess } = await import('./process.js');
  const { createFetchProxy } = await import('./fetch-proxy.js');
  const { createNodeHttpsSend } = await import('./node-transport.js');

  const holder = process.env[TEST_HOLDER_ENV];
  const pinnedBrain = process.env[TEST_BRAIN_ENV];
  const pinnedModel = process.env[TEST_BRAIN_MODEL_ENV];
  const graceMs = numberFrom(process.env[TEST_GRACE_ENV]);
  const ports = process.env[TEST_PORTS_ENV]?.split(',').map(Number).filter(Number.isFinite);
  // The SHAPE the real shim answers: SSE frames, the resolved model on the LAST one after the
  // deltas. A fake that answered JSON would let a page-side bug pass (it did once).
  const fakeBrain = {
    stream: async (_request: unknown, sink: { write(chunk: string): void }): Promise<void> => {
      const base = { id: 'chatcmpl-snug-e2e', object: 'chat.completion.chunk', created: 1 };
      // A JSON OBJECT, as a real model answers an app that declares a response schema: the host
      // rejects bare text ("agent reply was not a parseable JSON object"), which once made this
      // fake look like a broken wire. It carries no app-specific fields, so an app treats it as
      // off-script — chess plays a legal move for it and says so.
      const reply = JSON.stringify({ message: 'pinned reply' });
      sink.write(`data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ ...base, model: pinnedModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      sink.write('data: [DONE]\n\n');
    },
  };

  const noBrain = {
    stream: async (): Promise<void> => {
      throw new Error(`the test build has no brain unless ${TEST_BRAIN_MODEL_ENV} pins one`);
    },
  };

  // ONE composition (K5): the same `startProcess` the release entry calls, so the browser
  // suite runs the shipped handshake, grace, parent watch and shutdown. What follows is only
  // what a test needs to stand in for — and what it must never reach.
  await startProcess({
    hooks: {
      // NO `allowRealHome`: the TEST build never gets the real home, not even on an opt-in
      // (D-B34). This is the binary the e2e spawns, and it is the one that once wrote over
      // the owner's user file. Without SNUG_HOME it answers `home-unresolved`.
      // NO `openBrowser`: a suite must never launch the developer's browser.
      ...(holder !== undefined && holder !== '' ? { heldBy: () => holder } : {}),
      // A real `claude` on the developer's machine is logged IN, so the interesting states
      // are unreachable without a pin — and a test that can only observe the happy state
      // cannot tell a working chip from a broken one. UNPINNED there is no probe at all:
      // the real one spawns the developer's CLI and spends their subscription on a suite.
      ...(pinnedBrain !== undefined && pinnedBrain !== ''
        ? { brainState: async () => ({ state: pinnedBrain, detail: `pinned by ${TEST_BRAIN_ENV}` }) }
        : {}),
      // ALWAYS a brain of this build's own. Unpinned, the runner's default is the user's real
      // CLI — and a suite that reached it would spend the developer's subscription on a
      // think nobody asked for. The refusal is the 502 a machine with no CLI answers.
      brain: pinnedModel !== undefined && pinnedModel !== '' ? fakeBrain : noBrain,
      models: () => {
        try {
          const parsed: unknown = JSON.parse(process.env[TEST_MODELS_ENV] ?? '[]');
          return Array.isArray(parsed) ? (parsed as { id: string; name: string; effort: boolean }[]) : [];
        } catch {
          return [];
        }
      },
      proxy: createFetchProxy({ send: createNodeHttpsSend(resolverFromEnv(process.env[TEST_RESOLVE_ENV])) }),
      ...(graceMs !== undefined ? { graceMs } : {}),
      ...(ports !== undefined && ports.length > 0 ? { ports } : {}),
      // The line the browser suite's global setup waits for (`apps/host/e2e/local-setup.ts`).
      // It carries the launch URL, token and all — which is exactly why it exists only in
      // this build: stderr is a host's log, and the release never writes the bearer to one.
      onStarted: (started) => {
        process.stderr.write(
          `${JSON.stringify(
            started.role === 'degraded'
              ? { ready: false, refusal: started.refusal }
              : { ready: true, role: started.role, port: started.port, url: started.url },
          )}\n`,
        );
      },
    },
  });
}
/* c8 ignore stop */
