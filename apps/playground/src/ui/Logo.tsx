import type { ReactElement } from 'react';

export interface LogoProps {
  /** Rendered edge length in px. Defaults to the header lockup size. */
  size?: number;
  className?: string;
}

/**
 * The snug mark — "The Ember Niche" (variant C, TASK-20260804-logo-variants.md).
 *
 * A filled ember tile with an arched niche knocked out of its lower half: the warmth
 * is the mass, the shelter is the void. The counter is a true knockout via
 * `fill-rule="evenodd"`, so the page background shows through and the mark survives on
 * any surface rather than only the two theme backgrounds.
 *
 * Fill is `currentColor` — the call site sets `color: var(--ember)` and the light theme
 * swaps that token for free. Decorative by default (`aria-hidden`): in the header it sits
 * beside the "snug." wordmark, which already carries the accessible name, so announcing
 * it again would just double up for a screen reader.
 */
export function Logo({ size = 28, className }: LogoProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8zm6 9a5 5 0 0 0-5 5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6a5 5 0 0 0-5-5z"
      />
    </svg>
  );
}
