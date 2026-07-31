import type { ButtonHTMLAttributes, ReactElement } from 'react';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Non-interactive chips (e.g. the inert "coming in v1.1" teaser). */
  inert?: boolean;
}

/** Pill chip — one-tap suggestion or inert label. Always ≥44px tall. */
export function Chip({ inert = false, className, disabled, ...rest }: ChipProps): ReactElement {
  const classes = ['chip', inert ? 'chip-static' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type="button" className={classes} disabled={disabled ?? inert} {...rest} />;
}
