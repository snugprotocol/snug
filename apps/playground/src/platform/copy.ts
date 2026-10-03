// copy.ts — platform-dependent DISCLOSURE copy (TASK-20260905-host-kit AC2/AC5;
// TASK-20260905-binding-a-artifacts AC7). Pure, so every arm is pinned byte-for-byte. The
// host kit names where the working copy of the user's file actually lives — the rung the
// boot probe found WORKING, not the one that was present — because inside a foreign host
// that is the one fact the user cannot see. Under a Claude artifact it also says what the
// durable copy is, what a republish does to it, and what the user can do about it (D8).

import type { PersistenceKind } from '@snugprotocol/db';

import { CONNECTIONS_UNAVAILABLE, RUNS_IN_LABEL, offersOf } from './availability.js';
import type { CustodyState, HostModelTier, SnugPlatform, TierSeat, TierState } from './platform.js';

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
