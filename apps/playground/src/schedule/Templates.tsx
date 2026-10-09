// schedule/Templates.tsx — the four templates and the cards that offer them
// (TASK-20261009-scheduling-framework U2; design F11: templates ALWAYS rendered).
//
// A template is a title, a when and the steps it would run, keyed to the STARTER FOLDERS its
// steps need. Whether the user has those starters is read the hub's way — `installSource`
// `starter:<folder>` on the library entry — so a template whose app is installed opens the
// editor prefilled (`/schedule/new?template=<id>`; the editor reads `templateById` and
// `templateDraft` from here), and one whose app is missing says "add Weather, then schedule
// it" and links to that starter's run route, where install is an explicit act. The card
// order leads with what fits: a person who installed Ledger sees the spend review first.
//
// "nudge me" needs no app at all; it is always usable — but it never makes the HUB section
// appear on its own (`templateFits`), or every first-time user would see a schedule section
// before they have a single app.

import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { SCHEDULE_CONTEXT_DEFAULT_ROWS, type ScheduleSpec, type ScheduleStep } from '@snugprotocol/protocol';

import { starterLook } from '../starter/starterLooks.js';
import { Card } from '../ui/Card.js';
import { TEMPLATES } from './copy.page.js';
import { describeSpec } from './cron.js';

export interface ScheduleTemplate {
  id: string;
  title: string;
  blurb: string;
  /** The starter folders the steps name, in step order; empty for a reminder-only template. */
  apps: readonly string[];
  /** The glyph for a template with no app. */
  glyph?: string;
  spec: ScheduleSpec;
  /** The steps, given each folder's installed app id. */
  steps: (appIdOf: (folder: string) => string) => ScheduleStep[];
}

const DEVICE = 'device' as const;

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: 'nudge',
    title: 'nudge me',
    blurb: 'a reminder in Snug every morning — change the words and the time to taste',
    apps: [],
    glyph: '🔔',
    spec: { kind: 'daily', time: '09:00', tz: DEVICE },
    steps: () => [{ kind: 'notify', title: 'nudge', body: 'time to check in — open the app you keep meaning to open' }],
  },
  {
    id: 'weekly-spend',
    title: 'weekly spend review',
    blurb: 'every Sunday evening, Ledger’s AI sums the week by category and flags what looks off',
    apps: ['ledger'],
    spec: { kind: 'weekly', days: ['sun'], time: '18:00', tz: DEVICE },
    steps: (appIdOf) => [
      {
        kind: 'app-think',
        appId: appIdOf('ledger'),
        prompt: 'Summarise what I spent this week by category, call out anything unusual, and compare it with the week before.',
        context: { maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS },
      },
    ],
  },
  {
    id: 'friday-review',
    title: 'friday review',
    blurb: 'Friday afternoon: Ledger on the money and Standup on the work — two short briefings, one result',
    apps: ['ledger', 'github'],
    spec: { kind: 'weekly', days: ['fri'], time: '16:00', tz: DEVICE },
    steps: (appIdOf) => [
      {
        kind: 'app-think',
        appId: appIdOf('ledger'),
        prompt: 'Review this week’s money: what came in, what went out, and what needs attention next week.',
        context: { maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS },
      },
      {
        kind: 'app-think',
        appId: appIdOf('github'),
        prompt: 'What did I ship this week, and what is still waiting on me?',
        context: { maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS },
      },
    ],
  },
  {
    id: 'morning-weather',
    title: 'morning weather',
    blurb: 'weekdays at 7, Should I? fetches the forecast and a notification tells you the call',
    apps: ['weather'],
    spec: { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:00', tz: DEVICE },
    steps: (appIdOf) => [
      { kind: 'app-run', appId: appIdOf('weather') },
      { kind: 'notify', title: 'morning weather', body: 'your forecast is in — open Should I? for the call' },
    ],
  },
];

export function templateById(id: string | null | undefined): ScheduleTemplate | undefined {
  return id === null || id === undefined ? undefined : SCHEDULE_TEMPLATES.find((template) => template.id === id);
}

/** The starter folder's install identity, the hub's dedup rule (`starter:<folder>`). */
export const starterSourceOf = (folder: string): string => `starter:${folder}`;

/** What the user reads for a starter folder ("Ledger", "Should I?"), from the shelf's looks. */
export function templateAppName(folder: string): string {
  return starterLook(folder).name ?? folder.replace(/-/g, ' ');
}

/** The folders of a template's apps the user has NOT installed, in step order. */
export function missingApps(template: ScheduleTemplate, installedBySource: ReadonlyMap<string, string>): string[] {
  return template.apps.filter((folder) => !installedBySource.has(starterSourceOf(folder)));
}

/** Every app the template needs is installed (vacuously true for a reminder-only template). */
export function templateUsable(template: ScheduleTemplate, installedBySource: ReadonlyMap<string, string>): boolean {
  return missingApps(template, installedBySource).length === 0;
}

/** Usable AND about an installed app — what makes the hub section appear with nothing scheduled. */
export function templateFits(template: ScheduleTemplate, installedBySource: ReadonlyMap<string, string>): boolean {
  return template.apps.length > 0 && templateUsable(template, installedBySource);
}

/** Templates that fit first, then the rest in registry order. */
export function orderedTemplates(installedBySource: ReadonlyMap<string, string>): ScheduleTemplate[] {
  const fits = SCHEDULE_TEMPLATES.filter((template) => templateFits(template, installedBySource));
  const rest = SCHEDULE_TEMPLATES.filter((template) => !templateFits(template, installedBySource));
  return [...fits, ...rest];
}

/** The editor's prefill for a usable template: title, steps over the installed ids, the when. */
export function templateDraft(
  template: ScheduleTemplate,
  installedBySource: ReadonlyMap<string, string>,
): { title: string; steps: ScheduleStep[]; spec: ScheduleSpec } | undefined {
  if (!templateUsable(template, installedBySource)) return undefined;
  const appIdOf = (folder: string): string => installedBySource.get(starterSourceOf(folder)) ?? folder;
  return { title: template.title, steps: template.steps(appIdOf), spec: template.spec };
}

export const templateHref = (id: string): string => `/schedule/new?template=${encodeURIComponent(id)}`;
export const starterRunHref = (folder: string): string => `/run/starter--${folder}`;

export interface TemplatesProps {
  installedBySource: ReadonlyMap<string, string>;
}

export function Templates({ installedBySource }: TemplatesProps): ReactElement {
  return (
    <section className="schedule-templates" aria-labelledby="schedule-templates-heading" data-testid="schedule-templates">
      <h2 className="section-title" id="schedule-templates-heading">
        {TEMPLATES.heading}
      </h2>
      <div className="tile-grid">
        {orderedTemplates(installedBySource).map((template) => {
          const missing = missingApps(template, installedBySource);
          const glyphs = template.apps.length === 0 ? [template.glyph ?? '✦'] : template.apps.map((folder) => starterLook(folder).emoji);
          const firstMissing = missing[0];
          return (
            <Card
              key={template.id}
              className="schedule-template"
              data-testid="schedule-template"
              data-template={template.id}
              data-usable={firstMissing === undefined ? 'true' : 'false'}
            >
              <span className="schedule-template-glyphs" aria-hidden="true">
                {glyphs.join(' ')}
              </span>
              <span className="schedule-template-title">{template.title}</span>
              <span className="schedule-template-when">{describeSpec(template.spec)}</span>
              <span className="schedule-template-blurb">{template.blurb}</span>
              {firstMissing === undefined ? (
                <Link to={templateHref(template.id)} className="btn btn-primary schedule-template-act" data-testid="template-use">
                  {TEMPLATES.use}
                </Link>
              ) : (
                <Link to={starterRunHref(firstMissing)} className="btn schedule-template-act" data-testid="template-add">
                  {TEMPLATES.addThen(templateAppName(firstMissing))}
                </Link>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
