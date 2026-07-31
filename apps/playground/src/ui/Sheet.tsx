import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';

export interface SheetProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Bottom sheet — the mobile form of the rail. Esc and backdrop tap both close. */
export function Sheet({ title, open, onClose, children }: SheetProps): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="rail-header">
          <span className="rail-title">{title}</span>
          <button type="button" className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
            close
          </button>
        </div>
        <div className="rail-body">{children}</div>
      </div>
    </>
  );
}
