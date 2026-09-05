// Host kit entry (TASK-20260905-host-kit P1): run the probe, install the platform BEFORE any
// playground module reads it, then render the playground App under a HashRouter (a page
// opened from file:// or inside an artifact viewer has no SPA fallback). Same composition
// as apps/desktop/src/main.tsx; the difference is what the platform carries (P2).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { setPlatform } from '@playground/platform/platform';

import { createHostPlatform } from './platform-host.js';
import { runProbe } from './probe.js';
import { sqlJsWasmBinary } from './wasmBytes.js';

import { App } from '@playground/App';
import '@playground/theme/tokens.css';
import '@playground/theme/app.css';

async function boot(): Promise<void> {
  const probe = await runProbe(window);
  setPlatform(createHostPlatform(probe, sqlJsWasmBinary()));

  const container = document.getElementById('root');
  if (container === null) throw new Error('missing #root');

  createRoot(container).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}

void boot();
