// ThinkPanel — the "watch it think" surface: the LLM round trips (what we asked the
// model, what came back).
//
// It used to carry a SECOND section below this one, the app↔host frame timeline. That
// was removed in TASK-20260813 (AC11) as owner-reported noise: it listed frame types
// with no values — deliberately, as a privacy guarantee — which made it unreadable as
// a debugging aid and meaningless as a narrative. The round trips are what "watch it
// think" actually means.
//
// The FEED behind that section (run/inspector.ts) is deliberately still alive and
// still byte-locked: RunView reads its `inFlight` count to drive the app-frame
// "thinking" pulse and its `sawDbOp` flag to gate the export button. Only the view is
// gone. Do not delete the reducer while chasing this comment.
//
// PRESENTATION ONLY — this component must never reach past LlmInspectorPanel into the
// reducer.

import type { ReactElement, ReactNode } from 'react';

import type { TurnMode } from '../state/webllm.js';
import { LlmInspectorPanel } from './LlmInspectorPanel.js';
import type { LlmInspectorState } from './llmInspector.js';

export interface ThinkPanelProps {
  llm: LlmInspectorState;
  /** Drives the honest empty copy in the LLM section — the EFFECTIVE turn mode (AC15). */
  mode: TurnMode;
}

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }): ReactElement {
  return (
    <section className="think-section" data-testid="think-section" data-section={id}>
      <header className="think-section-head">
        <h3>{title}</h3>
        <span className="think-section-hint">{hint}</span>
      </header>
      {children}
    </section>
  );
}

export function ThinkPanel({ llm, mode }: ThinkPanelProps): ReactElement {
  return (
    <div className="think-panel">
      <Section id="llm" title="model round trips" hint="prompt in, reply out">
        <LlmInspectorPanel state={llm} mode={mode} />
      </Section>
    </div>
  );
}
