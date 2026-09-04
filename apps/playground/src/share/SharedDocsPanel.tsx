// SharedDocsPanel.tsx — the rail's "docs" tab for a SHARED PREVIEW (TASK-20260904, AC13).
//
// The bundle's wiki docs and — when the bundle carries one — "what this app tells the
// AI" (its runtime contract), read-only, before the user installs. This is the
// "check around" the owner asked for, and it is also the ADR-0063 §8(b) review moment:
// the contract is the only third-party text that will ever reach an LLM system slot,
// and it reaches it only through an install performed after it could be read here.
//
// TEXT NODES ONLY (AC16). Doc content and contract fields render as text in <pre>
// blocks; nothing from the bundle is handed to the DOM as HTML.

import type { ReactElement } from 'react';

import type { AppBundle } from '@snugprotocol/protocol';

export interface SharedDocsPanelProps {
  bundle: AppBundle;
}

export function SharedDocsPanel({ bundle }: SharedDocsPanelProps): ReactElement {
  const docs = bundle.docs ?? [];
  const contract = bundle.contract;
  return (
    <div className="docs-panel shared-docs" data-testid="shared-docs">
      {contract !== undefined ? (
        <section className="shared-doc" data-testid="shared-contract">
          <h3 className="shared-doc-title">what this app tells the AI</h3>
          <p className="hint">
            the instructions its author gave the model. installing keeps them; you can rewrite them in the app’s chat
            afterwards.
          </p>
          <pre className="shared-doc-body">{contract.overview}</pre>
          {contract.personaNote !== undefined ? <pre className="shared-doc-body">{contract.personaNote}</pre> : null}
          {contract.stateGuidance !== undefined ? <pre className="shared-doc-body">{contract.stateGuidance}</pre> : null}
          {contract.responseGuidance !== undefined ? <pre className="shared-doc-body">{contract.responseGuidance}</pre> : null}
        </section>
      ) : null}
      {docs.length === 0 ? (
        <p className="hint">this shared app came without docs.</p>
      ) : (
        docs.map((doc) => (
          <section key={doc.slug} className="shared-doc" data-testid={`shared-doc-${doc.slug}`}>
            <h3 className="shared-doc-title">{doc.title ?? doc.slug}</h3>
            <pre className="shared-doc-body">{doc.content}</pre>
          </section>
        ))
      )}
    </div>
  );
}
