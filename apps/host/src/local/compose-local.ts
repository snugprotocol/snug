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
//
// What it SHARES with the probe-path composition (`compose.ts`), since TASK-20261003 (K4):
// the capability table, the custody store and the hand-in seat are the kit's ONE of each —
// this module used to hand-write the first twice and keep private copies of the others.
//
// THE BRAIN (ADR-0069 §5, ADR-0071). The runner reports every agent the user already has
// (`brains[]`) and which one `auto` would use (`active`); the user's own choice — `auto`, or
// a pin — and each brain's model and level live in this browser (`brainChoiceStore`). From
// those two this module derives, and re-derives whenever either changes:
//   · `platform.brain`       — the host arm while the choice resolves to a ready brain, the
//                              demo brain otherwise (D4: never a think sent to a brain that
//                              is known not to be there);
//   · `platform.brainSwitch` — what the chip renders and acts through, whatever answers.
// The page MIRRORS the runner's selection rule and never out-votes it: a think the runner
// cannot place comes back as its own named refusal and makes the page look again.

import { localAdapter } from '@snugprotocol/adapters';
import { createFileBackend, type PersistenceBackend } from '@snugprotocol/db';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { BRAIN_AUTO, brainLevels, brainReadyState, demoStandIn } from '@playground/platform/copy';
import { hostCapabilities } from '@playground/platform/hostCapabilities';
import type { BrainSwitchSeat, BrainSwitchState, CustodySeat, PlatformBrain, SnugPlatform } from '@playground/platform/platform';
import { bumpBrainRevision } from '@playground/platform/signals';
import { createStore } from '@playground/state/store';

import { LEGACY_BRAIN, createBrainChoiceStore, type BrainChoiceState, type BrainChoiceStore, type BrainPrefs } from '../brains/brainChoiceStore.js';
import { createHandInSeat, type HandInSeat } from '../handin.js';
import { schedulerSeatFor } from '../platform-host.js';
import { safeLocalStorage } from '../safeStorage.js';
import { createCustodyStore, type CustodyStore } from '../storage/custodyStore.js';
import { parseStatusEvent, type BrainWire, type LocalClient, type LocalStatus } from './client.js';

export interface LocalComposition {
  platform: SnugPlatform;
  /** Set when the file is held by another product: the page shows this instead of opening. */
  refusal?: { heldBy: string };
  /** The store the "your file" chip reads — the kit's ONE custody store; a hand-in's note is patched onto it. */
  custody: CustodyStore;
  /** The offers for edited copies (ADR-0045 §7) — the seat Binding A has always had. */
  handIns: HandInSeat;
}

const origin = typeof location === 'undefined' ? 'http://127.0.0.1:43127' : location.origin;

/** What the runner says about its brains: every one it knows, and the one `auto` would use. */
export type RunnerBrains = Pick<LocalStatus, 'active' | 'brains'>;

/**
 * Where a late `status` lands (D-B35). The probes answer after boot — each spawns an agent's
 * CLI, and a wedged one must not hold the kit shut — and the platform is set ONCE:
 * `setPlatform` throws on a second call and on any call after `getPlatform` has been read,
 * so the page cannot recompose to learn what they found. The composition leaves its door
 * here and the boot's event handler knocks. One page, one composition.
 */
let landStatus: ((status: RunnerBrains) => void) | undefined;

/**
 * Fold a late `status` in — each brain's verdict, its catalogue — and say that what the
 * platform's `brain` answers may have changed (D4). It replaces three DOM `CustomEvent`s
 * that nothing listened to, which is why the chip kept its boot label until something else
 * happened to re-render it. A frame that is not a status changes nothing.
 */
export function applyRunnerStatus(data: unknown): void {
  const status = parseStatusEvent(data);
  if (status !== undefined) landStatus?.(status);
}

/** The demo arm. ONE object: `useMemo` and `useSyncExternalStore` compare it by reference. */
const DEMO_BRAIN: PlatformBrain = { kind: 'demo' };

/**
 * The least time between two "the demo brain is standing in — look again" asks from this
 * page. The runner keeps its own floor for every ask (a probe of a ready brain is a real
 * think); this one keeps a page the user keeps coming back to from asking each time.
 */
export const DEMO_RECHECK_FLOOR_MS = 30_000;

/**
 * How long "check again" shows itself working before it stops waiting. The runner probes at
 * most once per floor and OWES an ask made inside it, and a probe is a spawn of the agent's
 * CLI — so the fresh status can be most of a minute away. A status that lands later still
 * lands; this bounds only the progress mark.
 */
export const RECHECK_BOUND_MS = 45_000;

/** The header the chat route answers with: the brain that ANSWERED (ADR-0071, B2). */
const BRAIN_HEADER = 'x-snug-brain';

/**
 * The standing caveats, honest about what the controls do NOT do (ADR-0070 Q4) and what a
 * switch costs (Q5): no tokens, but a child kept warm for the old choice is thrown away.
 */
const SWITCH_NOTE =
  'Thinking itself is never shown. A switch takes effect on your next think and spends nothing; that think may start a little slower, because a brain kept ready for the old choice is started again.';

/**
 * WHICH brain a think sent now would run on — the runner's rule, mirrored (ADR-0071 §4):
 *
 *  · `auto` is whatever the runner calls `active`: its default brain when that is ready,
 *    else NONE. Never the next ready brain — an app's think carries the user's data, and
 *    sending it to another vendor because the first was logged out is a re-route nobody
 *    asked for. And never an UNVERIFIED brain: the runner does not name one as `active`,
 *    and a status that did would not be followed.
 *  · a pin is that brain while it is `ready`, else NONE — never another brain.
 *
 * `undefined` is NONE: the demo brain answers, and the chip says why.
 */
export function brainFor(choice: string, status: RunnerBrains): BrainWire | undefined {
  if (choice === BRAIN_AUTO) {
    const active = status.brains.find((brain) => brain.id === status.active);
    return active?.verified === true ? active : undefined;
  }
  const pinned = status.brains.find((brain) => brain.id === choice);
  return pinned?.state === 'ready' ? pinned : undefined;
}

/**
 * What a think on this brain carries: the stored model, and the stored level ONLY while
 * that model has it. A level kept from an older catalogue, or chosen for a model the user
 * has since left, is neither sent nor shown — the runner validates a level against the
 * driver and answers a bad one with a 400, so sending it would turn every think into a
 * refusal for a setting the user can no longer see (AC8). It stays stored: going back to
 * the model it belongs to brings it back.
 */
export function prefsFor(brain: BrainWire, stored: BrainPrefs | undefined): BrainPrefs {
  const model = stored?.model;
  const effort = stored?.effort !== undefined && brainLevels(brain, model).includes(stored.effort) ? stored.effort : undefined;
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/**
 * What the chip calls the answering brain: `<Name> · <model>` (S11, owner 2026-10-02:
 * "replace 'your CLI' with the current selected model"). The model is the SELECTED one —
 * it is what the next think carries; with nothing selected, the one the brain actually ran
 * once a think has answered; before that, nothing (`your CLI`). Shown by the catalogue's
 * display name where it lists the id, else the id itself. The CLI reports its default with
 * a context suffix (measured: `claude-opus-5-5[1m]`), so the suffix is ignored for the lookup.
 *
 * The popover's own line is unchanged and still says what ANSWERED (ADR-0059 rule 2).
 */
export function brainLabel(brain: BrainWire, model: string | undefined): string {
  if (model === undefined) return `${brain.name} · your CLI`;
  const bare = model.replace(/\[[^\]]*\]$/, '');
  return `${brain.name} · ${brain.models.find((listed) => listed.id === bare)?.name ?? model}`;
}

/** The model the label names for this brain: chosen, else what it answered on. */
function labelModel(brain: BrainWire, choices: BrainChoiceState): string | undefined {
  return choices.prefs[brain.id]?.model ?? (choices.answered?.brain === brain.id ? choices.answered.model : undefined);
}

/** What the chip renders, derived whole from the two sources — never kept beside them (ADR-0059 rule 2). */
function switchStateOf(status: RunnerBrains, choices: BrainChoiceState, checking: boolean): BrainSwitchState {
  const answering = brainFor(choices.choice, status);
  const prefs = answering === undefined ? {} : prefsFor(answering, choices.prefs[answering.id]);
  // A refusal belongs to the brain that gave it. It is shown while that brain is the one
  // answering, or while none is — never under another brain's controls.
  const refusal = choices.refused !== undefined && (answering === undefined || answering.id === choices.refused.brain) ? choices.refused.message : undefined;
  return {
    choice: choices.choice,
    ...(answering !== undefined ? { active: answering.id } : {}),
    brains: status.brains,
    ...(prefs.model !== undefined ? { model: prefs.model } : {}),
    ...(prefs.effort !== undefined ? { effort: prefs.effort } : {}),
    ...(choices.answered !== undefined ? { answered: choices.answered } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    checking,
  };
}

/** The chat request's JSON body with the page's own fields added. The shared OpenAI adapter builds that body from a fixed set of fields, so a field put on the REQUEST object is silently dropped (the level was, from S5 until the owner's walk). */
function withBody(init: RequestInit | undefined, fields: Record<string, unknown>): RequestInit | undefined {
  if (init === undefined || typeof init.body !== 'string') return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return { ...init, body: JSON.stringify({ ...body, ...fields }) };
  } catch {
    return init;
  }
}

/** The runner's own sentence for a think it did not answer: `{ error: { message } }`. Anything else says nothing. */
async function refusalOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message !== '' ? message : undefined;
  } catch {
    return undefined;
  }
}

export function composeLocalPlatform(
  client: LocalClient,
  status: LocalStatus,
  /**
   * The sql.js engine as bytes. The build swaps the `?url` locator for a stub that must
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
   * The user's per-machine brain choice (TASK-20260922, TASK-20261003). Injectable so tests
   * can drive it; in the page it is one store per boot over `localStorage`.
   */
  brainChoices?: BrainChoiceStore,
): LocalComposition {
  const custody = createCustodyStore();
  const handIns = createHandInSeat();
  // A page that is being composed is the page: an earlier composition's door closes.
  landStatus = undefined;

  // The holder check decides whether we open AT ALL. Both of the db's save paths swallow a
  // failed write with a bare `catch`, and no persist-error seam exists — so a page that
  // opened read-only would take an hour of the user's work and lose it on tab close.
  if (status.heldBy !== undefined) {
    return { refusal: { heldBy: status.heldBy }, platform: minimalPlatform(), custody, handIns };
  }

  const custodySeat: CustodySeat = {
    state: custody,
    dismissNote: () => custody.patch({ note: undefined }),
  };

  const platform: SnugPlatform = {
    kind: 'host',
    binding: 'local-host',
    // The one binding whose page can reach the network — through the process, which
    // re-runs the executor's own gates on the far side of the socket.
    fetchImpl: (input, init) => client.fetchImpl(input, init),
    ...(sqlJsWasmBinary !== undefined ? { sqlJsWasmBinary } : {}),
    userdbBackend: backendOverride ?? createFileBackend(client.fs, 'Snug'),
    custody: custodySeat,
    // K6: an edited copy's update is OFFERED in the run header, exactly as under Binding A.
    // This seat was missing here, so on the runner such a hand-in was announced on a chip
    // note and then could not be taken anywhere.
    agentHandIns: handIns.seat,
    // The scheduler's seat (TASK-20261009 H3): the runner's page is a tab, so the honesty
    // line's subject is "this page"; page-bound; no notify — the page cannot raise one.
    scheduler: schedulerSeatFor('local-host'),
    capabilities: hostCapabilities({
      // THE difference from Binding A. `RunView` keys its net handler on this, so
      // `host-ready.net` becomes true structurally rather than by a flag an app must trust.
      connections: true,
      // Whether a provider's redirect can come back: the runner says `false` when the port
      // a user registers was taken (ADR-0068 D-B13), and the `oauth` offer — every sign-in
      // tile, the wizard's wall — reads this. An older wire that does not say is available.
      oauthRedirect: status.oauthRedirect !== false,
    }),
  };

  if (token !== undefined) {
    // THE TWO SOURCES. What the runner said (the boot read; later, each `status` event) and
    // what the user chose. Everything below is derived from them at the moment it is read.
    const runner = createStore<RunnerBrains>({ ...(status.active !== undefined ? { active: status.active } : {}), brains: status.brains });
    const choices = brainChoices ?? createBrainChoiceStore({ storage: safeLocalStorage(), brains: () => runner.get().brains });
    const answering = (): BrainWire | undefined => brainFor(choices.get().choice, runner.get());

    let checking = false;
    const seatState = createStore<BrainSwitchState>(switchStateOf(runner.get(), choices.get(), checking));
    const refresh = (): void => seatState.set(switchStateOf(runner.get(), choices.get(), checking));

    // ---------------------------------------------------------------- looking again
    //
    // The user fixes a brain where this page cannot see it: `/login` in a terminal, an
    // install, an update. Three things make the page ask the runner to probe again, and
    // none of them is a render — the ask used to sit inside the `platform.brain` getter, a
    // network request fired while React was rendering (found by the R2 verifier).

    // On the MONOTONIC clock: against a wall clock that was set back, the last ask would sit
    // in the future and the next one would be owed for as long as the clock had moved.
    let lastAskAt = Number.NEGATIVE_INFINITY;
    let owed: ReturnType<typeof setTimeout> | undefined;
    let recheck: Promise<void> | undefined;
    /** Ends the explicit re-check in flight; set while one is. */
    let statusLanded: (() => void) | undefined;

    const ask = (): void => {
      lastAskAt = performance.now();
      void client.recheckBrain();
    };

    /**
     * WHILE THE DEMO BRAIN STANDS IN for a brain the runner reported — at most once per
     * floor. Called when that begins or changes, and when the user comes back to the page
     * (which is when they have just fixed it). An ask that arrives inside the floor is
     * owed, not dropped: dropped, a user back from a twenty-second `/login` would stay on
     * the demo brain until they thought to press "check again". An idle page asks nothing,
     * and nothing is asked before the runner has reported at all — its first probe is
     * already under way.
     */
    const lookAgain = (): void => {
      if (answering() !== undefined || runner.get().brains.length === 0 || recheck !== undefined) return;
      const wait = lastAskAt + DEMO_RECHECK_FLOOR_MS - performance.now();
      if (wait <= 0) {
        ask();
        return;
      }
      owed ??= setTimeout(() => {
        owed = undefined;
        lookAgain();
      }, wait);
    };

    /**
     * THE EXPLICIT ACT ("check again"), and what a think that was not answered does. One at
     * a time — a second ask joins the first — and `checking` is true until the runner's
     * next `status` lands, or the bound passes.
     */
    const recheckNow = (): Promise<void> => {
      recheck ??= new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(bound);
          statusLanded = undefined;
          recheck = undefined;
          checking = false;
          refresh();
          resolve();
        };
        const bound = setTimeout(finish, RECHECK_BOUND_MS);
        statusLanded = finish;
        checking = true;
        refresh();
        ask();
      });
      return recheck;
    };

    /** Either source changed: re-derive, tell the readers of `platform.brain`, and look again if the demo brain now stands in. */
    const changed = (): void => {
      refresh();
      bumpBrainRevision();
      lookAgain();
    };
    runner.subscribe(changed);
    choices.subscribe(changed);

    landStatus = (next) => {
      // Set only on a CHANGE: an unchanged verdict re-emitted by a re-check must not
      // re-render every reader of the brain.
      if (JSON.stringify(next) !== JSON.stringify(runner.get())) runner.set(next);
      statusLanded?.();
    };

    window.addEventListener('focus', lookAgain);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') lookAgain();
    });

    // ---------------------------------------------------------------- the host arm
    //
    // The user's own agent behind the process's shim (D5, D-B7), reached through the adapter
    // the playground already has — `localAdapter` accepts a key, and the host arm of
    // `createTurnAdapter` reads no BYOK key and skips the F15 endpoint confirm, so no mode,
    // setting or secret is involved.
    //
    // ONE object for the life of the page, every fact on it a GETTER over the two sources:
    // the platform hands it out by reference, and a fresh one per read would make every
    // memo keyed on it recompute on every render. Its readers are told to look again by
    // `brainRevision`.
    const hostBrain: PlatformBrain = {
      kind: 'host',
      get label(): string {
        const brain = answering();
        // Read only while this arm is the platform's brain; a holder of a stale reference
        // gets a true sentence, not the last brain's name.
        return brain === undefined ? 'no agent is ready' : brainLabel(brain, labelModel(brain, choices.get()));
      },
      // The adapter resolves PER CALL, not once: a value read at composition time would
      // freeze the user's choice until a reload — ADR-0036 rule 3, and what makes "switch
      // now, it lands on your next think" true.
      adapter: {
        complete: async (request) => {
          const sent = choices.get();
          const brain = answering();
          const prefs = brain === undefined ? {} : prefsFor(brain, sent.prefs[brain.id]);
          // The chat route's top-level `model` / `effort` are the single-brain form and mean
          // the `claude` entry; the OpenAI adapter must name SOME model, and `claude` is the
          // placeholder the route strips. So they carry that brain's entry when it answers,
          // and the placeholder alone when another does.
          const legacy = brain?.id === LEGACY_BRAIN ? prefs : {};
          let answeredBy: string | undefined;
          let refusal: string | undefined;
          const result = await localAdapter({
            baseUrl: `${origin}/v1`,
            apiKey: token,
            model: legacy.model ?? LEGACY_BRAIN,
            // The page's OWN fetch, straight to its own runner on loopback. NEVER
            // `client.fetchImpl`: that is the connected-apps proxy (`POST /fetch`), which
            // re-runs the executor's gates and refuses a loopback destination — S5 routed
            // the brain through it and every think failed with "could not reach the local
            // model endpoint" (owner's walk, 2026-10-02).
            fetch: async (input, init) => {
              const response = await globalThis.fetch(
                input,
                withBody(init, {
                  ...(legacy.effort !== undefined ? { effort: legacy.effort } : {}),
                  // The user's choice as they made it; the RUNNER resolves it (and is the
                  // authority if this page's picture is stale). Only the entry of the
                  // brain this page expects to answer rides along.
                  brain: sent.choice,
                  ...(brain !== undefined && Object.keys(prefs).length > 0 ? { prefs: { [brain.id]: prefs } } : {}),
                }),
              );
              answeredBy = response.headers.get(BRAIN_HEADER) ?? undefined;
              // Read from a copy: the adapter still has to read the body itself.
              if (!response.ok) refusal = await refusalOf(response.clone());
              return response;
            },
          }).complete(request);
          // D4: a think that was not answered may mean the brain WENT AWAY (logged out,
          // uninstalled, out of date) since the last probe — the runner says so with a 503
          // `no-brain`, a driver with its own refusal. This turn keeps its own named error —
          // no demo reply is slipped in under a turn sent to the user's agent — and the
          // runner is asked to look again, so the NEXT turn is routed on the truth. A turn
          // the user stopped says nothing about the brain.
          if (!result.ok && result.code !== ERROR_CODES.CANCELLED) void recheckNow();
          // Thinks overlap (the pool runs several), so a slow one can finish after a newer
          // one. A call teaches the chip ONLY while the choice is still the one it carried —
          // otherwise a late answer or refusal for a brain or model the user already left
          // would overwrite what the newer think taught (review, 2026-10-03).
          const current = choices.get();
          if (current.choice !== sent.choice || (brain !== undefined && current.prefs[brain.id]?.model !== sent.prefs[brain.id]?.model)) return result;
          // Recorded against the brain the RUNNER names, which is the one that ran; where
          // it names none (a think it could not place), against the brain the choice meant.
          const by = answeredBy ?? brain?.id ?? (sent.choice === BRAIN_AUTO ? undefined : sent.choice);
          if (by === undefined) return result;
          if (result.ok) {
            // The stream's LAST chunk names the model the brain resolved (ADR-0070 D2: only
            // a turn that SUCCEEDED may name one). Until then the frames carry the brain's
            // own id as a placeholder, which is not a model.
            choices.markAnswered({ brain: by, ...(typeof result.model === 'string' && result.model !== by ? { model: result.model } : {}) });
          } else if (refusal !== undefined) {
            // The runner's sentence, not the adapter's `HTTP 502: {…}` around it. A network
            // failure or a dropped stream carries none and is not dressed up as a refusal.
            choices.markRefused({ brain: by, message: refusal });
          }
          return result;
        },
      },
      // What the answering brain's own wire entry says. `streaming` is an app-facing
      // declaration in `host-ready`, not a transport switch — the shim answers SSE
      // regardless — and Codex's answers arrive whole (ADR-0071).
      get streaming(): boolean {
        return answering()?.streaming ?? false;
      },
      tools: false,
      get maxPromptBytes(): number | undefined {
        return answering()?.maxPromptBytes;
      },
    };

    const brainSwitch: BrainSwitchSeat = {
      state: { get: seatState.get, subscribe: seatState.subscribe },
      choose: (id) => choices.choose(id),
      // The controls show the ANSWERING brain's model and level, so that is whose they set.
      // With no brain answering there is no control to call these (AC8 — no dead control).
      setModel: (model) => {
        const brain = answering();
        if (brain !== undefined) choices.setModel(brain.id, model);
      },
      setEffort: (effort) => {
        const brain = answering();
        if (brain !== undefined) choices.setEffort(brain.id, effort);
      },
      recheck: recheckNow,
      note: SWITCH_NOTE,
    };
    // On the PLATFORM, not on the brain: it must render while the demo brain answers,
    // which is exactly when the user needs each brain's remedy.
    platform.brainSwitch = brainSwitch;

    // WHICH brain answers is itself a getter (D4). While the choice resolves to no ready
    // brain the platform pins the DEMO brain: before this the chip said "demo brain" for a
    // machine with no CLI while every think still went to the shim and came back a 502.
    //
    // Defined on the object rather than spread into it: a spread READS a getter once and
    // copies the value, which would freeze the arm the page booted with.
    Object.defineProperty(platform, 'brain', {
      enumerable: true,
      get: (): PlatformBrain => (answering() === undefined ? DEMO_BRAIN : hostBrain),
    });

    // THE BOOT READ may already say a brain cannot answer. One that is known not ready is
    // asked about quietly (the user may be about to fix it). One the runner has NOT CHECKED
    // YET is the common case — its first look runs at this page's first contact, and a real
    // CLI takes seconds to answer — so there the page shows that it is checking, until that
    // first round lands: the ask joins the round already in flight.
    const about = demoStandIn(seatState.get())?.brain;
    if (about !== undefined && brainReadyState(about.state) === 'unknown') void recheckNow();
    else lookAgain();
  }

  return { platform, custody, handIns };
}

/** What the page carries when it is refusing to open: enough to render the refusal, no seams. */
function minimalPlatform(): SnugPlatform {
  // The kit's table with the one surface it otherwise keeps switched off too: a page that
  // will not open the file has no app to export.
  return { kind: 'host', binding: 'local-host', capabilities: hostCapabilities({ appExport: false }) };
}
