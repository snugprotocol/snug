import type { CSSProperties, ReactElement } from 'react';

export interface SkeletonProps {
  width?: string;
  height?: string;
  style?: CSSProperties;
  className?: string;
}

/** Loading placeholder — skeletons, never spinners (survey AVOID list). */
export function Skeleton({ width = '100%', height = '1rem', style, className }: SkeletonProps): ReactElement {
  return (
    <div
      aria-hidden="true"
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, ...style }}
    />
  );
}
