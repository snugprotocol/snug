// railLayout.ts — how wide the "watch it think" rail is, and whether it is shown at
// all (TASK-20260813 AC4/AC6). Persisted to localStorage and mirrored onto
// <html style="--rail-width">, so app.css can read one custom property instead of the
// hard-coded 340px the rail used to carry.
//
// Global rather than per-app, deliberately: the rail is a workspace preference like the
// theme, not a property of any one app. Someone who widens it to read a long prompt
// wants it wide for the NEXT app too.

import { createStore, useStore } from './store.js';

const WIDTH_KEY = 'snug:rail-width';
const SHOWN_KEY = 'snug:rail-shown';

/** The rail's original fixed width — still the default, now merely the starting point. */
export const RAIL_WIDTH_DEFAULT = 340;

/**
 * Below this the round trips are unreadable no matter how the CSS wraps, which is the
 * bug AC5 fixes — a drag that could reproduce it would just be a worse version of the
 * defect. Above 70% of the viewport the app under inspection stops being usable.
 */
export const RAIL_WIDTH_MIN = 280;

/** Fraction of the viewport the rail may occupy at most. */
export const RAIL_WIDTH_MAX_FRACTION = 0.7;

/** The widest the rail may be right now, given the viewport. */
export function railWidthMax(viewportWidth: number = globalThis.innerWidth || 1280): number {
  // Never let the ceiling fall below the floor on a narrow window: the clamp must stay
  // a valid range even at 375px, or `clampRailWidth` would invert and return the min.
  return Math.max(RAIL_WIDTH_MIN, Math.round(viewportWidth * RAIL_WIDTH_MAX_FRACTION));
}

/** Clamp any candidate width (drag, restored value, or a corrupted store) into range. */
export function clampRailWidth(width: number, viewportWidth?: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH_DEFAULT;
  return Math.min(Math.max(Math.round(width), RAIL_WIDTH_MIN), railWidthMax(viewportWidth));
}

function readInitialWidth(): number {
  try {
    const stored = localStorage.getItem(WIDTH_KEY);
    if (stored !== null) {
      const parsed = Number.parseInt(stored, 10);
      // A stored value is clamped, not trusted: the window may be far narrower than it
      // was when the width was saved, and a rail wider than the screen is a dead app.
      if (Number.isFinite(parsed)) return clampRailWidth(parsed);
    }
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return RAIL_WIDTH_DEFAULT;
}

function readInitialShown(): boolean {
  try {
    // Default ON (AC6): "watch it think" is the feature, so it must be present unless
    // the user has explicitly turned it off. Only the exact string 'false' hides it —
    // any other value, including junk, leaves the feature visible.
    return localStorage.getItem(SHOWN_KEY) !== 'false';
  } catch {
    return true;
  }
}

export const railWidthStore = createStore<number>(readInitialWidth());
export const railShownStore = createStore<boolean>(readInitialShown());

/** Mirror the width onto the document so `.rail` can consume it as a custom property. */
export function applyRailWidthToDocument(width: number): void {
  document.documentElement.style.setProperty('--rail-width', `${width}px`);
}

export function setRailWidth(width: number): void {
  const clamped = clampRailWidth(width);
  railWidthStore.set(clamped);
  applyRailWidthToDocument(clamped);
  try {
    localStorage.setItem(WIDTH_KEY, String(clamped));
  } catch {
    /* private mode — the width still applies for this session */
  }
}

export function setRailShown(shown: boolean): void {
  railShownStore.set(shown);
  try {
    localStorage.setItem(SHOWN_KEY, String(shown));
  } catch {
    /* private mode — the choice still applies for this session */
  }
}

export function toggleRailShown(): void {
  setRailShown(!railShownStore.get());
}

export function useRailWidth(): number {
  return useStore(railWidthStore);
}

export function useRailShown(): boolean {
  return useStore(railShownStore);
}

// Keep the document property honest on module load, as theme.ts does.
applyRailWidthToDocument(railWidthStore.get());
