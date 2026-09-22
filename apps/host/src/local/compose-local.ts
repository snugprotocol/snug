// The local page's platform (ADR-0068 §1, D-B14).
//
// This is the one binding with connected apps, so it is the one that carries `fetchImpl`
// and turns `connections` on. Two absences are as deliberate as anything present:
//
//  * NO `oauth` SEAT. `getPlatform().oauth !== undefined` is the wizard's single
//    "not a browser" discriminator, and setting it disables the popup-blocker escape,
//    installs a handle-less pseudo-popup with no null check, and swaps the register copy.
//    On a real browser page `openExternal` can only be `window.open`, which by then has
//    lost transient activation (the click awaits crypto for PKCE and the state HMAC),
//    returns null, and parks the flow on `awaiting_callback` forever. So the page takes the
//    WEB path, whose redirect URI is `${origin}/oauth/callback` — a route the app already
//    routes and the process already serves.
//  * NO `lanFetch` / `lanHttpPrivate`. The LAN rungs are out of scope for this task, and
//    the executor's own named refusal is the honest answer for a LAN row rather than a
//    silent fallback through the ordinary transport.

import { localAdapter } from '@snugprotocol/adapters';
import { BRAIN_EFFORT_OPTIONS, createBrainChoiceStore, type BrainChoice, type BrainChoiceStore, type BrainEffortChoice } from '../brains/brainChoiceStore.js';
import type { CliModelSeat, CliModelState } from '@playground/platform/platform';

/** `localStorage` where the browser allows it; undefined where it throws (the Safari rung). */
const safeLocalStorage = (): Storage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
import { createFileBackend, type PersistenceBackend } from '@snugprotocol/db';

import type { CustodySeat, CustodyState, SnugPlatform } from '@playground/platform/platform';

import type { LocalClient, LocalStatus } from './client.js';

export interface LocalComposition {
  platform: SnugPlatform;
  /** Set when the file is held by another product: the page shows this instead of opening. */
  refusal?: { heldBy: string };
}

export interface CustodyStoreLike {
  get(): CustodyState;
  subscribe(listener: () => void): () => void;
  patch(next: Partial<CustodyState>): void;
}

/** A tiny store so the chip re-renders when the holder appears or leaves. */
export function createLocalCustodyStore(initial: CustodyState = { dirty: false, readOnly: false }): CustodyStoreLike {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    patch(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
}

const origin = typeof location === 'undefined' ? 'http://127.0.0.1:43127' : location.origin;

/**
 * What the brain chip says (D-B35).
 *
 * The owner's walk found a logged-out CLI surfacing as a bare HTTP 502 the first time an
 * app tried to think — no remedy, and no sign that the BRAIN was the problem rather than
 * the app. The chip is where that belongs, before the user asks for anything.
 *
 * An absent `brain` means the probe has not answered yet, which is NOT a claim that the
 * CLI works: the plain label is what the seat has always said, and the chip corrects
 * itself a moment later when the `status` event arrives.
 */
/**
 * Where the brain probe's late verdict lands (D-B35). The platform is composed once and set
 * once; this holder is what the `status` event writes so the chip's getter can see it.
 */
export const brainState: { current?: { state: string; detail?: string } } = {};

export function brainLabel(brain: { state: string; detail?: string } | undefined): string {
  switch (brain?.state) {
    case 'logged-out':
      // The remedy IS the label: a chip that only says "unavailable" makes the user hunt.
      return 'Claude · your CLI — not logged in, run `claude` then `/login`';
    case 'absent':
      // The remedy in words a non-technical user can follow: a page to visit, then two
      // commands. Never a curl-into-bash line on a chip (ADR-0069 §6).
      return 'demo brain — no Claude CLI found; install Claude Code (code.claude.com), then run `claude` and `/login`';
    case 'outdated':
      // Measured 2026-09-13: a CLI whose default model moved answers every think with a
      // 400 until `claude update` — the CLI's own remedy, so it is the chip's.
      return 'Claude · your CLI — out of date, run `claude update`';
    case 'unknown':
      return 'Claude · your CLI — could not check';
    default:
      return 'Claude · your CLI';
  }
}

/**
 * The chip's control (TASK-20260922 AC5/AC8). `undefined` means NO control: the brain cannot
 * think, so a picker on it would be dead — the user gets the remedy `brainLabel` already
 * carries and nothing else. This is ADR-0067's rule for Binding A and ADR-0036 rule 4 for the
 * playground's selector; three surfaces now agree, so it is not re-litigated here.
 *
 * `activeLabel` is what ANSWERED, never what was asked (ADR-0059 rule 2). A chosen model does
 * not appear until a think has come back on it, because until then the chip would be naming a
 * model that may yet be refused or substituted.
 */
export interface BrainChipSeat {
  /** The thinking levels to offer — the CLI's own `--effort`, not ADR-0067's tiers. */
  efforts: readonly BrainEffortChoice[];
  /** What is running right now, in words. */
  activeLabel: string;
  /** The standing caveats: what the control does not do, and what a switch costs. */
  note: string;
  choice: BrainChoice;
  setModel(model: string | undefined): void;
  setEffort(effort: BrainEffortChoice | undefined): void;
}

export function brainChipSeat(input: { brain: { state: string } | undefined; choices: BrainChoiceStore }): BrainChipSeat | undefined {
  // Anything but a ready brain — including a probe that has not answered yet, which is NOT a
  // claim the CLI works — gets no control (AC8). The demo brain gains nothing.
  if (input.brain?.state !== 'ready') return undefined;
  const { choices } = input;
  const active = choices.active();
  const choice = choices.choice();
  const model =
    active.model !== undefined
      ? active.model
      : // Chosen but unproven: say the CLI's default rather than name a model that has not
        // answered. The asked alias appears only once a think comes back on it.
        'the CLI’s default model';
  const effort = choice.effort ?? 'the CLI’s default effort';
  const refusal = active.refusal === undefined ? '' : ` — ${active.refusal}`;
  return {
    efforts: BRAIN_EFFORT_OPTIONS,
    activeLabel: `thinking on ${model}, effort ${effort}${refusal}`,
    // Honest about what it does NOT do (Q4) and what a switch costs (Q5): no tokens, but the
    // pre-warmed child for the old choice is thrown away, so the next think starts cold.
    note: 'Thinking itself is never shown. A switch takes effect on your next think and spends nothing, but the ready-and-waiting brain is started again, so that think is a little slower.',
    choice,
    setModel: choices.setModel,
    setEffort: choices.setEffort,
  };
}

/**
 * The seat the chip renders (ADR-0070, S7). `undefined` means NO control: the brain cannot
 * think, so a picker on it would be dead and the user gets the remedy `brainLabel` carries
 * and nothing else (AC8 — ADR-0067's rule and ADR-0036 rule 4).
 *
 * `state.get()` must return a STABLE reference while nothing changes: the chip reads it
 * through `useSyncExternalStore`, which re-renders forever on a fresh object each call. The
 * cache below is that stability, recomputed only when the store actually notifies.
 */
/**
 * ONE snapshot per store, recomputed only when the store notifies. `useSyncExternalStore`
 * re-renders forever if `getSnapshot` returns a fresh object each call, and the seat itself is
 * rebuilt on every render (its getter must be, so a late probe verdict reaches the chip) — so
 * the cache cannot live on the seat. It lives here, keyed by the store the seat wraps.
 */
const snapshots = new WeakMap<BrainChoiceStore, { value: CliModelState }>();

function snapshotOf(choices: BrainChoiceStore): CliModelState {
  const existing = snapshots.get(choices);
  if (existing !== undefined) return existing.value;
  const compute = (): CliModelState => {
    const choice = choices.choice();
    const active = choices.active();
    return {
      ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.effort === undefined ? {} : { effort: choice.effort }),
      ...(active.model === undefined ? {} : { activeModel: active.model }),
      ...(active.refusal === undefined ? {} : { refusal: active.refusal }),
    };
  };
  const cell = { value: compute() };
  snapshots.set(choices, cell);
  // Subscribed ONCE per store, not once per render: the seat is rebuilt constantly and a
  // subscription there would leak a listener on every render.
  choices.subscribe(() => {
    cell.value = compute();
  });
  return cell.value;
}

/**
 * The seat the chip renders (ADR-0070, S7). `undefined` means NO control: the brain cannot
 * think, so a picker on it would be dead and the user gets the remedy `brainLabel` carries
 * and nothing else (AC8 — ADR-0067's rule and ADR-0036 rule 4).
 */
export function cliModelSeat(input: { brain: { state: string } | undefined; choices: BrainChoiceStore }): CliModelSeat | undefined {
  const chip = brainChipSeat(input);
  if (chip === undefined) return undefined;
  const { choices } = input;
  snapshotOf(choices);
  return {
    efforts: chip.efforts,
    activeLabel: chip.activeLabel,
    note: chip.note,
    state: { get: () => snapshotOf(choices), subscribe: choices.subscribe },
    setModel: choices.setModel,
    setEffort: choices.setEffort,
  };
}

export function composeLocalPlatform(
  client: LocalClient,
  status: LocalStatus,
  /**
   * The sql.js engine as bytes. Both builds swap the `?url` locator for a stub that must
   * never run, so the engine can ONLY arrive through this seat — without it the user db
   * never opens and the page renders an empty shell with a console error. Caught by the
   * first real-browser run; no unit test could see it, because every one of them injects
   * its own backend.
   */
  sqlJsWasmBinary?: Uint8Array,
  backendOverride?: PersistenceBackend,
  /** The bearer, so the brain adapter can reach the shim on the same origin. */
  token?: string,
  /**
   * The user's per-machine model and effort choice (TASK-20260922). Injectable so tests can
   * drive it; in the page it is one store per boot over `localStorage`.
   */
  brainChoices: BrainChoiceStore = createBrainChoiceStore({ storage: safeLocalStorage() }),
): LocalComposition {
  // The holder check decides whether we open AT ALL. Both of the db's save paths swallow a
  // failed write with a bare `catch`, and no persist-error seam exists — so a page that
  // opened read-only would take an hour of the user's work and lose it on tab close.
  if (status.heldBy !== undefined) {
    return {
      refusal: { heldBy: status.heldBy },
      platform: minimalPlatform(),
    };
  }

  const custody = createLocalCustodyStore({ dirty: false, readOnly: false });
  const custodySeat: CustodySeat = {
    state: custody,
    dismissNote: () => custody.patch({ note: undefined }),
  };

  return {
    platform: {
      kind: 'host',
      binding: 'local-host',
      // The one binding whose page can reach the network — through the process, which
      // re-runs the executor's own gates on the far side of the socket.
      fetchImpl: (input, init) => client.fetchImpl(input, init),
      ...(sqlJsWasmBinary !== undefined ? { sqlJsWasmBinary } : {}),
      // THE BRAIN (D5, D-B7). The user's own `claude` CLI behind the process's shim,
      // reached through the adapter the playground already has — `localAdapter` accepts a
      // key, and the host arm of `createTurnAdapter` reads no BYOK key and skips the F15
      // endpoint confirm, so no mode, setting or secret is involved. `streaming: false` is
      // an app-facing declaration in `host-ready`, not a transport switch: the shim answers
      // SSE regardless, because `openaiAdapter` always streams.
      ...(token !== undefined
        ? {
            brain: {
              kind: 'host' as const,
              // A GETTER, not a value. The probe answers after boot (it spawns the user's
              // CLI), and the platform is set ONCE — `setPlatform` throws on a second call
              // and on any call after `getPlatform` has been read, so a page cannot swap in
              // a recomposed platform to update this. The chip reads `label` at render, so
              // a getter over a mutable holder lets a late verdict reach the user without
              // touching the singleton.
              get label(): string {
                return brainLabel(brainState.current ?? status.brain);
              },
              // The adapter is rebuilt PER CALL, not once: `localAdapter` takes a static
              // model, and a value read at composition time would freeze the user's choice
              // until a reload — ADR-0036 rule 3, and what makes "switch now, it lands on
              // your next think" true. The effort rides beside it on the same request.
              adapter: {
                complete: (request) => {
                  const choice = brainChoices.choice();
                  return localAdapter({ baseUrl: `${origin}/v1`, apiKey: token, model: choice.model ?? 'claude', fetch: (input, init) => client.fetchImpl(input, init) }).complete(
                    choice.effort === undefined ? request : ({ ...request, effort: choice.effort } as typeof request),
                  );
                },
              },
              streaming: false,
              tools: false,
              // The model + effort control (ADR-0070). A GETTER for the same reason `label` is
              // one: the probe answers AFTER boot and the platform is set once, so a value
              // computed here would be read while the brain state is still unknown and the
              // control would never appear (caught by a test, not by review). Present only
              // while the CLI can think — `cliModelSeat` returns undefined for every other
              // state, so a brain that stops being able to think loses its control rather
              // than keeping a dead one (AC8).
              get cliModel(): CliModelSeat | undefined {
                return cliModelSeat({ brain: brainState.current ?? status.brain, choices: brainChoices });
              },
            },
          }
        : {}),
      userdbBackend: backendOverride ?? createFileBackend(client.fs, 'Snug'),
      custody: custodySeat,
      capabilities: {
        subscriptionMode: false,
        hubSyncOrigin: false,
        lanHttpPrivate: false,
        hubAuth: false,
        // D15: the brain is the host's and is never chosen.
        brainSettings: false,
        account: false,
        sync: false,
        // THE difference from Binding A. `RunView` keys its net handler on this, so
        // `host-ready.net` becomes true structurally rather than by a flag an app must trust.
        connections: true,
        // The relay is reachable from a browser, but no acceptance criterion covers it here.
        share: false,
        appExport: true,
      },
    },
  };
}

/** What the page carries when it is refusing to open: enough to render the refusal, no seams. */
function minimalPlatform(): SnugPlatform {
  return {
    kind: 'host',
    binding: 'local-host',
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
      appExport: false,
    },
  };
}
