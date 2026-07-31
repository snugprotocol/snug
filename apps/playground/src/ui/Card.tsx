import type { HTMLAttributes, ReactElement } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

/** Soft-radius surface card; `interactive` adds the lift-on-hover treatment. */
export function Card({ interactive = false, className, ...rest }: CardProps): ReactElement {
  const classes = ['card', interactive ? 'card-interactive' : '', className ?? ''].filter(Boolean).join(' ');
  return <div className={classes} {...rest} />;
}
