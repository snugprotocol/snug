import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  glyph: string;
  title: string;
  /** One sentence that teaches the next action — never more (design brief). */
  lesson: string;
  action?: ReactNode;
}

/** Empty state that teaches the next action in one sentence. */
export function EmptyState({ glyph, title, lesson, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-glyph" aria-hidden="true">
        {glyph}
      </div>
      <h2 className="empty-title">{title}</h2>
      <p>{lesson}</p>
      {action}
    </div>
  );
}
