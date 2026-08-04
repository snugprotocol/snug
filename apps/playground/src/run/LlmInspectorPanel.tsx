// LlmInspectorPanel — the LLM round-trip surface (AC13). Sibling of InspectorPanel,
// deliberately NOT an extension of it: that one is structural-only by design, this
// one shows request/response bodies because seeing the prompt IS the point.
//
// Everything rendered here is redacted and bounded upstream in llmInspector.ts; this
// component is a pure projection and stores nothing.

import { useState, type ReactElement } from 'react';

import { EmptyState } from '../ui/EmptyState.js';
import type { LlmInspectorEntry, LlmInspectorState } from './llmInspector.js';

export interface LlmInspectorPanelProps {
  state: LlmInspectorState;
}

const ms = (value: number): string => (value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`);

function tokenLine(entry: LlmInspectorEntry): string | undefined {
  if (entry.usage === undefined) return undefined;
  const parts: string[] = [];
  if (entry.usage.inputTokens !== undefined) parts.push(`${entry.usage.inputTokens.toLocaleString()} in`);
  if (entry.usage.outputTokens !== undefined) parts.push(`${entry.usage.outputTokens.toLocaleString()} out`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** One round trip, collapsed by default — a 48-iteration build must stay scannable. */
function RoundTrip({ entry }: { entry: LlmInspectorEntry }): ReactElement {
  const [open, setOpen] = useState(false);
  const tokens = tokenLine(entry);
  return (
    <li className={`llm-entry${entry.isError ? ' is-error' : ''}`} data-testid="llm-round-trip">
      <button type="button" className="llm-entry-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="llm-index">#{entry.index + 1}</span>
        <span className="llm-summary">
          {entry.isError ? (entry.code ?? 'error') : (entry.stopReason ?? 'end')}
          {entry.toolCalls.length > 0 ? ` · ${entry.toolCalls.map((call) => call.name).join(', ')}` : ''}
        </span>
        <span className="llm-meta">
          {ms(entry.durationMs)}
          {tokens !== undefined ? ` · ${tokens}` : ''}
        </span>
      </button>
      {open ? (
        <div className="llm-entry-body">
          <section>
            <h4>sent</h4>
            {entry.toolNames.length > 0 ? <p className="llm-tools">tools: {entry.toolNames.join(', ')}</p> : null}
            <pre className="llm-block">{entry.system}</pre>
            <pre className="llm-block">{JSON.stringify(entry.messages, null, 2)}</pre>
          </section>
          <section>
            <h4>received</h4>
            {entry.isError ? <p className="llm-error">{entry.message}</p> : null}
            {entry.text !== '' ? <pre className="llm-block">{entry.text}</pre> : null}
            {entry.toolCalls.length > 0 ? (
              <pre className="llm-block">{JSON.stringify(entry.toolCalls, null, 2)}</pre>
            ) : null}
          </section>
        </div>
      ) : null}
    </li>
  );
}

export function LlmInspectorPanel({ state }: LlmInspectorPanelProps): ReactElement {
  if (state.entries.length === 0) {
    return (
      <EmptyState
        glyph="↯"
        title="no round trips yet"
        lesson="every call to the model shows up here — prompt, reply, tokens, timing. this view is in-memory only."
      />
    );
  }
  const { inputTokens, outputTokens } = state.totalUsage;
  return (
    <div className="llm-inspector">
      <p className="llm-totals" data-testid="llm-totals">
        {state.entries.length} round trip{state.entries.length === 1 ? '' : 's'} · {ms(state.totalDurationMs)}
        {inputTokens !== undefined || outputTokens !== undefined
          ? ` · ${(inputTokens ?? 0).toLocaleString()} in / ${(outputTokens ?? 0).toLocaleString()} out`
          : ''}
      </p>
      <ol className="llm-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {state.entries.map((entry, index) => (
          <RoundTrip key={`${entry.index}-${index}`} entry={entry} />
        ))}
      </ol>
    </div>
  );
}
