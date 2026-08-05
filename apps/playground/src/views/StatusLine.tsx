// StatusLine — the single rotating status line shown while a turn is in flight.
//
// Replaces the last-write-wins reasoning pill AND the always-visible step timeline
// (AC9). Per D0/Q1 this is a REPLACEMENT, not a deletion: the factual record of what
// actually ran survives as the tools nested under each round trip in the LLM inspector
// (AC5), so a build's real actions stay inspectable after the fact. What goes is the
// duplicate ambient surface, which said less than the inspector already shows.

import { useEffect, useState, type ReactElement } from 'react';

/** Which half of the build the user is in — the copy differs between them (AC10). */
export type StatusPhase = 'build' | 'edit';

/**
 * Rotation cadence. Slow enough to read a full line, fast enough that a long build does
 * not look stuck on one message.
 */
const ROTATE_MS = 4200;

/**
 * Phase-appropriate copy (AC10).
 *
 * A first build is CREATING something from nothing; an edit is ADJUSTING something that
 * already works. Telling a user "designing the layout" while you are renaming one button
 * is worse than saying nothing, which is why these are two sets rather than one generic
 * one. Tests assert on the SELECTION, never on exact strings — this is editable copy.
 */
const MESSAGES: Record<StatusPhase, readonly string[]> = {
  build: [
    'planning the build…',
    'sketching the structure…',
    'designing the layout…',
    'building the app…',
    'wiring it together…',
    'checking the details…',
  ],
  edit: [
    'reading your app…',
    'working out the change…',
    'adjusting the code…',
    'refining the details…',
    'updating the app…',
    'checking nothing else broke…',
  ],
};

/** The copy set for a phase — the seam AC10 asserts on. */
export function pickStatusMessages(phase: StatusPhase): readonly string[] {
  return MESSAGES[phase];
}

/**
 * True when the user has asked for reduced motion. Read live rather than cached: a user
 * can change the OS setting mid-session, and the check is cheap.
 */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export interface StatusLineProps {
  phase: StatusPhase;
  /** Whether a turn is actually running — nothing renders when idle. */
  active: boolean;
}

export function StatusLine({ phase, active }: StatusLineProps): ReactElement | null {
  const messages = pickStatusMessages(phase);
  const [index, setIndex] = useState(0);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    // AC11: under reduced motion the line is STATIC — no animation and no rotation.
    // A message still shows, so the information is not lost, it just holds still.
    if (!active || reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % messages.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [active, reduced, messages.length]);

  // Restart from the top each turn so a new build does not resume mid-sequence.
  useEffect(() => {
    if (!active) setIndex(0);
  }, [active]);

  if (!active) return null;
  return (
    <span
      className={`status-line${reduced ? '' : ' is-animated'}`}
      data-testid="status-line"
      data-animated={String(!reduced)}
      role="status"
      aria-live="polite"
    >
      {reduced ? null : <span className="pulse-dot" aria-hidden="true" />}
      {messages[index % messages.length]}
    </span>
  );
}
