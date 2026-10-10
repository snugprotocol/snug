// access/EgressNote.tsx — "where <app> can send what it reads" (TASK-20261010-cross-app-access
// AC15, AC18; ADR-0075 §8): the lines `egressFor` DERIVES from the routes themselves — its AI by
// name, each connection by provider, the link line, the away line, the closing sentence — in the
// order given. This component adds no words of its own: a line it invented would be a claim the
// routing never made.

import type { ReactElement } from 'react';

import { CONSENT_SHEET } from './copy.js';
import type { EgressLine } from './egress.js';

export interface EgressNoteProps {
  readerName: string;
  lines: readonly EgressLine[];
  titleId: string;
}

export function EgressNote({ readerName, lines, titleId }: EgressNoteProps): ReactElement {
  return (
    <section className="access-section" aria-labelledby={titleId}>
      <h3 id={titleId} className="access-section-title" data-testid="access-egress-title">
        {CONSENT_SHEET.egressTitle(readerName)}
      </h3>
      <ul className="access-egress" data-testid="access-egress">
        {lines.map((line, index) => (
          <li key={`${line.kind}-${index}`} data-kind={line.kind}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
