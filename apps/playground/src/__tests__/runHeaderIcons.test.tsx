// runHeaderIcons.test.tsx — TASK-20260817 follow-on: the run header's action cluster
// becomes ICON buttons, and the model selector swaps places with connections.
//
// Owner ask: "replace the Connections and export .sqlite buttons with appropriate icon
// buttons with tooltip, and swap the position of the llm model selector with the new
// connections icon button."
//
// The hazard this file exists to catch: an icon-only button that loses its ACCESSIBLE
// NAME. The glyph is not a name — `🔌` announces as "electric plug" or as nothing at
// all, and two existing e2e specs already locate the export control by the accessible
// name 'export .sqlite' (`e2e/starters.spec.ts`). So each button keeps a real name via
// `aria-label`, and `title` carries the hover tooltip the owner asked for. Those are
// DIFFERENT jobs: a `title` alone is not an accessible name (the same rule the rail
// toggle already follows, and which RunView's own comment states).
//
// Assertions here are made against the RENDERED DOM, not the source text, so a button
// that exists in the file but never reaches the screen still reds.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunHeaderActions } from '../run/RunHeaderActions.js';
import { appModelStore } from '../state/appModel.js';
import { modeStore, modelStore, providerStore } from '../state/mode.js';
import { ollamaStore } from '../state/ollama.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-header-icons';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  appModelStore.set({});
  modelStore.set(undefined);
  modeStore.set('byok');
  providerStore.set('anthropic');
  ollamaStore.set('unknown');
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  await installTestUserDb();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

interface RenderOptions {
  appId?: string;
  isStarter?: boolean;
  connectionSlots?: number;
  canExport?: boolean;
  onManageConnections?: () => void;
  onExport?: () => void;
}

async function renderActions(options: RenderOptions = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RunHeaderActions
        appId={options.appId ?? APP}
        isStarter={options.isStarter ?? false}
        connectionSlots={options.connectionSlots ?? 1}
        canExport={options.canExport ?? true}
        onManageConnections={options.onManageConnections ?? ((): void => undefined)}
        onExport={options.onExport ?? ((): void => undefined)}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const byTestId = (id: string): HTMLElement | null =>
  (container?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null) ?? null;

const connections = (): HTMLElement | null => byTestId('manage-connections');
const exportBtn = (): HTMLElement | null => byTestId('export-sqlite');
const modelSelect = (): HTMLElement | null => byTestId('app-model-select');

/** Document order of two nodes — the ordering claim, measured rather than grepped. */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('icon buttons keep an accessible name and gain a tooltip', () => {
  it('renders connections as an icon button with a name and a tooltip', async () => {
    await renderActions();
    const el = connections();
    expect(el).not.toBeNull();
    // The NAME is what a screen reader announces and what a test/e2e locator finds.
    expect(el!.getAttribute('aria-label')).toMatch(/connection/i);
    // The TOOLTIP is the hover affordance the owner asked for — a separate attribute,
    // because a title alone would leave the control unnamed.
    expect(el!.getAttribute('title')).toBeTruthy();
    // Icon-only: the visible text is the glyph, not a word.
    expect(el!.textContent ?? '').not.toMatch(/connections/i);
  });

  it('renders export as an icon button with a name and a tooltip', async () => {
    await renderActions();
    const el = exportBtn();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('aria-label')).toMatch(/\.sqlite/i);
    expect(el!.getAttribute('title')).toBeTruthy();
    expect(el!.textContent ?? '').not.toMatch(/export/i);
  });

  it('keeps `export .sqlite` as the export button’s accessible name', async () => {
    // Load-bearing: `e2e/starters.spec.ts` locates this control by
    // getByRole('button', { name: 'export .sqlite' }) in two specs. Dropping the word
    // to a glyph without keeping the name would break those silently in a lane CI does
    // not yet run — exactly the kind of break that surfaces as a mystery later.
    await renderActions();
    expect(exportBtn()!.getAttribute('aria-label')).toBe('export .sqlite');
  });

  it('gives the two icons DIFFERENT glyphs, so they are not confusable', async () => {
    await renderActions();
    const a = (connections()!.textContent ?? '').trim();
    const b = (exportBtn()!.textContent ?? '').trim();
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
  });
});

describe('the model selector and connections swap places', () => {
  it('puts the model selector BEFORE the connections button', async () => {
    // The owner's swap. Asserted as document order of the rendered nodes rather than as
    // source-string indices: a JSX reorder that a bundler or conditional wrapper
    // reshuffles would still be caught here.
    await renderActions();
    const select = modelSelect();
    const conn = connections();
    expect(select).not.toBeNull();
    expect(conn).not.toBeNull();
    expect(precedes(select!, conn!)).toBe(true);
  });

  it('keeps connections before export', async () => {
    await renderActions();
    expect(precedes(connections()!, exportBtn()!)).toBe(true);
  });
});

describe('the gates each control already had are unchanged', () => {
  it('hides connections when the app has no connection rows', async () => {
    await renderActions({ connectionSlots: 0 });
    expect(connections()).toBeNull();
    // …while the rest of the cluster still renders.
    expect(exportBtn()).not.toBeNull();
  });

  it('hides export until the app has touched its database', async () => {
    await renderActions({ canExport: false });
    expect(exportBtn()).toBeNull();
    expect(connections()).not.toBeNull();
  });

  it('hides connections and the model selector for a read-only starter', async () => {
    // A starter has no persisted rows and no app row to key a pick to; the wizard would
    // open empty and the pick would be lost on install (which mints a new id).
    await renderActions({ isStarter: true, connectionSlots: 3 });
    expect(connections()).toBeNull();
    expect(modelSelect()).toBeNull();
    // Export still belongs to a starter being tried out — it writes real rows.
    expect(exportBtn()).not.toBeNull();
  });
});

describe('the buttons still do their jobs', () => {
  it('opens the connection wizard on click', async () => {
    let opened = 0;
    await renderActions({ onManageConnections: () => (opened += 1) });
    await act(async () => {
      connections()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toBe(1);
  });

  it('exports on click', async () => {
    let exported = 0;
    await renderActions({ onExport: () => (exported += 1) });
    await act(async () => {
      exportBtn()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(exported).toBe(1);
  });
});
