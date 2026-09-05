// copy.ts — platform-dependent DISCLOSURE copy (TASK-20260905-host-kit AC2/AC5;
// TASK-20260905-binding-a-artifacts AC7). Pure, so every arm is pinned byte-for-byte. The
// host kit names where the working copy of the user's file actually lives — the rung the
// boot probe found WORKING, not the one that was present — because inside a foreign host
// that is the one fact the user cannot see. Under a Claude artifact it also says what the
// durable copy is, what a republish does to it, and what the user can do about it (D8).

import type { PersistenceKind } from '@snugprotocol/db';

import type { CustodyState, SnugPlatform } from './platform.js';

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
  state: Pick<CustodyState, 'dirty' | 'readOnly' | 'divergence'>,
): CustodyCopy {
  const status = state.readOnly
    ? 'read-only view — export to keep a copy.'
    : state.divergence === 'newer'
      ? 'this browser’s copy is newer than the page’s saved copy.'
      : state.divergence === 'older'
        ? 'the page’s saved copy is newer than this browser’s.'
        : state.dirty
          ? 'unsaved changes — save to this artifact to keep them.'
          : undefined;
  const withStatus = (copy: Omit<CustodyCopy, 'status'>): CustodyCopy => ({ ...copy, ...(status !== undefined ? { status } : {}) });
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
