// scheduleTemplates.test.tsx — TASK-20261009-scheduling-framework U2 (design F11): the four
// templates, ALWAYS rendered, from ONE registry. A card is rendered from the same
// `templateFill` the editor opens with, so this file follows each card's href into
// `initialDraft` and proves the title, the when and the step kinds the card promises are the
// ones the editor shows. A template whose starters are installed opens the prefilled editor
// route; one whose starter is missing says "add <App>, then schedule it" and links to that
// starter's run route; the template that fits leads; "nudge me" needs no app and is always
// usable — but never makes the hub section appear on its own.
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { scheduleSpecSchema, scheduleStepSchema } from '@snugprotocol/protocol';

import { TEMPLATES } from '../schedule/copy.page.js';
import { STEPS } from '../schedule/copy.editor.js';
import { compileSpec, describeSpec } from '../schedule/cron.js';
import { TEMPLATE_NAMES, initialDraft, prepareSteps, templateFill } from '../schedule/editorModel.js';
import { newScheduleHref } from '../schedule/routes.js';
import { Templates, starterRunHref, templateAppName, templateCandidates, templateCard, templateCards } from '../schedule/Templates.js';
import { mount, texts, unmount } from './scheduleUiHarness.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => unmount());

const NOW = new Date('2026-10-09T12:05:00.000Z');
const NONE: ReadonlyMap<string, string> = new Map();
const LEDGER: ReadonlyMap<string, string> = new Map([['starter:ledger', 'app-ledger']]);
const LEDGER_GITHUB: ReadonlyMap<string, string> = new Map([
  ['starter:ledger', 'app-ledger'],
  ['starter:github', 'app-github'],
]);
const ALL: ReadonlyMap<string, string> = new Map([...LEDGER_GITHUB, ['starter:weather', 'app-weather']]);

function render(installed: ReadonlyMap<string, string>): HTMLDivElement {
  return mount(
    <MemoryRouter>
      <Templates installedBySource={installed} />
    </MemoryRouter>,
  );
}

const cards = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[data-testid="schedule-template"]')];
const actOf = (card: HTMLElement): HTMLAnchorElement | null => card.querySelector<HTMLAnchorElement>('.schedule-template-act');

describe('the registry (one: editorModel.templateFill)', () => {
  it('is the four templates, in this order, each over the starters its steps name', () => {
    expect(templateCards(NONE).map((card) => [card.name, card.title, card.apps.map((app) => app.folder)])).toEqual([
      ['nudge', 'nudge me', []],
      ['spend-review', 'weekly spend review', ['ledger']],
      ['friday-review', 'friday review', ['ledger', 'github']],
      ['morning-weather', 'morning weather', ['weather']],
    ]);
    expect(templateCards(NONE).map((card) => card.name)).toEqual([...TEMPLATE_NAMES]);
  });

  it('every spec compiles and parses; every usable template’s steps prepare into protocol steps — and the run-an-app one is refused until PR-B', () => {
    const candidates = templateCandidates(ALL);
    for (const name of TEMPLATE_NAMES) {
      const fill = templateFill(name, candidates);
      expect(scheduleSpecSchema.safeParse(fill.spec).success, `${name} spec`).toBe(true);
      expect(compileSpec(fill.spec, NOW), `${name} compiles`).toBeDefined();
      expect(fill.missing, `${name} has every starter`).toEqual([]);
      const prepared = prepareSteps(fill.steps);
      if (name === 'morning-weather') {
        expect(prepared).toEqual({ ok: false, reason: STEPS.laterReleaseRefusal });
        continue;
      }
      expect(prepared.ok, `${name} prepares`).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.steps.length).toBeGreaterThan(0);
      for (const step of prepared.steps) expect(scheduleStepSchema.safeParse(step).success, `${name} step ${step.kind}`).toBe(true);
    }
    expect(templateCard('nudge', ALL).stepKinds).toEqual(['notify']);
    expect(templateCard('spend-review', ALL).stepKinds).toEqual(['app-think']);
    expect(templateCard('friday-review', ALL).stepKinds).toEqual(['app-think', 'app-think']);
    expect(templateCard('morning-weather', ALL).stepKinds).toEqual(['app-run', 'notify']);
  });

  it('usable = every app installed (vacuous for nudge); fits = usable AND about an app; missing names the starters not in the file', () => {
    expect(templateCard('nudge', NONE).usable).toBe(true);
    expect(templateCard('nudge', LEDGER_GITHUB).fits, 'nudge never makes the hub section appear').toBe(false);
    expect(templateCard('spend-review', NONE).usable).toBe(false);
    expect(templateCard('spend-review', LEDGER).usable).toBe(true);
    expect(templateCard('spend-review', LEDGER).fits).toBe(true);
    expect(templateCard('friday-review', LEDGER).missing.map((app) => [app.folder, app.name])).toEqual([['github', 'Standup']]);
    expect(templateCard('friday-review', LEDGER).fits).toBe(false);
    expect(templateCard('friday-review', LEDGER_GITHUB).fits).toBe(true);
    expect(templateCards(LEDGER).map((card) => card.name)).toEqual(['spend-review', 'nudge', 'friday-review', 'morning-weather']);
    expect(templateCards(NONE).map((card) => card.name)).toEqual(['nudge', 'spend-review', 'friday-review', 'morning-weather']);
  });

  it('a starter’s name is the shelf’s, on the card and in the step note alike', () => {
    expect(templateAppName('ledger')).toBe('Ledger');
    expect(templateAppName('weather')).toBe('Should I?');
    expect(templateAppName('github')).toBe('Standup');
    const [first] = templateFill('morning-weather', []).steps;
    expect(first?.kind === 'app-run' ? first.missingApp : undefined).toBe('Should I?');
  });

  it('each card’s href opens the editor on the SAME title, when and step kinds the card shows (M1: one registry)', () => {
    for (const installed of [ALL, NONE]) {
      for (const card of templateCards(installed)) {
        const template = new URL(card.href, 'http://x').searchParams.get('template');
        expect(card.href).toBe(newScheduleHref({ template: card.name }));
        const { draft, parseFailed } = initialDraft({ template, apps: templateCandidates(installed), now: NOW });
        expect(parseFailed).toBe(false);
        expect(draft.title, card.name).toBe(card.title);
        expect(describeSpec(draft.spec), card.name).toBe(card.when);
        expect(draft.spec).toEqual(templateFill(card.name, templateCandidates(installed)).spec);
        expect(draft.steps.map((step) => step.kind), card.name).toEqual(card.stepKinds);
        // A starter the card says is missing is the step the editor opens disabled, by the same name.
        const missingOnSteps = draft.steps.flatMap((step) => (step.kind !== 'notify' && step.missingApp !== undefined ? [step.missingApp] : []));
        expect(missingOnSteps).toEqual(card.missing.map((app) => app.name));
      }
    }
  });
});

describe('the cards (always rendered)', () => {
  it('nothing installed: all four, nudge usable with the fill’s own when, the rest say "add <App>, then schedule it" and link to the starter', () => {
    const c = render(NONE);
    expect(c.querySelector('.section-title')?.textContent).toBe(TEMPLATES.heading);
    const all = cards(c);
    expect(all.map((card) => card.dataset.template)).toEqual(['nudge', 'spend-review', 'friday-review', 'morning-weather']);
    expect(all.map((card) => card.dataset.usable)).toEqual(['true', 'false', 'false', 'false']);
    expect(texts(c, '.schedule-template-title')).toEqual(['nudge me', 'weekly spend review', 'friday review', 'morning weather']);
    expect(actOf(all[0]!)?.textContent).toBe(TEMPLATES.use);
    expect(actOf(all[0]!)?.getAttribute('href')).toBe('/schedule/new?template=nudge');
    expect(actOf(all[1]!)?.textContent).toBe(TEMPLATES.addThen('Ledger'));
    expect(actOf(all[1]!)?.getAttribute('href')).toBe(starterRunHref('ledger'));
    expect(actOf(all[2]!)?.textContent).toBe('add Ledger, then schedule it');
    expect(actOf(all[3]!)?.textContent).toBe('add Should I?, then schedule it');
    expect(actOf(all[3]!)?.getAttribute('href')).toBe('/run/starter--weather');
    expect(texts(c, '.schedule-template-when')).toEqual(TEMPLATE_NAMES.map((name) => describeSpec(templateFill(name, []).spec)));
    expect(texts(c, '.schedule-template-when')[0]).toBe('Every day at 8:00 PM');
    expect(texts(c, '.schedule-template-blurb')).toEqual(TEMPLATE_NAMES.map((name) => TEMPLATES.blurb[name]));
  });

  it('Ledger installed: the spend review leads with "use this"; friday review still asks for Standup', () => {
    const c = render(LEDGER);
    const all = cards(c);
    expect(all.map((card) => card.dataset.template)).toEqual(['spend-review', 'nudge', 'friday-review', 'morning-weather']);
    expect(actOf(all[0]!)?.textContent).toBe(TEMPLATES.use);
    expect(actOf(all[0]!)?.getAttribute('href')).toBe('/schedule/new?template=spend-review');
    expect(actOf(all[2]!)?.textContent).toBe('add Standup, then schedule it');
    expect(actOf(all[2]!)?.getAttribute('href')).toBe('/run/starter--github');
  });

  it('Ledger and Standup installed: both ledger templates lead, in registry order', () => {
    const c = render(LEDGER_GITHUB);
    expect(cards(c).map((card) => card.dataset.template)).toEqual(['spend-review', 'friday-review', 'nudge', 'morning-weather']);
    expect(cards(c).map((card) => card.dataset.usable)).toEqual(['true', 'true', 'true', 'false']);
  });
});
