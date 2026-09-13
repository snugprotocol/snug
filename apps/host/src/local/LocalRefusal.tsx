// The three states in which this page will not open — each naming what to do next, because
// a page that renders nothing is indistinguishable from one that is broken.

import type { ReactElement } from 'react';

export interface LocalRefusalProps {
  kind: 'no-token' | 'unreachable' | 'held';
  heldBy?: string;
}

const COPY: Record<LocalRefusalProps['kind'], { title: string; body: string }> = {
  'no-token': {
    title: 'Open Snug from your agent',
    body: 'This page needs a fresh address from the Snug runner. Ask your agent to open Snug, or run `snug-mcp open` in a terminal.',
  },
  unreachable: {
    title: 'The Snug runner is not answering',
    body: 'The local runner went away. Ask your agent to open Snug again.',
  },
  held: {
    title: 'Snug for Mac has your file',
    body: 'Your apps and data are open in the desktop app. Close it and reload this page — nothing here is lost, and this page will not write while the desktop holds the file.',
  },
};

export function LocalRefusal({ kind, heldBy }: LocalRefusalProps): ReactElement {
  const copy = COPY[kind];
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{kind === 'held' && heldBy !== undefined ? `${heldBy} has your file` : copy.title}</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>{copy.body}</p>
      </div>
    </div>
  );
}
