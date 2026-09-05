// LlmInspectorPanel — the LLM round-trip surface (AC13). Sibling of InspectorPanel,
// deliberately NOT an extension of it: that one is structural-only by design, this
// one shows request/response bodies because seeing the prompt IS the point.
//
// Everything rendered here is redacted and bounded upstream in llmInspector.ts; this
// component is a pure projection and stores nothing.

import { memo, useEffect, useState, type ReactElement } from 'react';

import type { TurnMode } from '../state/webllm.js';
import { EmptyState } from '../ui/EmptyState.js';
import type { LlmInspectorEntry, LlmInspectorState, LlmInspectorTool } from './llmInspector.js';

export interface LlmInspectorPanelProps {
  state: LlmInspectorState;
  /**
   * The EFFECTIVE turn mode (`useTurnMode()` — configured mode with the webllm brain
   * override applied), never the raw mode: the brain makes the raw mode lie about
   * where turns execute (AC15, R4; review 2026-08-06 F3).
   */
  mode: TurnMode;
}

const ms = (value: number): string => (value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`);

/** Byte size for a section header (AC6) — the payload is whole, so its size is worth knowing. */
const bytes = (value: string): string =>
  value.length < 1024 ? `${value.length} B` : `${(value.length / 1024).toFixed(1)} KB`;

function tokenLine(entry: LlmInspectorEntry): string | undefined {
  if (entry.usage === undefined) return undefined;
  const parts: string[] = [];
  if (entry.usage.inputTokens !== undefined) parts.push(`${entry.usage.inputTokens.toLocaleString()} in`);
  if (entry.usage.outputTokens !== undefined) parts.push(`${entry.usage.outputTokens.toLocaleString()} out`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Cached share of the input, as a percentage — AC13's absent-not-zero rule.
 *
 * Returns undefined when the provider reported NOTHING about caching, so the UI shows
 * no cache line at all rather than "0% cached", which would be a claim the provider
 * never made. A genuine reported 0 (a cache write with no read) does render as 0%.
 */
function cachedPercent(entry: LlmInspectorEntry): number | undefined {
  const { usage } = entry;
  if (usage === undefined) return undefined;
  const { cacheReadTokens, cacheCreationTokens, inputTokens } = usage;
  if (cacheReadTokens === undefined && cacheCreationTokens === undefined) return undefined;
  const read = cacheReadTokens ?? 0;
  // The denominator is the whole prompt: uncached input + what the cache served.
  const total = (inputTokens ?? 0) + read + (cacheCreationTokens ?? 0);
  return total === 0 ? 0 : Math.round((read / total) * 100);
}

/**
 * Elapsed time for an in-flight call, ticking while it runs (AC8).
 *
 * Owns its own interval rather than driving one from the reducer: a tick that went
 * through state would re-render the whole round-trip list every 100ms for the length of
 * a 30-minute build (R5). Here only this leaf re-renders, and only while pending.
 */
function LiveTimer({ startedAt }: { startedAt: number }): ReactElement {
  // Anchored to when the ROUND TRIP started, not when this component mounted
  // (TASK-20260813 AC7): the rail's tab strip unmounts this subtree, so a mount-relative
  // clock restarted a long call's elapsed time at 0 every time the user looked away and
  // back. Seeded synchronously for the same reason — a 0 first paint would flash a
  // 30-minute call back to "0ms".
  const [elapsed, setElapsed] = useState(() => Math.max(0, performance.now() - startedAt));
  useEffect(() => {
    const tick = (): void => setElapsed(Math.max(0, performance.now() - startedAt));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <span data-testid="llm-pending" className="llm-pending">
      {ms(elapsed)}
    </span>
  );
}

/** One tool the round trip requested, with its own elapsed time (AC5). */
function ToolRow({ tool }: { tool: LlmInspectorTool }): ReactElement {
  return (
    <li className="llm-tool" data-testid="llm-tool">
      <span className="llm-tool-name">{tool.name}</span>
      <span className="llm-tool-meta">{tool.pending ? 'running…' : ms(tool.durationMs ?? 0)}</span>
    </li>
  );
}

/**
 * One round trip, collapsed by default — a 48-iteration build must stay scannable.
 *
 * Memoized (R5): a pending entry re-renders on every timer tick, and without this the
 * whole list would re-render with it for the length of a 30-minute build.
 */
const RoundTrip = memo(function RoundTrip({ entry }: { entry: LlmInspectorEntry }): ReactElement {
  const [open, setOpen] = useState(false);
  const tokens = tokenLine(entry);
  const cached = cachedPercent(entry);
  const sent = `${entry.system}\n${JSON.stringify(entry.messages, null, 2)}`;
  const received = `${entry.text}${entry.toolCalls.length > 0 ? `\n${JSON.stringify(entry.toolCalls, null, 2)}` : ''}`;
  return (
    <li
      className={`llm-entry${entry.isError ? ' is-error' : ''}${entry.pending ? ' is-pending' : ''}`}
      data-testid="llm-round-trip"
    >
      <button type="button" className="llm-entry-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="llm-index">#{entry.index + 1}</span>
        <span className="llm-summary">
          {entry.pending ? 'in flight' : entry.isError ? (entry.code ?? 'error') : (entry.stopReason ?? 'end')}
          {entry.model !== undefined ? (
            <span className="llm-model" data-testid="llm-model">
              {' '}
              · {entry.model}
            </span>
          ) : null}
        </span>
        <span className="llm-meta">
          {entry.pending ? (
            <LiveTimer startedAt={entry.startedAt} />
          ) : (
            <>
              {ms(entry.durationMs ?? 0)}
              {tokens !== undefined ? ` · ${tokens}` : ''}
              {cached !== undefined ? (
                <span data-testid="llm-cached"> · {cached}% cached</span>
              ) : null}
            </>
          )}
        </span>
      </button>
      {entry.tools.length > 0 ? (
        <ol className="llm-tool-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {entry.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </ol>
      ) : null}
      {open ? (
        <div className="llm-entry-body">
          <section>
            <h4>
              sent <span className="llm-size" data-testid="llm-sent-size">{bytes(sent)}</span>
            </h4>
            {entry.toolNames.length > 0 ? <p className="llm-tools">tools: {entry.toolNames.join(', ')}</p> : null}
            {/* The COMPLETE payload — nothing is truncated at ingest any more (AC6). */}
            <pre className="llm-block">{entry.system}</pre>
            <pre className="llm-block">{JSON.stringify(entry.messages, null, 2)}</pre>
          </section>
          <section>
            <h4>
              received <span className="llm-size" data-testid="llm-received-size">{bytes(received)}</span>
            </h4>
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
});

/**
 * The honest empty state (AC15). The old copy — "every call to the model shows up
 * here" — is FALSE in subscription mode: `apps/server/src/routes/invoke.ts` forwards
 * tool name + phase only and keeps `round_trip` server-side, so this surface can never
 * populate there however long you wait.
 *
 * R4: this branches on the MODE VALUE. If subscription mode later gains a round-trip
 * wire event, only this switch has to change — the wrong copy cannot silently persist
 * behind a hardcoded assumption.
 */
function emptyCopy(mode: TurnMode): { title: string; lesson: string } {
  switch (mode) {
    case 'subscription':
      return {
        title: 'nothing to show in subscription mode',
        lesson:
          'the hub runs the model server-side and never sends the round trip back, so this stays empty by design — switch to byok or local mode in settings to watch the prompts.',
      };
    case 'byok':
      return {
        title: 'no round trips yet',
        lesson:
          'your browser calls the model directly in byok mode, so each prompt, reply, token count and timing lands here the moment a turn runs. in-memory only.',
      };
    case 'local':
      return {
        title: 'no round trips yet',
        lesson:
          'your browser calls your local endpoint directly, so each prompt, reply, token count and timing lands here the moment a turn runs. in-memory only.',
      };
    case 'webllm':
      return {
        title: 'no round trips yet',
        lesson:
          'the experimental in-browser model runs on WebGPU inside this tab, so each prompt, reply, token count and timing lands here the moment a turn runs. in-memory only.',
      };
    case 'host':
      return {
        title: 'no round trips yet',
        lesson:
          'the host you opened Snug in answers each turn directly, so each prompt, reply and timing lands here the moment a turn runs. in-memory only.',
      };
  }
}

export function LlmInspectorPanel({ state, mode }: LlmInspectorPanelProps): ReactElement {
  if (state.entries.length === 0) {
    const { title, lesson } = emptyCopy(mode);
    return <EmptyState glyph="↯" title={title} lesson={lesson} />;
  }
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = state.totalUsage;
  // Same absent-not-zero rule as the per-entry line: no cache figure unless a provider
  // actually reported one somewhere in the turn (AC13).
  const totalCached =
    cacheReadTokens === undefined && cacheCreationTokens === undefined
      ? undefined
      : Math.round(
          ((cacheReadTokens ?? 0) /
            Math.max(1, (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0))) *
            100,
        );
  return (
    <div className="llm-inspector">
      <p className="llm-totals" data-testid="llm-totals">
        {state.entries.length} round trip{state.entries.length === 1 ? '' : 's'} · {ms(state.totalDurationMs)}
        {inputTokens !== undefined || outputTokens !== undefined
          ? ` · ${(inputTokens ?? 0).toLocaleString()} in / ${(outputTokens ?? 0).toLocaleString()} out`
          : ''}
        {totalCached !== undefined ? ` · ${totalCached}% cached` : ''}
      </p>
      <ol className="llm-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {/*
          Keyed by round-trip identity ALONE (TASK-20260813 AC8). This was
          `${entry.index}-${arrayPosition}`, but `evict()` drops the oldest entries and
          shifts every survivor's position — so an unchanged entry silently changed key,
          and React reused or remounted its subtree (including LiveTimer's interval)
          across identity boundaries. `entry.index` is already unique within a turn:
          the reducer resets on `onTurnStart`, so positions add nothing but the bug.
        */}
        {/* NEWEST FIRST (TASK-20260903 AC13, owner call): the latest round trip is what
            the user is waiting on, and this list sits in a scrolling box on both the
            build page and the run rail — top-of-list is the one position that is always
            in view without any auto-scroll. Tools stay chronological inside an entry. */}
        {state.entries
          .slice()
          .reverse()
          .map((entry) => (
            <RoundTrip key={entry.index} entry={entry} />
          ))}
      </ol>
    </div>
  );
}
