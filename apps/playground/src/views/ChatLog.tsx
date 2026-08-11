import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';


import type { BuildStepView, ChatMessage, DataWriteCardState } from '../agent/useBuilderChat.js';
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
  /** Approve a staged data-write proposal (ADR-0019 D8). Absent ⇒ the card is read-only. */
  onApproveDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
  /** Decline it. Declining executes nothing — there is no path from here to the DB. */
  onDeclineDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
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
  onApproveDataWrite,
  onDeclineDataWrite,
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
          {/*
            The DATA-WRITE APPROVAL CARD (ADR-0019 D8). Everything the user is agreeing
            to is ON the card — the plain-language summary, the VERBATIM statements, and
            the affected-row counts — because "the human approves" only means something
            if the human can see what they are approving.

            Once resolved the buttons are gone: an approved change that still offers
            "apply" invites a second, unreviewed execution.
          */}
          {message.dataWrite !== undefined ? (
            <Card className="artifact-card" data-testid="data-write-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
                <span className="artifact-name">{message.dataWrite.summary}</span>
                <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                  {message.dataWrite.statements.map((statement, index) => (
                    <li key={`${message.id}-sql-${index}`}>
                      <code style={{ wordBreak: 'break-word' }}>{statement}</code>
                      <span className="hint">
                        {' '}
                        — {message.dataWrite?.previewed[index] ?? 0} row(s)
                      </span>
                    </li>
                  ))}
                </ol>
                {message.dataWrite.outcome === undefined ? (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {onApproveDataWrite !== undefined ? (
                      <Button variant="primary" onClick={() => onApproveDataWrite(message.dataWrite!, message.id)}>
                        apply to my data
                      </Button>
                    ) : null}
                    {onDeclineDataWrite !== undefined ? (
                      <Button onClick={() => onDeclineDataWrite(message.dataWrite!, message.id)}>cancel</Button>
                    ) : null}
                  </div>
                ) : (
                  <span className="hint">
                    {message.dataWrite.outcome === 'applied'
                      ? `applied — ${(message.dataWrite.executed ?? message.dataWrite.previewed).join(', ')} row(s) changed`
                      : message.dataWrite.outcome === 'declined'
                        ? 'cancelled — nothing was changed'
                        : message.dataWrite.outcome === 'drifted'
                          ? 'your data changed since this was previewed, so nothing was applied — ask again to get a fresh preview'
                          : 'the change could not be applied — nothing was changed'}
                  </span>
                )}
              </div>
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
