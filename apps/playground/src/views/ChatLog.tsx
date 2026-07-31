import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import type { ChatMessage } from '../agent/useBuilderChat.js';
import { Card } from '../ui/Card.js';

export interface ChatLogProps {
  messages: ChatMessage[];
  activity: string | undefined;
  /** Compact mode for the run-view chat rail (smaller artifact cards). */
  compact?: boolean;
}

/** The streamed conversation: user bubbles, streaming agent text with a soft caret,
    error notes as data, and the artifact card with its "run it" CTA. */
export function ChatLog({ messages, activity, compact = false }: ChatLogProps): ReactElement {
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
      {activity !== undefined ? (
        <span className="reasoning-pill">
          <span className="pulse-dot" aria-hidden="true" />
          {activity}
        </span>
      ) : null}
    </div>
  );
}
