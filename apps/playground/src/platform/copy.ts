// copy.ts — platform-dependent DISCLOSURE copy (TASK-20260905-host-kit AC2/AC5;
// TASK-20260905-binding-a-artifacts AC7). Pure, so every arm is pinned byte-for-byte. The
// host kit names where the working copy of the user's file actually lives — the rung the
// boot probe found WORKING, not the one that was present — because inside a foreign host
// that is the one fact the user cannot see. Under a Claude artifact it also says what the
// durable copy is, what a republish does to it, and what the user can do about it (D8).

import type { PersistenceKind } from '@snugprotocol/db';

import { CONNECTIONS_UNAVAILABLE, RUNS_IN_LABEL, offersOf } from './availability.js';
import type { BrainOptionView, BrainReadyState, BrainSwitchState, CustodyState, HostModelTier, SnugPlatform, TierSeat, TierState } from './platform.js';

/** One sentence naming the storage in use; `undefined` when the platform did not say. */
export function storageDisclosure(kind: PersistenceKind | undefined): string | undefined {
  if (kind === undefined) return undefined;
  switch (kind) {
    case 'opfs':
      return 'this copy of your file lives in this browser’s private storage for this page.';
    case 'idb':
      return 'this copy of your file lives in this browser’s IndexedDB for this page.';
    case 'memory':
      return 'this copy of your file lives in memory only — it is gone when the page closes, so export it to keep it.';
    case 'file':
      return 'this copy of your file lives on this computer’s disk.';
    case 'window-storage':
      return 'this copy of your file lives in this chat’s page storage — this view only; the published link keeps its own.';
    case 'artifact-html':
      return 'the working copy of your file lives in this browser; the saved copy is the artifact page itself.';
    default: {
      const never: never = kind;
      return never;
    }
  }
}

export interface CustodyCopy {
  /** The chip's short label. */
  label: string;
  /** The popover headline. */
  headline: string;
  /** One honest paragraph: where, what a republish does, what the user can do. */
  body: string;
  /** The state line under it, when the state says something. */
  status?: string;
}

/**
 * The "your file" chip copy, derived from the platform seats and the custody state — never
 * from parallel UI state (ADR-0059 rule 2). Every binding × kind arm is pinned; the state
 * line is appended from the record's own flags.
 */
export function custodyDisclosure(
  binding: SnugPlatform['binding'],
  kind: PersistenceKind | undefined,
  state: Pick<CustodyState, 'dirty' | 'readOnly' | 'divergence' | 'workingCopy' | 'heldBy'>,
): CustodyCopy {
  const status = state.heldBy !== undefined
    ? `${state.heldBy} has your file open — close it to use Snug here.`
    : state.readOnly
    ? 'read-only view — export to keep a copy.'
    : state.divergence === 'newer'
      ? 'this browser’s copy is newer than the page’s saved copy.'
      : state.divergence === 'older'
        ? 'the page’s saved copy is newer than this browser’s.'
        : state.dirty
          ? 'unsaved changes — save to this artifact to keep them.'
          : undefined;
  // S2: a working copy that lives in memory only (third-party storage denied) is gone with the tab.
  const memoryNote = state.workingCopy === 'memory' ? ' this tab holds the working copy in memory only — close it unsaved and the changes are gone.' : '';
  const withStatus = (copy: Omit<CustodyCopy, 'status'>): CustodyCopy => ({
    ...copy,
    body: copy.body + memoryNote,
    ...(status !== undefined ? { status } : {}),
  });
  switch (binding) {
    case 'artifact':
      return withStatus({
        label: 'your file: in this artifact',
        headline: 'in this artifact',
        body:
          'Anthropic-hosted, saved when you save it. a republish from Claude Code rewrites it unless the agent merges it (snug-embed does). export any time.',
      });
    case 'artifact-static':
      return withStatus({
        label: 'your file: not saved here',
        headline: 'a copy of the artifact page',
        body: 'this page is served outside the Claude viewer — nothing saves here. export to keep what you do.',
      });
    case 'artifact-chat':
      return withStatus({
        label: 'your file: in this chat',
        headline: 'in this chat’s page storage',
        body: 'this view only — the published link keeps its own copy. copy the export to move or keep it.',
      });
    case 'local-host':
      // The file is a real file on this Mac, served by the local host process — NOT the
      // browser storage the default arm describes. Saying "in this browser" here would be
      // false and would make the export look like the only way to keep anything.
      return withStatus({
        label: 'your file: on this Mac',
        headline: 'on this Mac',
        body: 'in ~/Snug/user.snug, saved as you work. the same file Snug for Mac uses.',
      });
    case 'file':
    case undefined:
    default:
      return withStatus({
        label: kind === 'memory' ? 'your file: in memory' : 'your file: in this browser',
        headline: kind === 'memory' ? 'in memory only' : 'in this browser',
        body: storageDisclosure(kind) ?? 'this copy of your file lives with this page.',
      });
  }
}

// ---------------------------------------------------------- the thinking level (ADR-0067)

/** What each tier does, in the contract's own terms (sample.d.ts 0.2.41) — the option labels the chip lists. */
export function tierLabel(tier: HostModelTier, seat: Pick<TierSeat, 'viewerDefault'>, state: Pick<TierState, 'unavailable'>): string {
  const answered = state.unavailable[tier];
  if (answered !== undefined) return `${tier} — not on this plan, answered on ${answered}`;
  const marker = tier === seat.viewerDefault ? ' (the viewer’s default)' : '';
  switch (tier) {
    case 'quick':
      return `quick — answers at once, no thinking first${marker}`;
    case 'default':
      return `default — thinks first${marker}`;
    case 'complex':
      return `complex — thinks longest, for hard reasoning${marker}`;
    default: {
      const never: never = tier;
      return never;
    }
  }
}

/** The `auto` entry, derived from the pins AND the marks: a pin the plan answered elsewhere is named by what answers (ADR-0059 rule 4 — never a claim the wire contradicts). */
export function tierAutoLabel(seat: Pick<TierSeat, 'auto'>, state: Pick<TierState, 'unavailable'>): string {
  const resolve = (tier: HostModelTier): HostModelTier => state.unavailable[tier] ?? tier;
  return `auto — ${resolve(seat.auto.app)} for app replies, ${resolve(seat.auto.chat)} for building`;
}

/** The substitution note — derived from what the adapter recorded, never from UI state (ADR-0059 rule 2). */
export function tierSubstitutionNote(applied: TierState['applied']): string | undefined {
  if (applied === undefined) return undefined;
  return `asked for ${applied.asked} — this view answered on ${applied.answered} (the viewer’s plan)`;
}

// ---------------------------------------------------------- the brain switcher (ADR-0071)
//
// What the chip, the passport and the runner's composition all need to say about a brain,
// derived in ONE place from what the runner reported — so the chip cannot call a brain
// ready while the passport gives its remedy, and the level the chip offers is the level the
// composition sends.

/** The choice that pins nothing: the runner's default brain when it is ready, else none (ADR-0071 §4). */
export const BRAIN_AUTO = 'auto';

/**
 * The thinking levels a brain offers FOR A MODEL, in the brain's own words (ADR-0071 §5 —
 * nothing maps one brain's vocabulary onto another's). No model chosen → the brain's own
 * (its default model's). A model the catalogue lists → that model's, which may be none:
 * Haiku 4.5 has no thinking axis, and a level it ignores is a dead control. A model typed
 * by hand that the catalogue does not list is assumed to HAVE the brain's levels —
 * withholding a control the model may well support is the worse error, and the brain
 * refuses a level it cannot use by name.
 */
export function brainLevels(
  brain: { efforts: readonly string[]; models: readonly { id: string; efforts: readonly string[] }[] },
  model: string | undefined,
): readonly string[] {
  if (model === undefined) return brain.efforts;
  return brain.models.find((listed) => listed.id === model)?.efforts ?? brain.efforts;
}

/**
 * The runner's sentence for a brain it has not looked at yet (`NOT_PROBED_DETAIL` in
 * apps/host-mcp/src/brains/registry.ts — the two are held equal by oneKit.test.ts). The wire
 * has ONE state, `unknown`, for two facts — nobody has looked yet, and it was asked and
 * could not be read — and this sentence is how the page tells the first from the second.
 */
export const BRAIN_NOT_CHECKED_DETAIL = 'Snug is still checking this brain.';

/**
 * The five states a brain reports (ADR-0069 §6, ADR-0071 §6), each in a few words for the
 * chip and as the tail of a sentence. `unknown` is "not checked yet", not "broken": it is
 * what every brain says until the runner's first look at it has come back, and what one says
 * when it could not be told — the runner's own detail says which.
 */
const STATES: ReadonlyMap<string, { words: string; sentence: string }> = new Map([
  ['ready', { words: 'ready', sentence: 'is ready' }],
  ['logged-out', { words: 'not logged in', sentence: 'is not logged in' }],
  ['outdated', { words: 'out of date', sentence: 'is out of date' }],
  ['absent', { words: 'not installed', sentence: 'is not installed' }],
  ['unknown', { words: 'not checked yet', sentence: 'has not been checked yet' }],
]);

/**
 * A brain's state as this build understands it. A later driver may report a state this
 * build has never heard of (ADR-0071 §6): it is read as `unknown` — shown with the
 * driver's own detail, and never as ready. (A Map lookup, so a state named like an object
 * member is just one more state nobody knows.)
 */
export function brainReadyState(state: string): BrainReadyState {
  return STATES.has(state) ? (state as BrainReadyState) : 'unknown';
}

/** The three marks a brain's row can carry — a shape and a word each, never colour alone. */
export type BrainMark = 'ready' | 'attention' | 'absent';

export const BRAIN_MARK_WORD: Readonly<Record<BrainMark, string>> = {
  ready: 'ready',
  attention: 'needs attention',
  absent: 'not installed',
};

export function brainMark(state: string): BrainMark {
  const known = brainReadyState(state);
  return known === 'ready' ? 'ready' : known === 'absent' ? 'absent' : 'attention';
}

/**
 * A few words for what a brain's state means — the chip's second line. An `unknown` brain
 * whose check RAN and came back unreadable (a timeout, an answer the driver could not
 * place) was labelled "not checked yet" beside the runner's sentence saying the check had
 * timed out; it is "not checked yet" only while nobody has looked.
 */
export function brainStateWords(brain: Pick<BrainOptionView, 'state' | 'detail'>): string {
  const looked = brain.detail !== undefined && brain.detail !== '' && brain.detail !== BRAIN_NOT_CHECKED_DETAIL;
  if (looked && brain.state === 'unknown') return 'could not be checked';
  return STATES.get(brain.state)?.words ?? 'needs attention';
}

/** The one sentence a person can act on: the runner's own (`detail`), else the state in words. */
export function brainRemedy(brain: Pick<BrainOptionView, 'name' | 'state' | 'detail'>): string {
  if (brain.detail !== undefined && brain.detail !== '') return brain.detail;
  return `${brain.name} ${STATES.get(brain.state)?.sentence ?? 'needs attention'}.`;
}

/** What an unverified brain's row says (ADR-0071 §2): the label, and one sentence on what it means. */
export const BRAIN_UNVERIFIED_LABEL = 'experimental — not yet verified on this machine';
export const BRAIN_UNVERIFIED_BODY = 'its tools are switched off by flags and a tripwire, and nobody has yet proven that on a logged-in run here.';

/**
 * A sentence with its commands marked. The runner writes a command between backticks
 * (``run `codex login`, then check again``); a view renders those parts as code. An
 * unpaired backtick is kept as the character it is — never half a sentence set in mono.
 */
export function proseParts(text: string): readonly { text: string; code: boolean }[] {
  const pieces = text.split('`');
  const paired = pieces.length % 2 === 1;
  return pieces
    .map((piece, index) => {
      const last = index === pieces.length - 1;
      if (!paired && last) return { text: `\`${piece}`, code: false };
      return { text: piece, code: index % 2 === 1 };
    })
    .filter((part) => part.text !== '');
}

/** Why the demo brain is standing in on a host with a brain switcher, and what to do about it. */
export interface DemoStandIn {
  /** A few words for the chip (`Claude · not logged in`). */
  why: string;
  /** One sentence a person can act on. */
  remedy: string;
  /** The brain it is about, when it is about one. */
  brain?: BrainOptionView;
}

/**
 * `undefined` while a brain answers. Otherwise the reason is the brain the CHOICE names:
 * the pin, or — under `auto` — the runner's default brain, which is the first VERIFIED one
 * it lists (an unverified brain is never `auto`'s, so its state is never the reason). The
 * demo brain is never described as "nothing to configure" here: on the runner there is
 * always something the user can do, and this says what.
 */
export function demoStandIn(state: Pick<BrainSwitchState, 'choice' | 'active' | 'brains'>): DemoStandIn | undefined {
  if (state.active !== undefined) return undefined;
  if (state.brains.length === 0) {
    return { why: 'looking for your agents', remedy: 'the runner has not said yet which of your agents can answer.' };
  }
  if (state.choice !== BRAIN_AUTO) {
    const pinned = state.brains.find((brain) => brain.id === state.choice);
    if (pinned === undefined) {
      return { why: 'the agent you picked is gone', remedy: `the agent you picked (${state.choice}) is not on this computer any more — choose auto, or another agent.` };
    }
    return { why: `${pinned.name} · ${brainStateWords(pinned)}`, remedy: brainRemedy(pinned), brain: pinned };
  }
  const fallback = state.brains.find((brain) => brain.verified);
  if (fallback === undefined) {
    return { why: 'no agent picked', remedy: 'auto only uses an agent that has been verified on this machine — pick one below to use it.' };
  }
  if (fallback.state === 'ready') {
    return { why: 'no agent is answering', remedy: 'check again, or pick an agent below.' };
  }
  return { why: `${fallback.name} · ${brainStateWords(fallback)}`, remedy: brainRemedy(fallback), brain: fallback };
}

/**
 * The sentence after the stand-in's reason: what answers meanwhile, and until when. It once
 * said "until one of your agents is ready" two rows above an agent marked ready (auto does
 * not take that one — ADR-0071 §4), so where there is a way out it names it.
 */
export function standInBody(standIn: DemoStandIn, brains: readonly BrainOptionView[]): string {
  const script = 'a tiny script inside this page answers';
  const free = 'no AI model or service is called.';
  // The brain a reason names is never a ready one (`demoStandIn`), so any ready brain is a way out.
  if (!brains.some((brain) => brain.state === 'ready')) return `${script} until one of your agents is ready — ${free}`;
  if (standIn.brain !== undefined) return `${script} until ${standIn.brain.name} is ready, or you pick a ready agent below — ${free}`;
  // The reason is about no one agent ("no agent is answering"); its remedy follows this.
  return `${script} meanwhile — ${free}`;
}

/**
 * The one plain line under `auto`: what auto means here, now. While the demo brain stands
 * in it says WHICH fact made it so — it once said "nothing is ready" two lines above a row
 * marked "ready" (auto does not take that row: ADR-0071 §4), which read as a contradiction.
 */
export function autoChoiceLine(state: Pick<BrainSwitchState, 'choice' | 'active' | 'brains'>): string {
  if (state.choice !== BRAIN_AUTO) return 'your default agent when it is ready, the demo brain when it is not — never another agent.';
  // An unverified brain is never what auto shows (ADR-0071 §2): it answers only when picked by its own row.
  const answering = state.brains.find((brain) => brain.id === state.active && brain.verified);
  if (answering !== undefined) return `answers on ${answering.name} — and never switches to another agent by itself.`;
  const standIn = 'so the demo brain answers — auto never switches to another agent by itself.';
  if (state.brains.length === 0) return `still looking for your agents, ${standIn}`;
  if (!state.brains.some((brain) => brain.state === 'ready')) return `no agent is ready, ${standIn}`;
  // The runner's default brain, as `demoStandIn` reads it: the first verified one it lists.
  const fallback = state.brains.find((brain) => brain.verified);
  return fallback !== undefined && fallback.state !== 'ready' ? `${fallback.name} is not ready, ${standIn}` : `no agent is answering, ${standIn}`;
}

// ---------------------------------------------------------- the host passport (ADR-0072 §4)

export type PassportKey = 'thinks' | 'file' | 'connections' | 'sign-in' | 'home-network' | 'phone-helper';

export interface PassportRow {
  key: PassportKey;
  /** What the row is about, as a person would name it. */
  name: string;
  can: boolean;
  /** One plain sentence: what that means here, or where it does work. */
  sentence: string;
}

export interface HostPassportCopy {
  /** The host, in words (`a Claude artifact`). */
  where: string;
  rows: readonly PassportRow[];
}

/** What each binding is called when the passport introduces the host. */
const HOST_NAME: Readonly<Record<NonNullable<SnugPlatform['binding']>, string>> = {
  artifact: 'a Claude artifact',
  'artifact-static': 'a copy of an artifact page',
  'artifact-chat': 'a Claude chat',
  'local-host': 'your agent, on this computer',
  file: 'a page in your browser',
};

/**
 * The host passport (TASK-20261003 S5): what THIS host can and cannot do, one row per
 * thing a person would ask about, each a yes or a no with one sentence.
 *
 * Derived, never declared: the four capability rows ARE `offersOf(platform)` — the table
 * the shelf, the run route and the wizard's walls obey — so a tile disabled for "needs your
 * home network" and a passport row saying the home network is reachable cannot both ship.
 * "thinks" is the brain seat; "keeps your file" is the custody copy above, so the passport
 * and the "your file" chip say the same place.
 */
export function hostPassport(platform: SnugPlatform, custody: Pick<CustodyState, 'dirty' | 'readOnly' | 'divergence' | 'workingCopy' | 'heldBy'>): HostPassportCopy {
  const offers = offersOf(platform);
  const brain = platform.brain;
  const backend = platform.userdbBackend?.kind;
  const file = custodyDisclosure(platform.binding, backend, custody);
  // A durable copy exists and this view may write it. `artifact-static` is the artifact
  // host serving the page top-level: nothing can save there, whatever the bucket is.
  const keeps = backend !== undefined && backend !== 'memory' && platform.binding !== 'artifact-static' && !custody.readOnly && custody.heldBy === undefined;
  const sentence = (text: string): string => (text.endsWith('.') ? text : `${text}.`);
  // On a host with a brain switcher the demo brain is standing in FOR something, and the
  // row says the same fact the chip does: which agent, and what to do about it. "No brain
  // is wired into this host" would be false there — the runner knows the user's agents.
  const standIn = platform.brainSwitch === undefined ? undefined : demoStandIn(platform.brainSwitch.state.get());
  return {
    where: HOST_NAME[platform.binding ?? 'file'],
    rows: [
      {
        key: 'thinks',
        name: 'thinks',
        can: brain?.kind === 'host',
        sentence:
          brain?.kind === 'host'
            ? sentence(`${brain.label} answers your apps`)
            : standIn !== undefined
              ? `the demo brain answers, from a script, for now (${standIn.why}). ${sentence(standIn.remedy)}`
              : 'no brain is wired into this host yet — the demo brain answers, from a script.',
      },
      {
        key: 'file',
        name: 'keeps your file',
        can: keeps,
        sentence: keeps ? sentence(`kept ${file.headline}`) : sentence(file.status ?? `${file.headline} — export to keep what you do`),
      },
      {
        key: 'connections',
        name: 'live connections',
        can: offers.network,
        sentence: !offers.network
          ? sentence(CONNECTIONS_UNAVAILABLE)
          : offers['native-fetch']
            ? 'apps can reach outside services once you approve each one — sent from this computer, so providers that turn a browser away work too.'
            : 'apps can reach outside services once you approve each one.',
      },
      {
        key: 'sign-in',
        name: 'sign-in with a provider',
        can: offers.oauth,
        sentence: offers.oauth
          ? 'apps that sign you in with their provider can finish that sign-in here.'
          : offers.network
            ? // The one host that offers connections without a sign-in: the runner whose fixed
              // redirect port was taken (ADR-0068 — the registered redirect URI names that port).
              'a provider’s sign-in can’t come back here right now — the local address it returns to was already in use when Snug started.'
            : 'a provider’s sign-in has no way back to this host.',
      },
      {
        key: 'home-network',
        name: 'your home network',
        can: offers.lan,
        sentence: offers.lan
          ? 'apps can talk to devices on your home network.'
          : `this host can’t reach devices on your home network — ${RUNS_IN_LABEL.desktop} can.`,
      },
      {
        key: 'phone-helper',
        name: 'the phone helper',
        can: offers.helper,
        sentence: offers.helper
          ? 'apps can link your phone through the helper.'
          : `the helper that links your phone runs in ${RUNS_IN_LABEL.desktop} only.`,
      },
    ],
  };
}
