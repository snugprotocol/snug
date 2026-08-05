// ThinkPanel — the merged "watch it think" surface (AC10). One tab, one scroll
// container: the LLM round trip on TOP (what we asked the model, what came back),
// the bridge/frame timeline BELOW (what the app said to the host).
//
// PRESENTATION ONLY. The two feeds keep their own reducers, with deliberately
// OPPOSITE rules — llmInspector.ts renders bodies on purpose, inspector.ts is
// value-blind as a privacy guarantee (task D2). This component composes the two
// panels; it must never reach past them into either reducer. AC11 locks the
// structural module byte-for-byte so the visual merge cannot creep into a real one.

import type { ReactElement, ReactNode } from 'react';

import type { PlaygroundMode } from '../state/mode.js';
import type { InspectorEntry } from './inspector.js';
import { InspectorPanel } from './InspectorPanel.js';
import { LlmInspectorPanel } from './LlmInspectorPanel.js';
import type { LlmInspectorState } from './llmInspector.js';

export interface ThinkPanelProps {
  llm: LlmInspectorState;
  frames: InspectorEntry[];
  /** Drives the honest, mode-branched empty copy in the LLM section (AC15). */
  mode: PlaygroundMode;
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

export function ThinkPanel({ llm, frames, mode }: ThinkPanelProps): ReactElement {
  return (
    <div className="think-panel">
      <Section id="llm" title="model round trips" hint="prompt in, reply out">
        <LlmInspectorPanel state={llm} mode={mode} />
      </Section>
      <Section id="frames" title="app ↔ host frames" hint="structure only, never values">
        <InspectorPanel entries={frames} />
      </Section>
    </div>
  );
}
