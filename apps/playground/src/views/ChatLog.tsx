import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import type { BuildStepView, ChatMessage } from '../agent/useBuilderChat.js';
import { Card } from '../ui/Card.js';
import { StatusLine, type StatusPhase } from './StatusLine.js';

export interface ChatLogProps {
  messages: ChatMessage[];
  /**
   * Ordered build steps for the in-flight turn (empty when idle).
   *
   * No longer rendered as a timeline — the status line replaces that surface (AC9), and
   * the factual per-tool record lives in the LLM inspector, nested under the round trip
   * that requested each tool (AC5). Kept as a prop because a non-empty `steps` is still
   * the signal that a turn is running.
   */
  steps?: BuildStepView[];
  /** Tool activity label — retained for callers; no longer rendered as copy. */
  activity?: string | undefined;
  /**
   * Whether a turn is actually in flight — the ONLY signal the status line keys on.
   *
   * Deliberately not `steps.length > 0`: `steps` is cleared at turn START and never at
   * turn END, so it legitimately outlives the turn as a record of what ran. Keying a
   * live "in flight" indicator on it left the line rotating forever under a finished
   * build (Gate-5 review, 2026-08-05). `busy` is cleared in useBuilderChat's `finally`.
   */
  busy?: boolean;
  /** Which half of the build the user is in; drives the status copy (AC10). */
  phase?: StatusPhase;
  /** Compact mode for the run-view chat rail (smaller artifact cards). */
  compact?: boolean;
}

/** The streamed conversation: user bubbles, streaming agent text with a soft caret,
    error notes as data, and the artifact card with its "run it" CTA. */
export function ChatLog({
  messages,
  steps = [],
  activity,
  busy = false,
  phase = 'build',
  compact = false,
}: ChatLogProps): ReactElement {
  return (
    <div className="chat-log" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} style={{ display: 'contents' }}>
          <div className={`msg ${message.role === 'user' ? 'msg-user' : 'msg-agent'}`}>
            <span className={message.streaming === true && message.displayText !== '' ? 'streaming-caret' : undefined}>
              {message.displayText}
            </span>
            {message.error !== undefined ? (
              <div className="error-note" role="alert">
                {message.error.message}
                {message.error.retryable ? ' — try again.' : ''}
              </div>
            ) : null}
          </div>
          {message.artifact !== undefined ? (
            <Card className="artifact-card" data-testid="artifact-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                ✦
              </span>
              <span className="artifact-name">{message.artifact.displayName}</span>
              {compact ? null : (
                <Link to={`/run/${message.artifact.artifactId}`} className="btn btn-primary">
                  run it
                </Link>
              )}
            </Card>
          ) : null}
        </div>
      ))}
      {/*
        One rotating status line in place of BOTH the step timeline and the
        last-write-wins pill (AC9). The two said roughly the same thing in two places,
        and neither said as much as the LLM inspector already shows — which is where the
        factual record now lives (AC5, D0/Q1).
      */}
      <StatusLine phase={phase} active={busy} />
    </div>
  );
}
