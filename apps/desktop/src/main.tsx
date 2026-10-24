// Desktop entry: install the platform BEFORE any playground module reads it,
// then render the playground App under a HashRouter (tauri:// has no SPA
// fallback; the web BrowserRouter entry is untouched).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { setPlatform } from '@playground/platform/platform';
import { chatgptPlanFlush } from '@playground/state/chatgptPlan.js';
import { userDbStatusStore, getUserDb } from '@playground/state/userdb.js';

import { createDesktopPlatform } from './platform-desktop.js';
import { composeCloseFlush, registerCloseFlush } from './close-flush.js';
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

  // ADR-0021 §5: flush the debounced write-back before the window actually
  // closes. Guarded on status:'ready' because `getUserDb()` deliberately never
  // resolves while the db is corrupt/load-failed — awaiting it here would hold
  // the close open until the shell's deadline fired, on exactly the boot where
  // there is nothing to flush anyway. The ChatGPT-plan keeper's persist in flight
  // is awaited beside it (TASK-20261023 D4): a rotated refresh token must reach
  // the custody file before the window goes.
  registerCloseFlush(
    composeCloseFlush({
      userDb: async () => {
        if (userDbStatusStore.get().state !== 'ready') return;
        await (await getUserDb()).flush();
      },
      chatgptPlan: chatgptPlanFlush,
    }),
  );

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
