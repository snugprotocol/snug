// Desktop entry: install the platform BEFORE any playground module reads it,
// then render the playground App under a HashRouter (tauri:// has no SPA
// fallback; the web BrowserRouter entry is untouched).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { setPlatform } from '@playground/platform/platform';

import { createDesktopPlatform } from './platform-desktop.js';
import { installSubtleFallbackIfNeeded } from './subtle-fallback.js';

import { App } from '@playground/App';
import '@playground/theme/tokens.css';
import '@playground/theme/app.css';

async function boot(): Promise<void> {
  // In-shell hard gate (P4, AC7/AC8): the branch arms ONLY when the
  // debug-build-only `shell_gate_config` command answers Some (release builds
  // do not contain the command; debug builds answer None without
  // SNUG_SHELL_GATE=1). The gate module replays this same boot sequence itself
  // — its environment probes must observe the webview BEFORE the subtle
  // fallback patches it.
  const { getShellGateConfig } = await import('./gate/config.js');
  const gateConfig = await getShellGateConfig();
  if (gateConfig !== null) {
    const { runShellGate } = await import('./gate/run.js');
    await runShellGate(gateConfig);
    return;
  }

  // WKWebView may not treat tauri:// as a secure context (verified open
  // question, plan decision 12) — WebCrypto backs the OAuth HMAC state
  // signing, so probe and patch before the platform installs.
  await installSubtleFallbackIfNeeded();

  setPlatform(createDesktopPlatform());

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
