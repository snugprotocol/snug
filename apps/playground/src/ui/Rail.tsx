import type { ReactElement, ReactNode } from 'react';

export interface RailProps {
  title: string;
  children: ReactNode;
  headerExtra?: ReactNode;
}

/** Desktop side rail (≥760px). On mobile the same content renders in a Sheet. */
export function Rail({ title, children, headerExtra }: RailProps): ReactElement {
  return (
    <aside className="rail" aria-label={title}>
      <div className="rail-header">
        <span className="rail-title">{title}</span>
        {headerExtra}
      </div>
      <div className="rail-body">{children}</div>
    </aside>
  );
}
