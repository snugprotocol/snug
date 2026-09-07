// Host kit entry (TASK-20260905-host-kit P1; TASK-20260905-binding-a-artifacts): run the
// probe, COMPOSE the platform from its answers and the page (the storage seam, the custody
// and export seats, the hand-in seat — compose.ts, tested without a browser), install it
// BEFORE any playground module reads it, render the playground App under a HashRouter (a
// page opened from file:// or inside an artifact viewer has no SPA fallback), then hand in
// the page's bundle blocks once the user db is open. Same composition as
// apps/desktop/src/main.tsx; the difference is what the platform carries (P2).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { setPlatform } from '@playground/platform/platform';
import { refreshAppMeta } from '@playground/state/appMeta';
import { getUserDb } from '@playground/state/userdb';

import { composeHostPlatform, handInBeforePaint } from './compose.js';
import { describeHandIn } from './handin.js';
import { runProbe } from './probe.js';
import { sqlJsWasmBinary } from './wasmBytes.js';

import { App } from '@playground/App';
import '@playground/theme/tokens.css';
import '@playground/theme/app.css';

async function boot(): Promise<void> {
  const probe = await runProbe(window);
  // The first hosted walk records what the viewer injected into the document, so the
  // canonical-source verification's premise is a measured fact (plan review A1).
  console.info('[snug-host] boot', {
    binding: probe.binding,
    storage: probe.storage.kind,
    brain: probe.brain.brain.kind,
    legs: probe.brain.legs,
    scripts: [...document.scripts].map((s) => `${s.type || 'classic'}${s.src ? ` src=${s.src}` : ''}${s.id ? ` #${s.id}` : ''}`),
  });
  const composition = composeHostPlatform(
    probe,
    { location, fetch: (input, init) => fetch(input, init), sessionStorage, storage: (window as { storage?: unknown }).storage, reload: () => location.reload() },
    document,
    sqlJsWasmBinary(),
  );
  setPlatform(composition.platform);

  // The hand-in: after the user db opens, never before — and BEFORE the first paint when
  // the db opens promptly, so the hub's first render already lists what the agent handed
  // in (the hub reads the library once at mount). A db that cannot open (corrupt, locked)
  // never resolves `getUserDb()`, so the wait is bounded: past it the App renders its
  // recovery surface and the hand-in lands whenever the db does. Its outcome is one note
  // on the custody chip; a refusal is named there too, never a crash.
  const handIn = getUserDb()
    .then(async (db) => {
      const outcome = await composition.handIn(db);
      const note = describeHandIn(outcome);
      if (note !== undefined) composition.custody.patch({ note });
      if (outcome.installed.length > 0 || outcome.updated.length > 0) await refreshAppMeta();
    })
    .catch((error: unknown) => {
      composition.custody.patch({ note: `the handed-in apps could not be read: ${error instanceof Error ? error.message : String(error)}` });
    });
  await handInBeforePaint(handIn);

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
