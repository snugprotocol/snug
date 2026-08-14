// railLayout — TASK-20260813 AC4/AC5/AC6: the "watch it think" rail is user-sized,
// dismissible, and its payloads stay readable.
//
// The primary fix for the unreadable panel is AC4: the rail was a hard `width: 340px`,
// leaving ~280px of text column for full system prompts and pretty-printed JSON. It is
// now draggable and persisted, so the user can give the payload the width it needs.
//
// AC5's CSS changes (`overflow-wrap: break-word` instead of `anywhere`, plus
// `min-width: 0` down the flex chain) are DEFENSIVE, not a reproduced fix. `anywhere`
// genuinely does lower min-content width where `break-word` does not, and a flex item
// without `min-width: 0` genuinely refuses to shrink below min-content — both are real
// hazards, and they matter more now that the rail's width is variable rather than
// pinned. But a browser harness at 340px, at narrow viewports, and in the builder's
// `<details>` context all measured ~35 and ~96 chars per line BEFORE the change: the
// one-character-per-line collapse did not reproduce, so these guards are hardening the
// mechanism rather than locking a defect anyone has seen fail here.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RailDivider } from '../ui/RailDivider.js';
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MIN,
  clampRailWidth,
  railShownStore,
  railWidthMax,
  railWidthStore,
  setRailShown,
  setRailWidth,
  toggleRailShown,
} from '../state/railLayout.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../theme/app.css'), 'utf8');

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(node: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

beforeEach(() => {
  localStorage.clear();
  railWidthStore.set(RAIL_WIDTH_DEFAULT);
  railShownStore.set(true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Read one CSS rule body by selector, anchored so `.rail-divider` ≠ `.rail`. */
function rule(selector: string): string {
  const match = css.match(new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`no ${selector} rule in app.css`);
  return match[2];
}

describe('AC4 — the rail width is user-controlled and persisted', () => {
  it('drives the rail from a custom property instead of a hard-coded width', () => {
    // The literal 340px was THE constraint behind the unreadable panel. It survives
    // only as a fallback for contexts where the store has not set the property.
    expect(rule('.rail')).toMatch(/width:\s*var\(--rail-width/);
  });

  it('clamps any width into a usable range', () => {
    // Below the floor the payloads are unreadable however the CSS wraps — reproducing
    // the very bug this task fixes. Above the ceiling the app under inspection is gone.
    expect(clampRailWidth(10)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(99_999)).toBe(railWidthMax());
    expect(clampRailWidth(420)).toBe(420);
  });

  it('falls back to the default rather than NaN when handed garbage', () => {
    // A corrupted localStorage value must not produce `width: NaNpx`, which drops the
    // declaration and silently restores the 340px fallback with no way to tell.
    expect(clampRailWidth(Number.NaN)).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('persists the chosen width and mirrors it onto the document', () => {
    setRailWidth(500);
    expect(railWidthStore.get()).toBe(500);
    expect(localStorage.getItem('snug:rail-width')).toBe('500');
    expect(document.documentElement.style.getPropertyValue('--rail-width')).toBe('500px');
  });

  it('persists the CLAMPED width, never the raw drag value', () => {
    // Otherwise a drag off the edge stores 4000px and the next load starts unusable.
    setRailWidth(99_999);
    expect(localStorage.getItem('snug:rail-width')).toBe(String(railWidthMax()));
  });

  it('the divider is a labelled separator carrying its live value', () => {
    const el = mount(<RailDivider />);
    const divider = el.querySelector('[data-testid="rail-divider"]')!;
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-label')).toBeTruthy();
    expect(divider.getAttribute('aria-valuenow')).toBe(String(RAIL_WIDTH_DEFAULT));
    // Focusable, or it cannot be operated without a pointer.
    expect(divider.getAttribute('tabindex')).toBe('0');
  });

  it('resizes from the keyboard — arrows nudge, Home/End reach the bounds', () => {
    const el = mount(<RailDivider />);
    const divider = el.querySelector<HTMLElement>('[data-testid="rail-divider"]')!;
    const press = (key: string): void => {
      act(() => {
        divider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    };

    // Left GROWS the rail: the rail is on the right, so dragging the seam leftward is
    // what widens it, and the key must match the gesture.
    press('ArrowLeft');
    expect(railWidthStore.get()).toBeGreaterThan(RAIL_WIDTH_DEFAULT);
    press('ArrowRight');
    expect(railWidthStore.get()).toBe(RAIL_WIDTH_DEFAULT);

    press('End');
    expect(railWidthStore.get()).toBe(RAIL_WIDTH_MIN);
    press('Home');
    expect(railWidthStore.get()).toBe(railWidthMax());
  });

  it('ignores keys it does not own, so typing does not resize the panel', () => {
    const el = mount(<RailDivider />);
    const divider = el.querySelector<HTMLElement>('[data-testid="rail-divider"]')!;
    act(() => {
      divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    expect(railWidthStore.get()).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('double-click restores the default width', () => {
    setRailWidth(600);
    const el = mount(<RailDivider />);
    const divider = el.querySelector<HTMLElement>('[data-testid="rail-divider"]')!;
    act(() => {
      divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(railWidthStore.get()).toBe(RAIL_WIDTH_DEFAULT);
  });

  it('disables pointer events on the app frame while dragging', () => {
    // The stage holds a cross-origin iframe. Pointer capture does not cross documents,
    // so without this the frame swallows the pointer the moment the cursor leaves the
    // 6px handle and the drag dies halfway across the screen.
    expect(rule('.run-layout.is-resizing .frame-wrap')).toMatch(/pointer-events:\s*none/);
  });
});

describe('AC6 — the rail can be toggled off, and defaults on', () => {
  it('defaults to shown with nothing stored', () => {
    localStorage.clear();
    expect(localStorage.getItem('snug:rail-shown')).toBeNull();
    // "watch it think" IS the feature — it must be present unless explicitly dismissed.
    expect(railShownStore.get()).toBe(true);
  });

  it('toggles off and back on, persisting each choice', () => {
    toggleRailShown();
    expect(railShownStore.get()).toBe(false);
    expect(localStorage.getItem('snug:rail-shown')).toBe('false');

    toggleRailShown();
    expect(railShownStore.get()).toBe(true);
    expect(localStorage.getItem('snug:rail-shown')).toBe('true');
  });

  it('only the exact string "false" hides it — junk leaves the feature visible', () => {
    // A half-written or foreign value must fail SAFE: hiding the main surface because
    // of a corrupted key would look like the feature vanished.
    setRailShown(true);
    localStorage.setItem('snug:rail-shown', 'not-a-boolean');
    expect(localStorage.getItem('snug:rail-shown')).not.toBe('false');
  });
});

describe('AC5 — round-trip payloads stay readable in the rail', () => {
  it('.llm-block no longer volunteers a one-character minimum width', () => {
    // `anywhere` and `break-word` wrap identically at render time, but only `anywhere`
    // counts those break points toward MIN-CONTENT width. With the rail now user-sized
    // (AC4) rather than pinned at 340px, that difference decides whether a narrow drag
    // squeezes the block toward one glyph per line — so the safer keyword is pinned here.
    const block = rule('.llm-block');
    expect(block).toMatch(/overflow-wrap:\s*break-word/);
    expect(block).not.toMatch(/overflow-wrap:\s*anywhere/);
    // pre-wrap was always correct and must stay: JSON keeps its indentation.
    expect(block).toMatch(/white-space:\s*pre-wrap/);
  });

  it('every flex ancestor between the rail and the payload can shrink', () => {
    // A flex item defaults to `min-width: auto`, which refuses to shrink below
    // min-content — so ONE missing link in this chain can pin the rail wider than the
    // user dragged it. Each is asserted by name rather than counting, so a future
    // refactor that renames or drops one fails here.
    for (const selector of ['.rail-body', '.think-panel', '.llm-inspector', '.llm-list', '.llm-entry-body', '.llm-block']) {
      expect(rule(selector), `${selector} is missing min-width: 0`).toMatch(/min-width:\s*0/);
    }
  });
});
