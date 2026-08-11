import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';


import type { BuildStepView, ChatMessage } from '../agent/useBuilderChat.js';
import { Button } from '../ui/Button.js';
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
  /**
   * Mount for a VALIDATED `auth_wizard` directive card: the caller wires this to the
   * connection wizard with the attached appId. Absent ⇒ the card renders with a disabled
   * CTA (no app to attach the connection to yet).
   *
   * It takes NO argument. In v4 the card is a DOORBELL: the requirement was already
   * persisted at build time through the gated pipeline, so what the wizard reviews comes
   * from the row and the card cannot propose anything at click time.
   */
  onDirectiveConnect?: () => void;
  /**
   * Mount for the v4 connect card. Receives the (appId, slot) of the PERSISTED row so
   * the caller can open the wizard on exactly that connection — not a provider name the
   * caller would have to resolve back to a row.
   */
  onConnectionConnect?: (connection: { appId: string; slot: string }) => void;
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
  onDirectiveConnect,
  onConnectionConnect,
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
            {message.directiveNote !== undefined ? <div className="hint">{message.directiveNote}</div> : null}
          </div>
          {message.directive !== undefined ? (
            <Card className="artifact-card" data-testid="auth-directive-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                🔐
              </span>
              <span className="artifact-name">connect {message.directive.proposal.providerName}</span>
              {onDirectiveConnect !== undefined ? (
                <Button onClick={() => onDirectiveConnect()}>connect</Button>
              ) : (
                <span className="hint">run the app once to attach this connection</span>
              )}
            </Card>
          ) : null}
          {/*
            The v4 CONNECT CARD. It renders only when the post-turn pipeline actually
            PERSISTED a row, so it can never advertise a connection that does not exist —
            the v3 card rendered from the reply's directive and could outlive a refused
            requirement. Clicking it opens the wizard on that (appId, slot); everything
            the user reviews is read from the row.
          */}
          {message.connection !== undefined ? (
            <Card className="artifact-card" data-testid="connection-requirement-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                🔌
              </span>
              <span className="artifact-name">connect {message.connection.providerName}</span>
              {onConnectionConnect !== undefined ? (
                <Button onClick={() => onConnectionConnect(message.connection!)}>connect</Button>
              ) : (
                <span className="hint">run the app once to attach this connection</span>
              )}
            </Card>
          ) : null}
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
