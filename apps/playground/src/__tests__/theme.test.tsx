// Theme integration (task AC-6): toggling the theme store flips the document tokens
// AND posts a live `theme-change` host-event into a running app — proven against the
// REAL runner host (SnugAppFrame mounted in jsdom with a stub transport), observed
// through the host's own onFrame hook.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FRAME_TYPES, type Frame } from '@snugprotocol/protocol';
import { SnugAppFrame, type AgentTransport, type FrameDirection } from '@snugprotocol/runner';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setTheme, themeStore, useTheme } from '../state/theme.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stubTransport: AgentTransport = {
  send: async () => ({ ok: true, text: '{}' }),
};

interface HarnessProps {
  onFrame: (direction: FrameDirection, frame: Frame) => void;
}

/** Mirrors the Run view's wiring: theme store → SnugAppFrame theme prop. */
function Harness({ onFrame }: HarnessProps): ReactElement {
  const theme = useTheme();
  return <SnugAppFrame html="<html><body>app</body></html>" transport={stubTransport} budgetKey="t" theme={theme} onFrame={onFrame} />;
}

describe('theme store + runner harness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setTheme('dark');
  });

  it('defaults to dark and persists changes', () => {
    expect(themeStore.get()).toBe('dark');
    setTheme('light');
    expect(localStorage.getItem('snug:theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('posts theme-change into the running app AND flips the document tokens', () => {
    const frames: Array<{ direction: FrameDirection; frame: Frame }> = [];
    act(() => {
      root.render(<Harness onFrame={(direction, frame) => frames.push({ direction, frame })} />);
    });

    act(() => {
      setTheme('light');
    });

    const themeEvents = frames.filter(
      (entry) => entry.direction === 'outbound' && entry.frame.type === FRAME_TYPES.hostEvent && entry.frame.event === 'theme-change',
    );
    expect(themeEvents.length).toBeGreaterThan(0);
    const last = themeEvents.at(-1)?.frame;
    expect(last !== undefined && last.type === FRAME_TYPES.hostEvent ? last.data : undefined).toEqual({ theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
