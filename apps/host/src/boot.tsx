// boot.tsx — the ONE boot for every binding (TASK-20261003 K1/K2/K4, ADR-0072 §1–§3).
//
// There used to be two entries and two pages: the artifact kit, whose binding was decided
// at runtime, and a "local" page built separately for the runner, whose binding was decided
// by which html file Vite was pointed at. One page now, and the binding is a runtime fact
// decided HERE, once, in this order:
//
//   1. THE OAUTH CALLBACK. `location.pathname === '/oauth/callback'` → the callback page,
//      alone. A provider redirects the user's browser to that PATH; the kit's router is a
//      hash router and never looks at a path, so that document rendered the HUB and a
//      sign-in on the runner could never complete (found 2026-10-03). Nothing else happens
//      in this document: no token claim, no `/status`, no platform, no db, no event stream —
//      it is a popup whose whole job is to post one message and close.
//   2. THE RUNNER, asked for ONLY at the literal `http://127.0.0.1` — the one origin the
//      local host process serves. The page claims a launch token if the address carries
//      one and asks its own origin for `/status`, once, bounded. A runner's status → the
//      local composition. A refusal carrying the runner's marker → "open it from your
//      agent". Anything else — another status, not JSON, no answer inside the bound — is
//      NOT a runner, and falls through.
//   3. EVERYTHING ELSE: the probe (an artifact — published or chat-created, one hosted
//      runtime — a static copy, a plain file) and the hosted composition, as before.
//
// `planBoot` is the decision, pure over an injected window and document so each branch is
// tested without a browser; `boot` renders what it decided, through `mountKit` — the one
// path both compositions mount by.

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { UserDb } from '@snugprotocol/db';

import { App } from '@playground/App';
import { OAuthCallbackPage } from '@playground/connections/OAuthCallbackPage';
import { setPlatform, type SnugPlatform } from '@playground/platform/platform';
import { bumpLibraryRevision } from '@playground/platform/signals';
import { refreshAppMeta } from '@playground/state/appMeta';
import { getUserDb } from '@playground/state/userdb';

import { composeHostPlatform, handInBeforePaint, type ComposeDocument, type Composition } from './compose.js';
import { describeHandIn } from './handin.js';
import { claimTokenFromFragment, createLocalClient, isRunnerRefusal, parseLocalStatus, type LocalClient, type LocalStatus } from './local/client.js';
import { applyRunnerStatus, composeLocalPlatform, type LocalComposition } from './local/compose-local.js';
import { applyHandInEvent, type HandInEvent } from './local/handinEvents.js';
import { LocalRefusal, type LocalRefusalProps } from './local/LocalRefusal.js';
import { runProbe, type ProbeResult, type ProbeWindowLike } from './probe.js';
import { KitRouter, pickRouter, type RouterChoice, type RouterWindow } from './router.js';
import { safeSessionStorage } from './safeStorage.js';
import { sqlJsWasmBinary } from './wasmBytes.js';

/** The path a provider redirects to (`${origin}/oauth/callback` — the wizard's registered URI). */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/**
 * How long the page waits for its own origin to answer `/status`. A runner on loopback
 * answers in a few milliseconds (it waits at most 250 ms for a fast brain probe to ride
 * the same read); a static server answers its 404 as fast. The bound is for the origin
 * that accepts the connection and says nothing — the page must still open, as a plain file.
 */
export const RUNNER_STATUS_BOUND_MS = 1_500;

/** What the boot reads off `window`. */
export interface BootWindow extends ProbeWindowLike, RouterWindow {
  location: { protocol: string; hostname: string; pathname: string; hash: string; search: string; href: string; reload?: () => void };
  history: { state: unknown; replaceState(state: unknown, unused: string, url: string): void };
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * THE one origin a runner serves, as literals. Not "a loopback host": `localhost` can be
 * pointed elsewhere by a hosts file, `[::1]` and `0.0.0.0` are addresses the process never
 * binds, another `127.x` address is another listener, and an `https:` or `file:` page was
 * not served by it at all. A page at any of those must neither offer its address's
 * fragment as a bearer nor ask the origin who it is.
 */
export function isRunnerOrigin(location: { protocol: string; hostname: string }): boolean {
  return location.protocol === 'http:' && location.hostname === '127.0.0.1';
}

export type RunnerAnswer =
  /** Not a runner (or not an origin one could be at): the probe decides what this page is. */
  | { kind: 'none' }
  /** A runner answered and will not let this page in. */
  | { kind: 'refused' }
  | { kind: 'runner'; token: string; status: LocalStatus };

/** Ask the page's own origin whether it is the runner. ONE request, bounded; never throws. */
export async function askRunner(win: Pick<BootWindow, 'location' | 'history' | 'fetch' | 'sessionStorage'>, options: { boundMs?: number } = {}): Promise<RunnerAnswer> {
  if (!isRunnerOrigin(win.location)) return { kind: 'none' };
  // Claimed BEFORE the request, and before anything reads `location.hash`: the fragment is
  // stripped from the address bar here, so the router never sees `#token=…` as a route.
  const token = claimTokenFromFragment({ location: win.location, history: win.history, sessionStorage: safeSessionStorage(win) });
  const controller = new AbortController();
  const bound = setTimeout(() => controller.abort(), options.boundMs ?? RUNNER_STATUS_BOUND_MS);
  try {
    const response = await win.fetch('/status', { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
    if (response.status === 200) {
      const status = parseLocalStatus(await response.json());
      // A 200 that is not the runner's shape is some other server's `/status`.
      return status !== undefined && token !== undefined ? { kind: 'runner', token, status } : { kind: 'none' };
    }
    // Only a refusal the RUNNER signed: a static server's 401, or anyone's 403, is not it.
    if ((response.status === 401 || response.status === 403) && isRunnerRefusal(response)) return { kind: 'refused' };
    return { kind: 'none' };
  } catch {
    // No answer inside the bound, nothing listening, a body that is not JSON.
    return { kind: 'none' };
  } finally {
    clearTimeout(bound);
  }
}

export type BootPlan =
  | { kind: 'oauth-callback' }
  | { kind: 'refusal'; refusal: LocalRefusalProps; platform?: SnugPlatform }
  | { kind: 'runner'; client: LocalClient; composition: LocalComposition }
  | { kind: 'hosted'; probe: ProbeResult; composition: Composition };

export interface BootDeps {
  probe?: typeof runProbe;
  /** The sql.js engine as bytes. A test hands in a stub rather than the real megabyte. */
  wasm?: () => Uint8Array;
  createClient?: typeof createLocalClient;
}

/** The decision (see the header). Reads the document ONLY on the hosted path. */
export async function planBoot(win: BootWindow, doc: ComposeDocument, deps: BootDeps = {}): Promise<BootPlan> {
  if (win.location.pathname === OAUTH_CALLBACK_PATH) return { kind: 'oauth-callback' };

  const wasm = deps.wasm ?? sqlJsWasmBinary;
  const runner = await askRunner(win);
  if (runner.kind === 'refused') return { kind: 'refusal', refusal: { kind: 'no-token' } };
  if (runner.kind === 'runner') {
    // UNDER THE RUNNER THE PAGE'S OWN BLOCKS ARE NOT READ (K6): no embedded bundle, no
    // `snug-db`. The file is the runner's, and apps arrive as its events. The page it
    // serves is the same file the artifact route hands in to, so a copy that carried
    // blocks would otherwise install them here — from a document, into a real file.
    const client = (deps.createClient ?? createLocalClient)(runner.token);
    const composition = composeLocalPlatform(client, runner.status, wasm(), undefined, runner.token);
    // The file is held by Snug for Mac. We do NOT open read-only: the db swallows failed
    // saves, so the user would work for an hour and lose it.
    if (composition.refusal !== undefined) return { kind: 'refusal', refusal: { kind: 'held', heldBy: composition.refusal.heldBy }, platform: composition.platform };
    return { kind: 'runner', client, composition };
  }

  const probe = await (deps.probe ?? runProbe)(win);
  const composition = composeHostPlatform(
    probe,
    {
      location: win.location,
      fetch: (input, init) => win.fetch(input, init),
      sessionStorage: safeSessionStorage(win),
      ...(win.location.reload !== undefined ? { reload: () => win.location.reload?.() } : {}),
    },
    doc,
    wasm(),
  );
  return { kind: 'hosted', probe, composition };
}

/**
 * The one mount (K4): install the platform BEFORE any playground module reads it, wait —
 * bounded by the caller — for whatever must land before the first paint, then render the
 * playground's App under the router this document can run.
 */
export async function mountKit(root: Root, kit: { platform: SnugPlatform; router: RouterChoice; beforePaint?: () => Promise<unknown> }): Promise<void> {
  setPlatform(kit.platform);
  await kit.beforePaint?.();
  root.render(
    <StrictMode>
      <KitRouter choice={kit.router}>
        <App />
      </KitRouter>
    </StrictMode>,
  );
}

/** What the runner pushes while the page is up: a late verdict on the brain, an app handed in. */
export function followRunner(client: LocalClient, composition: LocalComposition, getDb: () => Promise<UserDb> = getUserDb): () => void {
  return client.events((name, data) => {
    // The brain probe answers AFTER boot (it spawns the user's CLI, and a wedged one must
    // not hold the kit shut), so its verdict — and the model list — arrive here.
    if (name === 'status') {
      applyRunnerStatus(data);
      return;
    }
    if (name !== 'hand-in') return;
    // Hand-ins arrive at any time: while the user sits on the hub, or inside the app being
    // updated. The bundle is APPLIED (not merely noticed), the surfaces are told through
    // the revision they subscribe to, and the runner is told what became of it.
    void applyHandInEvent(data as HandInEvent, {
      getDb,
      handIns: composition.handIns,
      onNote: (note) => composition.custody.patch({ note }),
      onLibraryChanged: async () => {
        await refreshAppMeta();
        bumpLibraryRevision();
      },
      report: (report) => client.reportHandIn(report),
    }).catch((error: unknown) => {
      // Nothing awaits this — it runs off the event stream — so a failure nobody foresaw
      // (every foreseen one is an outcome, above) would be an unhandled rejection and a
      // hand-in that went nowhere without a word. Said where a refusal is said.
      composition.custody.patch({ note: `the handed-in app could not be applied: ${error instanceof Error ? error.message : String(error)}` });
    });
  });
}

export async function boot(win: BootWindow & { document: Document } = window as unknown as BootWindow & { document: Document }): Promise<void> {
  const container = win.document.getElementById('root');
  if (container === null) throw new Error('missing #root');
  const root = createRoot(container);

  const plan = await planBoot(win, win.document);
  switch (plan.kind) {
    case 'oauth-callback':
      // Not under StrictMode: the page's one effect IS its job — post the delivery, close
      // the window — and a development build would run it twice.
      root.render(<OAuthCallbackPage />);
      return;

    case 'refusal':
      if (plan.platform !== undefined) setPlatform(plan.platform);
      root.render(<LocalRefusal {...plan.refusal} />);
      return;

    case 'runner': {
      const { client, composition } = plan;
      // K7: a runner that went away is SAID, and the page takes no further edits — the App
      // is unmounted, because the db swallows a failed save and would otherwise go on
      // accepting work it can no longer keep.
      const sayStopped = (): void => root.render(<LocalRefusal kind="stopped" />);
      client.stopped.subscribe(sayStopped);
      followRunner(client, composition);
      await mountKit(root, { platform: composition.platform, router: pickRouter(win) });
      // A runner that went away while the kit was mounting: the refusal is the last word.
      if (client.stopped.get()) sayStopped();
      return;
    }

    case 'hosted': {
      const { probe, composition } = plan;
      // The first hosted walk records what the viewer injected into the document, so the
      // canonical-source verification's premise is a measured fact (plan review A1).
      console.info('[snug-host] boot', {
        binding: probe.binding,
        storage: probe.storage.kind,
        brain: probe.brain.brain.kind,
        legs: probe.brain.legs,
        scripts: [...win.document.scripts].map((s) => `${s.type || 'classic'}${s.src ? ` src=${s.src}` : ''}${s.id ? ` #${s.id}` : ''}`),
      });
      await mountKit(root, {
        platform: composition.platform,
        router: pickRouter(win),
        // The hand-in: after the user db opens, never before — and BEFORE the first paint
        // when the db opens promptly, so the hub's first render already lists what the
        // agent handed in. A db that cannot open (corrupt, locked) never resolves
        // `getUserDb()`, so the wait is bounded: past it the App renders its recovery
        // surface and the hand-in lands whenever the db does (the hub then follows the
        // library revision). Its outcome is one note on the custody chip; a refusal is
        // named there too, never a crash.
        beforePaint: () =>
          handInBeforePaint(
            getUserDb()
              .then(async (db) => {
                const outcome = await composition.handIn(db);
                const note = describeHandIn(outcome);
                if (note !== undefined) composition.custody.patch({ note });
                if (outcome.installed.length > 0 || outcome.updated.length > 0) {
                  await refreshAppMeta();
                  bumpLibraryRevision();
                }
              })
              .catch((error: unknown) => {
                composition.custody.patch({ note: `the handed-in apps could not be read: ${error instanceof Error ? error.message : String(error)}` });
              }),
          ),
      });
      return;
    }
  }
}
