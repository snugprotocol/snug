// The four states in which this page will not take the user's work — each naming what to
// do next, because a page that renders nothing is indistinguishable from one that is broken.

import type { ReactElement } from 'react';

export interface LocalRefusalProps {
  /**
   * `no-token` — a runner answered and will not let this page in (a bookmark, a second tab,
   *              a page left open across a restart);
   * `held`     — another product has the user's file open;
   * `stopped`  — the runner this page was talking to went away (K7);
   * `not-answering` — the page holds the runner's key and `/status` got no answer to any
   *              ask (Gate 5 security/F5). It stops here because the only other way to
   *              open was as a plain file, on this browser's storage — work the user would
   *              then not find in their Snug file.
   */
  kind: 'no-token' | 'held' | 'stopped' | 'not-answering';
  heldBy?: string;
}

const COPY: Record<LocalRefusalProps['kind'], { title: string; body: string }> = {
  'no-token': {
    title: 'Open Snug from your agent',
    // Only the agent route: the human CLI lives at a plugin path this page cannot know.
    body: 'This page needs a fresh address from the Snug runner. Ask your agent to open Snug — it hands this page a new key.',
  },
  held: {
    title: 'Snug for Mac has your file',
    body: 'Your apps and data are open in the desktop app. Close it and reload this page — nothing here is lost, and this page will not write while the desktop holds the file.',
  },
  stopped: {
    // The page stops HERE rather than staying up: the db swallows a failed save, so a hub
    // that kept taking edits after the runner went would lose every one of them in silence.
    title: 'The Snug runner stopped',
    body: 'Reopen Snug from your agent — ask it to open Snug again. Everything saved before the runner stopped is in your file; this page takes no further edits.',
  },
  'not-answering': {
    // True by construction: this refusal is decided before any platform or db is composed.
    title: 'The Snug runner is not answering',
    body: 'This page came from the Snug runner, but the runner did not answer when the page asked for your file. Reload this page — nothing has been opened or saved yet. If it still does not answer, ask your agent to open Snug again.',
  },
};

export function LocalRefusal({ kind, heldBy }: LocalRefusalProps): ReactElement {
  const copy = COPY[kind];
  return (
    <div data-testid={`local-refusal-${kind}`} style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{kind === 'held' && heldBy !== undefined ? `${heldBy} has your file` : copy.title}</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>{copy.body}</p>
      </div>
    </div>
  );
}
