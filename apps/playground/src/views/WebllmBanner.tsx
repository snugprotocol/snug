// WebllmBanner — the shell-level surface of the experimental webllm brain (AL-07).
// Renders NOTHING unless the ?webllm=1 flag is on (AC1): a fallback banner when this
// browser cannot run WebGPU (AC3, pinned copy), or a one-line experimental note —
// with live engine download/compile progress — while the in-browser model is active.

import type { ReactElement } from 'react';

import { useStore } from '../state/store.js';
import { useBrain, WEBLLM_FALLBACK_BANNER, webllmLoadStatusStore } from '../state/webllm.js';

export function WebllmBanner(): ReactElement | null {
  const brain = useBrain();
  const loadStatus = useStore(webllmLoadStatusStore);
  if (brain.kind === 'demo' && brain.reason === 'no-webgpu') {
    return (
      <div
        className="error-note"
        role="status"
        data-testid="webllm-fallback-banner"
        style={{ margin: 'var(--space-3) var(--space-3) 0' }}
      >
        {WEBLLM_FALLBACK_BANNER}
      </div>
    );
  }
  if (brain.kind === 'webllm') {
    return (
      <div
        role="status"
        data-testid="webllm-active-note"
        className="hint"
        style={{ margin: 'var(--space-3) var(--space-3) 0' }}
      >
        experimental: apps think inside this tab — {brain.model} on WebGPU
        {loadStatus !== undefined ? ` · ${loadStatus}` : ''}
      </div>
    );
  }
  return null;
}
