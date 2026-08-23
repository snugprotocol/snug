// The one-line environment stamp for a report — the bug form's own placeholder
// shape ("Firefox 142 / macOS / byok"). Read at CLICK time, never at mount: the
// mode is live state and a report should carry the mode the user was actually in.

import { getPlatform } from '../platform/platform.js';
import { modeStore } from '../state/mode.js';

/** Coarse browser/engine tag from the UA — a hint for triage, never fingerprinting. */
function uaBrief(ua: string): string {
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (firefox !== null) return `Firefox ${firefox[1]}`;
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge !== null) return `Edge ${edge[1]}`;
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (chrome !== null) return `Chrome ${chrome[1]}`;
  const safari = /Version\/(\d+).*Safari/.exec(ua);
  if (safari !== null) return `Safari ${safari[1]}`;
  return ua.slice(0, 60);
}

export function reportEnvironment(): string {
  const kind = getPlatform().kind;
  const ua = uaBrief(globalThis.navigator?.userAgent ?? 'unknown');
  return `${kind === 'desktop' ? 'desktop shell' : 'web'} / ${ua} / ${modeStore.get()}`;
}
