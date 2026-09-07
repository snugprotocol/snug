// The local page's entry (ADR-0068). Same shape as the artifact kit's `main.tsx`; what
// differs is where the platform's seams come from — a process on loopback rather than a
// viewer's globals.
//
// ORDER MATTERS. The token is claimed and stripped from the address bar BEFORE anything
// reads `location.hash`, because `HashRouter` reads it when it first renders and a
// `#token=…` fragment would otherwise be treated as a route.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { setPlatform } from '@playground/platform/platform';
import { getUserDb } from '@playground/state/userdb';
import { refreshAppMeta } from '@playground/state/appMeta';

import { claimTokenFromFragment, createLocalClient } from './client.js';
import { composeLocalPlatform } from './compose-local.js';
import { LocalRefusal } from './LocalRefusal.js';

import { App } from '@playground/App';
import '@playground/theme/tokens.css';
import '@playground/theme/app.css';

async function boot(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('missing #root');
  const root = createRoot(container);

  const token = claimTokenFromFragment(window);
  if (token === undefined) {
    // Someone opened the address without the fragment (a bookmark, a second tab). The page
    // cannot authenticate itself and says how to get a fresh one — never a dead surface.
    root.render(<LocalRefusal kind="no-token" />);
    return;
  }

  const client = createLocalClient(token);
  let status;
  try {
    status = await client.status();
  } catch {
    root.render(<LocalRefusal kind="unreachable" />);
    return;
  }

  const { platform, refusal } = composeLocalPlatform(client, status);
  setPlatform(platform);

  if (refusal !== undefined) {
    // The file is held by Snug for Mac. We do NOT open read-only: the db swallows failed
    // saves, so the user would work for an hour and lose it.
    root.render(<LocalRefusal kind="held" heldBy={refusal.heldBy} />);
    return;
  }

  // Hand-ins arrive at any time here, not only at boot: the agent may deliver an app while
  // the user is sitting on the hub.
  client.events((name) => {
    if (name === 'hand-in') void getUserDb().then(() => refreshAppMeta());
  });

  root.render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}

void boot();
