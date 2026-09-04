// runHeaderIcons.test.tsx — TASK-20260817 follow-on: the run header's action cluster
// becomes ICON buttons, and the model selector swaps places with connections.
//
// Owner ask: "replace the Connections and export buttons with appropriate icon
// buttons with tooltip, and swap the position of the llm model selector with the new
// connections icon button."
//
// The hazard this file exists to catch: an icon-only button that loses its ACCESSIBLE
// NAME. The glyph is not a name — `🔌` announces as "electric plug" or as nothing at
// all. So each button keeps a real name via `aria-label`, and `title` carries the hover
// tooltip the owner asked for. Those are DIFFERENT jobs: a `title` alone is not an
// accessible name (the same rule the rail toggle already follows, and which RunView's
// own comment states).
//
// TASK-20260904-app-sharing (ADR-0063 §2): the dormant per-app `.snug` export — a
// SQLite slice named like a user file — is DELETED, and the share control takes the
// last slot of the cluster (between connections and RunView's theme toggle). The
// export claims this file carried are classified in the task journal: the
// "hidden behind ONE flag" describe and the "export .snug" name pins are OBSOLETE (the
// control and its flag no longer exist; `git show 9bd3804:…` holds them), and the
// "two icons differ" claim MIGRATED to connections vs share below. The Settings
// 'export snug file' surface still carries the load-bearing export string.
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
  syncState?: {
    progress: number;
    complete: boolean;
    needsRelink?: true;
    rosters?: { loaded: number; total: number };
    names?: number;
  };
  onManageConnections?: () => void;
  /** Absent = a preview (no share control); present = an owned app. */
  onShare?: (() => void) | undefined;
  /** Test seam: render WITHOUT onShare (the preview shape). Default: owned. */
  owned?: boolean;
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
        syncState={options.syncState}
        onManageConnections={options.onManageConnections ?? ((): void => undefined)}
        {...(options.owned === false ? {} : { onShare: options.onShare ?? ((): void => undefined) })}
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
const shareBtn = (): HTMLElement | null => byTestId('share-app');
const modelSelect = (): HTMLElement | null => byTestId('app-model-select');

/** Document order of two nodes — the ordering claim, measured rather than grepped. */
function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('the share control (TASK-20260904 AC10)', () => {
  it('renders as an icon button named "share", with a tooltip, for an owned app', async () => {
    await renderActions();
    const el = shareBtn();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('aria-label')).toBe('share');
    expect(el!.getAttribute('title')).toMatch(/never your data or keys/i);
    expect(el!.textContent ?? '').not.toMatch(/share/i);
    expect(el!.className).toContain('btn-icon');
  });

  it('fires the handler on click', async () => {
    let clicks = 0;
    await renderActions({ onShare: () => void clicks++ });
    await act(async () => {
      shareBtn()!.click();
    });
    expect(clicks).toBe(1);
  });

  it('is absent for a preview (no onShare) and for a read-only starter', async () => {
    await renderActions({ owned: false });
    expect(shareBtn()).toBeNull();
    await renderActions({ isStarter: true });
    expect(shareBtn()).toBeNull();
  });

  it('is the LAST control of the cluster — after connections (RunView places the theme toggle right after this component)', async () => {
    await renderActions();
    expect(precedes(connections()!, shareBtn()!)).toBe(true);
    expect(container!.querySelector('[data-testid="share-app"] ~ *')).toBeNull();
  });

  it('the dormant per-app export is gone — no control, no flag, no name', async () => {
    // OBSOLETE claims from TASK-20260821 ("hidden behind ONE flag", "export .snug"):
    // the SQLite-slice export was a latent replace-your-file shape (ADR-0063 §2).
    await renderActions();
    expect(byTestId('export-sqlite')).toBeNull();
    expect(container!.querySelector('[aria-label="export .snug"]')).toBeNull();
  });
});

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

  it('gives the two icons DIFFERENT glyphs, so they are not confusable (MIGRATED: connections vs share)', async () => {
    await renderActions();
    const a = (connections()!.textContent ?? '').trim();
    const b = (shareBtn()!.textContent ?? '').trim();
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

  it('keeps connections before share', async () => {
    await renderActions();
    expect(precedes(connections()!, shareBtn()!)).toBe(true);
  });
});

describe('the gates each control already had are unchanged', () => {
  it('hides connections when the app has no connection rows', async () => {
    await renderActions({ connectionSlots: 0 });
    expect(connections()).toBeNull();
    // …while the rest of the cluster still renders.
    expect(shareBtn()).not.toBeNull();
    expect(modelSelect()).not.toBeNull();
  });

  it('hides connections, the model selector and share for a read-only starter', async () => {
    // A starter has no persisted rows and no app row to key a pick to; the wizard would
    // open empty and the pick would be lost on install (which mints a new id). And a
    // preview has nothing of the user's to share.
    await renderActions({ isStarter: true, connectionSlots: 3 });
    expect(connections()).toBeNull();
    expect(modelSelect()).toBeNull();
    expect(shareBtn()).toBeNull();
  });
});

describe('the sync indicator (ADR-0037 §4, owner interview 2026-08-18)', () => {
  it('shows progress in the header while history sync is incomplete', async () => {
    await renderActions({ syncState: { progress: 42, complete: false } });
    const badge = byTestId('sidecar-sync-progress');
    expect(badge, 'the indicator renders beside the app controls').not.toBeNull();
    expect(badge?.textContent ?? '', 'and it carries the actual percent').toContain('42');
    // A glyph is not a name (this file's own rule): the indicator must announce itself.
    expect(badge?.getAttribute('aria-label') ?? '').toMatch(/sync/i);
  });

  it('disappears when sync completes, and never renders without a state', async () => {
    await renderActions({ syncState: { progress: 100, complete: true } });
    expect(byTestId('sidecar-sync-progress'), 'complete: the header returns to normal').toBeNull();
    await renderActions({});
    expect(byTestId('sidecar-sync-progress'), 'no sidecar app: no indicator').toBeNull();
  });

  it('shows the NAMES phase after history completes, while rosters are still loading', async () => {
    // The owner's ask (2026-08-18): the header should tell the truth about the second
    // phase too — name resolution rides the paced roster sweep and outlives the history
    // percent. One capsule, two phases, gone when both are done.
    await renderActions({
      syncState: { progress: 100, complete: true, rosters: { loaded: 98, total: 233 }, names: 1561 },
    });
    const badge = byTestId('sidecar-sync-progress');
    expect(badge).not.toBeNull();
    expect(badge?.textContent ?? '').toContain('98');
    expect(badge?.textContent ?? '').toContain('233');
    expect(badge?.getAttribute('aria-label') ?? '').toMatch(/name/i);
  });

  it('disappears once the rosters finish too', async () => {
    await renderActions({
      syncState: { progress: 100, complete: true, rosters: { loaded: 233, total: 233 }, names: 1561 },
    });
    expect(byTestId('sidecar-sync-progress')).toBeNull();
  });

  it('never spins over a wedged session — needsRelink hides the indicator', async () => {
    // "Syncing 0%" over a session that will never sync is a rendered lie contradicting the
    // app's own relink prompt (lessons.md 2026-08-17: name the state, don't spin over it).
    await renderActions({ syncState: { progress: 0, complete: false, needsRelink: true } });
    expect(byTestId('sidecar-sync-progress')).toBeNull();
  });

  it('RunView actually threads syncState from the pump into the header', async () => {
    // The wire, pinned at source level (a prop nobody passes is the untested wire in its
    // purest form): RunView must hold pump-reported state and hand it to this component.
    // cwd-relative rather than import.meta.url (jsdom's module URL is not file:), with a
    // root-cwd fallback so an IDE or workspace runner does not turn ENOENT into a false
    // "wire disconnected". Only the PUBLIC seam is pinned — an internal setter's name is
    // a refactor away from a spurious red.
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const candidates = ['src/run/RunView.tsx', 'apps/playground/src/run/RunView.tsx'].map((rel) =>
      resolve(process.cwd(), rel),
    );
    const path = candidates.find((candidate) => existsSync(candidate));
    expect(path, 'RunView.tsx is findable from this runner\'s cwd').toBeDefined();
    const runView = readFileSync(path!, 'utf8');
    expect(runView).toMatch(/syncState=\{/);
    expect(runView).toMatch(/startSidecarLiveForApp\(/);
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

  it('opens the share sheet on click (MIGRATED from the deleted export click)', async () => {
    let shared = 0;
    await renderActions({ onShare: () => (shared += 1) });
    await act(async () => {
      shareBtn()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(shared).toBe(1);
  });
});
