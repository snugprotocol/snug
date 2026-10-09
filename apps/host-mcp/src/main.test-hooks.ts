// The TEST entry (D-B11) — never shipped.
//
// The e2e drives the real process against a self-signed stub on 127.0.0.1 answering for
// `stub.snug.test`. Three things make that possible, and all are hooks that must not exist
// in the release bundle: a DNS resolver, a holder override so the read-only path can be
// exercised without running Snug Desktop, and FAKE BRAINS — so a suite can see every state
// a brain can be in, and can never reach the developer's real CLIs.
//
// A resolved-address check in the proxy would refuse this stub outright — which is one
// reason (besides its being a new policy the desktop lacks) the proxy has none. The release
// bundle is swept by `check-host-mcp` for the PREFIX every name below shares, so a hook
// added here is covered the day it is added.

import { chatFrames, isModelId, type Brain, type BrainDriver, type BrainModel, type BrainReadiness, type BrainState } from './brains/brain.js';
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
/**
 * The TEST build's brains, as a JSON array of
 * `{ id, name, via, state, detail?, verified, streaming?, efforts?, models?, reply?, resolvedModel?, afterRecheck? }`
 * — one fake driver each, in order (ADR-0071). A real `claude` on the developer's machine
 * is logged IN, so the interesting states are unreachable without a fake, and a test that
 * can only observe the happy state cannot tell a working chip from a broken one. ABSENT
 * there is no brain at all: the test build never has a default that could reach a real CLI.
 */
export const TEST_BRAINS_ENV = 'SNUG_MCP_TEST_BRAINS';

/** How long the primary waits after its own session ends, in ms — so an L7 leg takes no three seconds. */
export const TEST_GRACE_ENV = 'SNUG_MCP_TEST_GRACE_MS';
/**
 * The ports to try, comma-separated. One port a test itself holds makes every listen fail
 * for real (`listen-failed`), which the release build's "fixed, then any" can never do.
 */
export const TEST_PORTS_ENV = 'SNUG_MCP_TEST_PORTS';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isModels = (value: unknown): value is BrainModel[] =>
  Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.id === 'string' && typeof entry.name === 'string' && isStrings(entry.efforts));

/**
 * The fake drivers a spec asked for. A spec that cannot be read THROWS: a typo that quietly
 * meant "no brain" would turn a spec's failure into a pass of the demo-brain path.
 *
 * A fake with a `reply` answers every think with it, in the frames the real brains write —
 * a fake that answered plain JSON once let a page-side bug pass — and reports
 * `resolvedModel` (default `<id>-fake`) as the model that ran. One without refuses by name.
 * `afterRecheck: { state, detail? }` is what its probe answers from the SECOND round on: a
 * brain the user fixed (or broke) while the page was open.
 */
export function fakeDriversFromEnv(spec: string | undefined): BrainDriver[] {
  if (spec === undefined || spec.trim() === '') return [];
  const malformed = (why: string): Error => new Error(`${TEST_BRAINS_ENV} ${why}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    throw malformed('is not JSON');
  }
  if (!Array.isArray(parsed)) throw malformed('must be an array of brains');

  return parsed.map((entry: unknown): BrainDriver => {
    if (!isRecord(entry)) throw malformed('holds an entry that is not an object');
    const { id, name, via, state, detail, verified, streaming = true, efforts = [], models = [], reply, resolvedModel, afterRecheck } = entry;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof via !== 'string' || typeof state !== 'string' || typeof verified !== 'boolean' || typeof streaming !== 'boolean') {
      throw malformed('needs id, name, via and state as strings and verified as a boolean on every brain');
    }
    if ((detail !== undefined && typeof detail !== 'string') || (reply !== undefined && typeof reply !== 'string') || (resolvedModel !== undefined && typeof resolvedModel !== 'string')) {
      throw malformed('takes detail, reply and resolvedModel as strings');
    }
    if (!isStrings(efforts) || !isModels(models)) throw malformed('takes efforts as strings and models as { id, name, efforts }');
    if (afterRecheck !== undefined && !(isRecord(afterRecheck) && typeof afterRecheck.state === 'string' && (afterRecheck.detail === undefined || typeof afterRecheck.detail === 'string'))) {
      throw malformed('takes afterRecheck as { state, detail? }');
    }
    // Passed through as written — an unknown state is how a spec shows the page one.
    const readiness = (verdict: Record<string, unknown>): BrainReadiness => ({ state: verdict.state as BrainState, ...(typeof verdict.detail === 'string' ? { detail: verdict.detail } : {}) });
    let rounds = 0;

    const brain: Brain = {
      async stream(_request, sink) {
        if (reply === undefined) throw new Error(`the test build’s fake "${id}" brain has no reply — give it one in ${TEST_BRAINS_ENV}`);
        const frames = chatFrames(id);
        sink.write(frames.content(reply));
        sink.write(frames.finish(resolvedModel ?? `${id}-fake`, 'stop'));
        sink.write(frames.done);
      },
      async complete(request) {
        let body = '';
        await brain.stream(request, { write: (chunk) => (body += chunk) });
        return body;
      },
      stop() {},
    };

    return {
      id,
      name,
      via,
      verified,
      streaming,
      probe: async () => {
        rounds += 1;
        return readiness(rounds > 1 && isRecord(afterRecheck) ? afterRecheck : { state, detail });
      },
      catalog: () => ({ efforts, models }),
      acceptsModel: isModelId,
      acceptsEffort: (model, effort) => (models.find((listed) => listed.id === model)?.efforts ?? efforts).includes(effort),
      create: () => brain,
    };
  });
}

const numberFrom = (value: string | undefined): number | undefined => {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/* c8 ignore start — the entry half, exercised by the e2e rather than by unit tests */
if (process.env.SNUG_MCP_TEST_ENTRY === '1') {
  const { startProcess } = await import('./process.js');
  const { createFetchProxy } = await import('./fetch-proxy.js');
  const { createNodeHttpsSend } = await import('./node-transport.js');

  const { createBrainRegistry } = await import('./brains/registry.js');

  const holder = process.env[TEST_HOLDER_ENV];
  const drivers = fakeDriversFromEnv(process.env[TEST_BRAINS_ENV]);
  const graceMs = numberFrom(process.env[TEST_GRACE_ENV]);
  const ports = process.env[TEST_PORTS_ENV]?.split(',').map(Number).filter(Number.isFinite);

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
      // ONLY fakes, and only the ones the spec named. This build has no path to the machine's
      // real CLIs: a suite that reached one would spend the developer's subscription on a
      // think nobody asked for (it once did, at every start).
      brains: () => createBrainRegistry({ drivers }),
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
