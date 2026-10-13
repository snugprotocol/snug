// railChatComposer.test.tsx — TASK-20261013-rail-chat-access (AC5).
//
// THE OWNER'S BUG: the chat beside every app took one message and then showed no input. The
// composer was never unmounted — RailChat overrode the shared sticky `.composer` with an inline
// `position: static`, at the end of a `minHeight: 100%` column whose ChatLog is `flex: 1`. Once a
// conversation existed the column filled the rail body and the composer sat after it, below the
// fold by the height of the tab row and the thread picker above it (measured: top 1369 px, the
// rail body's visible bottom ≈ 1319 px). The empty state does not grow — why the FIRST message
// still had an input.
//
// jsdom has no layout, so this pins the two causes; e2e/rail-chat.spec.ts proves the geometry.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import { modeStore, providerStore } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface RailChatTestProps {
  appId: string;
  threadId: string;
  messages: never[];
  steps: never[];
  activity: string | undefined;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
}
const RUN_VIEW = '../run/RunView.js';

let db: UserDb;
let appId: string;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  modeStore.set('local');
  providerStore.set('mock');
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.now() });
  appId = db.installApp({ displayName: 'Standup', html: '<html>standup</html>', usesDb: true }).appId;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  modeStore.set('byok');
  resetAccessSession();
  __setAccessDepsForTests();
});

async function renderRail(): Promise<HTMLDivElement> {
  const { RailChat } = (await import(/* @vite-ignore */ RUN_VIEW)) as { RailChat: (props: RailChatTestProps) => ReactElement };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RailChat appId={appId} threadId={`app:${appId}`} messages={[]} steps={[]} activity={undefined} busy={false} onSend={() => undefined} onStop={() => undefined} />);
  });
  return container;
}

describe('AC5 — the rail’s composer stays on screen', () => {
  it('the chat column is `.rail-chat`, and the rail body lays it out as a column that fills the rail (the composer at the bottom of a short chat)', async () => {
    const el = await renderRail();
    expect(el.querySelector('.rail-chat'), 'RailChat’s root is .rail-chat').not.toBeNull();
    const css = readFileSync(path.resolve(__dirname, '../theme/app.css'), 'utf8');
    expect(css).toMatch(/\.rail-body:has\(> \.rail-chat\)\s*\{[^}]*flex-direction:\s*column/);
    expect(/\.rail-chat\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/flex:\s*1/);
  });

  it('at phone width the think view is not its own scroll box, so the composer sticks to the viewport', () => {
    const css = readFileSync(path.resolve(__dirname, '../theme/app.css'), 'utf8');
    // AFTER the ≤1000px block that makes it a scroll box — same specificity, so the later rule wins.
    const after = css.slice(css.indexOf('@media (max-width: 1000px)'));
    expect(after).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.mobile-think\s*\{[^}]*overflow-y:\s*visible/);
  });

  it('the composer is the rail’s own sticky composer — never an inline `position: static`', async () => {
    const el = await renderRail();
    const composer = el.querySelector<HTMLElement>('.composer');
    expect(composer, 'the composer renders').not.toBeNull();
    expect(composer!.classList.contains('rail-composer')).toBe(true);
    expect(composer!.style.position, 'no inline position override').toBe('');
  });

  it('the rail column does not claim the rail body’s full height beneath the tabs and the thread picker', () => {
    const source = readFileSync(path.resolve(__dirname, '../run/RunView.tsx'), 'utf8');
    const rail = source.slice(source.indexOf('export function RailChat('));
    expect(rail.slice(0, rail.indexOf('<ChatLog'))).not.toContain("minHeight: '100%'");
  });

  it('`.rail-composer` sticks to the rail body’s bottom on the rail’s own surface', () => {
    const css = readFileSync(path.resolve(__dirname, '../theme/app.css'), 'utf8');
    const rule = /\.rail-composer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*sticky/);
    expect(rule).toMatch(/bottom:\s*0/);
    expect(rule).toMatch(/var\(--surface\)/);
  });
});
