// capability.ts — the capability-reveal reducer: the run header starts anonymous
// ("connecting…") and upgrades the moment the app self-describes via announce.
// Display metadata only — never a security identity (rule R4).

import type { AppAnnounceFrame } from '@snugprotocol/protocol';

export interface RevealMeta {
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
}

export type RevealState = { phase: 'connecting' } | { phase: 'live'; meta: RevealMeta };

export const initialRevealState: RevealState = { phase: 'connecting' };

export function revealReduce(_state: RevealState, frame: AppAnnounceFrame): RevealState {
  return {
    phase: 'live',
    meta: {
      displayName: frame.displayName,
      ...(frame.description !== undefined ? { description: frame.description } : {}),
      ...(frame.iconEmoji !== undefined ? { iconEmoji: frame.iconEmoji } : {}),
      ...(frame.iconColor !== undefined ? { iconColor: frame.iconColor } : {}),
    },
  };
}
