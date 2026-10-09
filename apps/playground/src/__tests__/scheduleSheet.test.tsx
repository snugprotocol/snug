// scheduleSheet.test.tsx — TASK-20261009-scheduling-framework U5 (design F3): the run header's
// SMALL sheet for one app. Two paths out: `more options` opens the full editor prefilled with the
// sentence and the app (`/schedule/new?text=…&app=<id>`); `schedule it` writes through the engine's
// own `createTask` right here — at once for a reminder, behind the consent panel (U8) when the step
// asks the app's AI — and then says when it next runs. A sentence with no readable time is said so,
// and the write is withheld.
//
// The words beside the schedule are the EDITOR's rule (`editorModel.remainderOf` over the one
// `readSchedule` phrase), so the sheet and the create bar title the same sentence the same way.
//
// Through `ConfirmOverlay`, which PORTALS to <body>, so queries go through the document. A routed
// mount, because the sheet navigates; the real memory user db, because the write is real.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { CONSENT } from '../schedule/copy.js';
import { ACTIONS, SENTENCE } from '../schedule/copy.editor.js';
import { remainderOf } from '../schedule/editorModel.js';
import { readSchedule } from '../schedule/parseScheduleText.js';
import { newScheduleHref } from '../schedule/routes.js';
import { ScheduleSheet } from '../schedule/ScheduleSheet.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-09T12:20:00.000Z');

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let db: UserDb;
let appId: string;
let closes = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  closes = 0;
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>Ledger</title>', usesDb: true }).appId;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
});

function Probe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="editor-probe">{`${location.pathname}${location.search}`}</div>;
}

const q = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const must = (testId: string): HTMLElement => {
  const el = q(testId);
  if (el === null) throw new Error(`missing [data-testid="${testId}"]`);
  return el;
};

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${appId}`]}>
        <Routes>
          <Route path="/run/:id" element={<ScheduleSheet appId={appId} onClose={() => void closes++} />} />
          <Route path="/schedule/new" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settleUntil(() => q('schedule-sheet')?.textContent?.includes('schedule Ledger') === true, 'the sheet to name the app');
}

async function type(el: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

describe('the sheet', () => {
  it('is a dialog named for the app with the sentence box, the two step kinds for THIS app, and the two acts', async () => {
    await mount();
    const sheet = must('schedule-sheet');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-label')).toBe('schedule Ledger');
    expect(q('sheet-text')).not.toBeNull();
    expect(sheet.textContent).toContain('ask Ledger’s AI');
    expect(sheet.textContent).toContain('remind me');
    expect(must('sheet-schedule-it').textContent).toBe(CONSENT.enable);
    expect(must('sheet-more-options').textContent).toBe(ACTIONS.moreOptions);
    expect((must('sheet-schedule-it') as HTMLButtonElement).disabled, 'nothing to schedule yet').toBe(true);
  });

  it('a sentence with no readable time is said so and the write is withheld', async () => {
    await mount();
    await type(must('sheet-text'), 'look at the numbers');
    expect(must('sheet-text-note').textContent).toBe(SENTENCE.cannotReadSheet);
    expect((must('sheet-schedule-it') as HTMLButtonElement).disabled).toBe(true);
    await type(must('sheet-prompt'), 'anything');
    expect((must('sheet-schedule-it') as HTMLButtonElement).disabled).toBe(true);
  });

  it('more options opens the editor prefilled with the sentence and the app, and closes the sheet', async () => {
    await mount();
    await type(must('sheet-text'), 'every weekday at 8');
    await click(must('sheet-more-options'));
    await settleUntil(() => q('editor-probe') !== null, 'the editor route');
    expect(must('editor-probe').textContent).toBe(`/schedule/new?text=every+weekday+at+8&app=${encodeURIComponent(appId)}`);
    expect(must('editor-probe').textContent).toBe(newScheduleHref({ text: 'every weekday at 8', app: appId }));
    expect(closes).toBe(1);
  });

  it('remind me: schedule it writes a reminder at once — the words beside the schedule, minus the intent, as the title and the message — and says when it next runs', async () => {
    await mount();
    await type(must('sheet-text'), 'remind me to stretch every weekday at 8');
    expect(must('sheet-text-note').textContent).toBe('Weekdays at 8:00 AM');
    await click(must('sheet-kind-remind'));
    await click(must('sheet-schedule-it'));
    await settleUntil(() => q('sheet-done') !== null, 'the scheduled line');
    expect(q('enable-consent')).toBeNull();
    const saved = db.listScheduledTasks();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.title).toBe('stretch');
    expect(saved[0]?.steps).toEqual([{ kind: 'notify', title: 'stretch', body: 'stretch' }]);
    expect(saved[0]?.spec).toEqual({ kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' });
    expect(saved[0]?.provenance).toBe('user');
    expect(saved[0]?.enabled).toBe(true);
    expect(must('sheet-done').textContent).toMatch(/^scheduled — next /);
  });

  it('the words beside the schedule are the editor’s rule (M6): spelled as typed, edges trimmed — and the app’s name when nothing is left', async () => {
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['Every weekday at 8 — Stretch!', 'Stretch', 'Stretch'],
      ['please water the ferns tomorrow at 9', 'water the ferns', 'water the ferns'],
      ['at 5pm', 'Ledger', 'open Ledger'],
    ];
    for (const [sentence, title, body] of rows) {
      const reading = readSchedule(sentence, NOW, 'device');
      expect(reading, sentence).toBeDefined();
      const words = remainderOf(sentence, reading?.phrase ?? '');
      expect(words).toBe(title === 'Ledger' ? '' : title);
      await mount();
      await type(must('sheet-text'), sentence);
      await click(must('sheet-kind-remind'));
      await click(must('sheet-schedule-it'));
      await settleUntil(() => q('sheet-done') !== null, `the scheduled line for ${sentence}`);
      const saved = db.listScheduledTasks().at(-1);
      expect(saved?.title, sentence).toBe(title);
      expect(saved?.steps, sentence).toEqual([{ kind: 'notify', title, body }]);
      await act(async () => {
        root?.unmount();
      });
      container?.remove();
      container = undefined;
      root = undefined;
    }
  });

  it('ask the AI: the words beside the schedule title the ask', async () => {
    await mount();
    await type(must('sheet-text'), 'summarise my week every friday at 5pm');
    await type(must('sheet-prompt'), 'How did the week go?');
    await click(must('sheet-schedule-it'));
    await click(must('consent-enable'));
    await settleUntil(() => q('sheet-done') !== null, 'the scheduled line');
    expect(db.listScheduledTasks()[0]?.title).toBe('summarise my week');
  });

  it('ask the AI: schedule it lands on the consent panel with the prompt verbatim; schedule it there writes the ask-the-AI step', async () => {
    await mount();
    await type(must('sheet-text'), 'every friday at 5pm');
    await type(must('sheet-prompt'), 'How did I spend this week, by category?');
    await click(must('sheet-schedule-it'));
    const consent = must('enable-consent');
    expect(consent.textContent).toContain('ask Ledger’s AI');
    expect(must('consent-prompt-0').textContent).toBe('How did I spend this week, by category?');
    expect(must('consent-tables-0').textContent).toBe('the AI reads Ledger’s tables — no queries');
    expect(db.listScheduledTasks(), 'nothing written before the consent act').toHaveLength(0);
    await click(must('consent-enable'));
    await settleUntil(() => q('sheet-done') !== null, 'the scheduled line');
    const saved = db.listScheduledTasks();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.steps).toEqual([{ kind: 'app-think', appId, prompt: 'How did I spend this week, by category?', context: { maxRows: 50 } }]);
    expect(saved[0]?.spec).toEqual({ kind: 'weekly', days: ['fri'], time: '17:00', tz: 'device' });
    expect(saved[0]?.title).toBe('ask Ledger’s AI');
    expect(saved[0]?.missedPolicy, 'cost-derived (Q12): an ask-the-AI schedule asks').toBe('ask');
  });

  it('not now on the consent returns to the sheet with nothing written', async () => {
    await mount();
    await type(must('sheet-text'), 'every friday at 5pm');
    await type(must('sheet-prompt'), 'anything');
    await click(must('sheet-schedule-it'));
    await click(must('consent-not-now'));
    expect(q('enable-consent')).toBeNull();
    expect(q('sheet-schedule-it')).not.toBeNull();
    expect(db.listScheduledTasks()).toHaveLength(0);
  });
});
