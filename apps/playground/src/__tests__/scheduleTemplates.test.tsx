// scheduleTemplates.test.tsx — TASK-20261009-scheduling-framework U2 (design F11): the four
// templates, ALWAYS rendered. Each compiles and parses by the protocol's own schemas; a
// template whose starters are installed opens the prefilled editor route, one whose starter
// is missing says "add <App>, then schedule it" and links to that starter's run route; the
// template that fits leads; "nudge me" needs no app and is always usable — but never makes
// the hub section appear on its own.
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { scheduleSpecSchema, scheduleStepSchema } from '@snugprotocol/protocol';

import { TEMPLATES } from '../schedule/copy.page.js';
import { compileSpec } from '../schedule/cron.js';
import {
  SCHEDULE_TEMPLATES,
  Templates,
  missingApps,
  orderedTemplates,
  starterRunHref,
  templateAppName,
  templateById,
  templateDraft,
  templateFits,
  templateHref,
  templateUsable,
} from '../schedule/Templates.js';
import { mount, texts, unmount } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => unmount());

const NONE: ReadonlyMap<string, string> = new Map();
const LEDGER: ReadonlyMap<string, string> = new Map([['starter:ledger', 'app-ledger']]);
const LEDGER_GITHUB: ReadonlyMap<string, string> = new Map([
  ['starter:ledger', 'app-ledger'],
  ['starter:github', 'app-github'],
]);

function render(installed: ReadonlyMap<string, string>): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <Templates installedBySource={installed} />
    </MemoryRouter>,
  );
}

const cards = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[data-testid="schedule-template"]')];
const actOf = (card: HTMLElement): HTMLAnchorElement | null => card.querySelector<HTMLAnchorElement>('.schedule-template-act');

describe('the registry', () => {
  it('is the four templates, in this order, each over the starters it needs', () => {
    expect(SCHEDULE_TEMPLATES.map((t) => [t.id, t.title, [...t.apps]])).toEqual([
      ['nudge', 'nudge me', []],
      ['weekly-spend', 'weekly spend review', ['ledger']],
      ['friday-review', 'friday review', ['ledger', 'github']],
      ['morning-weather', 'morning weather', ['weather']],
    ]);
    expect(templateById('friday-review')?.title).toBe('friday review');
    expect(templateById('nope')).toBeUndefined();
    expect(templateById(null)).toBeUndefined();
  });

  it('every spec compiles and parses; every step parses by the protocol schema with the resolved app ids', () => {
    const resolve = (folder: string): string => `app-${folder}`;
    for (const template of SCHEDULE_TEMPLATES) {
      expect(scheduleSpecSchema.safeParse(template.spec).success, `${template.id} spec`).toBe(true);
      expect(compileSpec(template.spec, new Date('2026-10-09T12:05:00.000Z')), `${template.id} compiles`).toBeDefined();
      const steps = template.steps(resolve);
      expect(steps.length, `${template.id} has steps`).toBeGreaterThan(0);
      expect(steps.length).toBeLessThanOrEqual(5);
      for (const step of steps) expect(scheduleStepSchema.safeParse(step).success, `${template.id} step ${step.kind}`).toBe(true);
    }
    expect(templateById('nudge')?.steps(resolve).map((s) => s.kind)).toEqual(['notify']);
    expect(templateById('weekly-spend')?.steps(resolve).map((s) => s.kind)).toEqual(['app-think']);
    expect(templateById('friday-review')?.steps(resolve).map((s) => s.kind)).toEqual(['app-think', 'app-think']);
    expect(templateById('morning-weather')?.steps(resolve).map((s) => s.kind)).toEqual(['app-run', 'notify']);
  });

  it('usable = every app installed (vacuous for nudge); fits = usable AND about an app', () => {
    const nudge = templateById('nudge')!;
    const spend = templateById('weekly-spend')!;
    const friday = templateById('friday-review')!;
    expect(templateUsable(nudge, NONE)).toBe(true);
    expect(templateFits(nudge, LEDGER_GITHUB), 'nudge never makes the hub section appear').toBe(false);
    expect(templateUsable(spend, NONE)).toBe(false);
    expect(templateUsable(spend, LEDGER)).toBe(true);
    expect(templateFits(spend, LEDGER)).toBe(true);
    expect(missingApps(friday, LEDGER)).toEqual(['github']);
    expect(templateFits(friday, LEDGER)).toBe(false);
    expect(templateFits(friday, LEDGER_GITHUB)).toBe(true);
    expect(orderedTemplates(LEDGER).map((t) => t.id)).toEqual(['weekly-spend', 'nudge', 'friday-review', 'morning-weather']);
    expect(orderedTemplates(NONE).map((t) => t.id)).toEqual(['nudge', 'weekly-spend', 'friday-review', 'morning-weather']);
  });

  it('templateDraft prefills the editor over the installed ids, and refuses when an app is missing', () => {
    const friday = templateById('friday-review')!;
    expect(templateDraft(friday, LEDGER)).toBeUndefined();
    const draft = templateDraft(friday, LEDGER_GITHUB);
    expect(draft?.title).toBe('friday review');
    expect(draft?.spec).toEqual(friday.spec);
    expect(draft?.steps.map((s) => (s.kind === 'notify' ? undefined : s.appId))).toEqual(['app-ledger', 'app-github']);
    expect(templateAppName('ledger')).toBe('Ledger');
    expect(templateAppName('weather')).toBe('Should I?');
    expect(templateAppName('github')).toBe('Standup');
  });
});

describe('the cards (always rendered)', () => {
  it('nothing installed: all four, nudge usable, the rest say "add <App>, then schedule it" and link to the starter', () => {
    const c = render(NONE);
    expect(c.querySelector('.section-title')?.textContent).toBe(TEMPLATES.heading);
    const all = cards(c);
    expect(all.map((card) => card.dataset.template)).toEqual(['nudge', 'weekly-spend', 'friday-review', 'morning-weather']);
    expect(all.map((card) => card.dataset.usable)).toEqual(['true', 'false', 'false', 'false']);
    expect(texts(c, '.schedule-template-title')).toEqual(['nudge me', 'weekly spend review', 'friday review', 'morning weather']);
    expect(actOf(all[0]!)?.textContent).toBe(TEMPLATES.use);
    expect(actOf(all[0]!)?.getAttribute('href')).toBe(templateHref('nudge'));
    expect(actOf(all[1]!)?.textContent).toBe(TEMPLATES.addThen('Ledger'));
    expect(actOf(all[1]!)?.getAttribute('href')).toBe(starterRunHref('ledger'));
    expect(actOf(all[2]!)?.textContent).toBe('add Ledger, then schedule it');
    expect(actOf(all[3]!)?.textContent).toBe('add Should I?, then schedule it');
    expect(actOf(all[3]!)?.getAttribute('href')).toBe('/run/starter--weather');
    expect(texts(c, '.schedule-template-when')[0]).toBe('Every day at 9:00 AM');
  });

  it('Ledger installed: the spend review leads with "use this"; friday review still asks for Standup', () => {
    const c = render(LEDGER);
    const all = cards(c);
    expect(all.map((card) => card.dataset.template)).toEqual(['weekly-spend', 'nudge', 'friday-review', 'morning-weather']);
    expect(actOf(all[0]!)?.textContent).toBe(TEMPLATES.use);
    expect(actOf(all[0]!)?.getAttribute('href')).toBe('/schedule/new?template=weekly-spend');
    expect(actOf(all[2]!)?.textContent).toBe('add Standup, then schedule it');
    expect(actOf(all[2]!)?.getAttribute('href')).toBe('/run/starter--github');
  });

  it('Ledger and Standup installed: both ledger templates lead, in registry order', () => {
    const c = render(LEDGER_GITHUB);
    expect(cards(c).map((card) => card.dataset.template)).toEqual(['weekly-spend', 'friday-review', 'nudge', 'morning-weather']);
    expect(cards(c).map((card) => card.dataset.usable)).toEqual(['true', 'true', 'true', 'false']);
  });
});
