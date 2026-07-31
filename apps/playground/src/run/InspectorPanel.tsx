import type { ReactElement } from 'react';

import { EmptyState } from '../ui/EmptyState.js';
import type { InspectorEntry } from './inspector.js';

export interface InspectorPanelProps {
  entries: InspectorEntry[];
}

/** The live frame timeline. Structural payloads only — see inspector.ts. */
export function InspectorPanel({ entries }: InspectorPanelProps): ReactElement {
  if (entries.length === 0) {
    return <EmptyState glyph="◍" title="quiet so far" lesson="frames appear here the moment the app talks to the host." />;
  }
  return (
    <ol className="inspector-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {entries.map((entry) => (
        <li key={entry.id} className={`inspector-entry${entry.isError ? ' is-error' : ''}`}>
          <span className={`dir ${entry.direction}`} aria-label={entry.direction === 'inbound' ? 'from app' : 'to app'}>
            {entry.direction === 'inbound' ? '↑' : '↓'}
          </span>
          <span>
            <span className="frame-label">{entry.label}</span>
            {entry.detail !== '' ? <span className="frame-detail"> — {entry.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
