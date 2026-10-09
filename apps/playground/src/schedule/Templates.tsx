// schedule/Templates.tsx — the template cards (TASK-20261009-scheduling-framework U2; design
// F11: templates ALWAYS rendered). THE REGISTRY IS `editorModel.templateFill` — the same fill
// the editor opens with — and a card is rendered FROM it: the title, `describeSpec(fill.spec)`
// as the when, the starters the steps name, and which of them are missing. Nothing here
// decides a template's when or steps, so a card cannot promise what the editor then lacks.
//
// Whether the user has a starter is read the hub's way — `installSource` `starter:<folder>`
// on the library entry, the hub's dedup map — so a template whose apps are installed opens
// the editor prefilled (`routes.newScheduleHref({ template })`), and one whose app is missing
// says "add Weather, then schedule it" and links to that starter's run route, where install
// is an explicit act. The card order leads with what fits: a person who installed Ledger
// sees the spend review first.
//
// "nudge me" needs no app at all; it is always usable — but it never makes the HUB section
// appear on its own (`fits`), or every first-time user would see a schedule section before
// they have a single app.

import type { ReactElement } from 'react';
import { Link } from 'react-router';

import { starterLook } from '../starter/starterLooks.js';
import { Card } from '../ui/Card.js';
import { TEMPLATES } from './copy.page.js';
import { describeSpec } from './cron.js';
import { TEMPLATE_NAMES, templateAppName, templateFill, type StepDraft, type TemplateApp, type TemplateAppCandidate, type TemplateName } from './editorModel.js';
import { newScheduleHref } from './routes.js';

export { templateAppName };

/** The starter folder's install identity, the hub's dedup rule (`starter:<folder>`). */
export const starterSourceOf = (folder: string): string => `starter:${folder}`;
export const starterRunHref = (folder: string): string => `/run/starter--${folder}`;

/**
 * The hub's dedup map (`installSource` → appId) as the registry's candidates: one row per
 * installed starter, named by its id — a card decides by install identity, never by name.
 */
export function templateCandidates(installedBySource: ReadonlyMap<string, string>): TemplateAppCandidate[] {
  return [...installedBySource].map(([installSource, appId]) => ({ appId, displayName: appId, installSource }));
}

/** One card, as rendered — every field derived from the fill the editor will open with. */
export interface TemplateCard {
  name: TemplateName;
  title: string;
  /** `describeSpec` of the template's own spec. */
  when: string;
  blurb: string;
  /** The starters the steps name, in step order; empty for a reminder-only template. */
  apps: readonly TemplateApp[];
  /** Those not installed, in step order; the first one is the card's "add <App>" link. */
  missing: readonly TemplateApp[];
  glyph: string | undefined;
  /** The step kinds the editor opens with, in order. */
  stepKinds: readonly StepDraft['kind'][];
  /** Every app the template needs is installed (vacuously true for a reminder-only template). */
  usable: boolean;
  /** Usable AND about an installed app — what makes the hub section appear with nothing scheduled. */
  fits: boolean;
  /** The editor route, prefilled with this template. */
  href: string;
}

export function templateCard(name: TemplateName, installedBySource: ReadonlyMap<string, string>): TemplateCard {
  const fill = templateFill(name, templateCandidates(installedBySource));
  const usable = fill.missing.length === 0;
  return {
    name,
    title: fill.title,
    when: describeSpec(fill.spec),
    blurb: TEMPLATES.blurb[name],
    apps: fill.apps,
    missing: fill.missing,
    glyph: fill.glyph,
    stepKinds: fill.steps.map((step) => step.kind),
    usable,
    fits: usable && fill.apps.length > 0,
    href: newScheduleHref({ template: name }),
  };
}

/** Every template as a card: those that fit first, then the rest in registry order. */
export function templateCards(installedBySource: ReadonlyMap<string, string>): TemplateCard[] {
  const cards = TEMPLATE_NAMES.map((name) => templateCard(name, installedBySource));
  return [...cards.filter((card) => card.fits), ...cards.filter((card) => !card.fits)];
}

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
        {templateCards(installedBySource).map((card) => {
          const glyphs = card.apps.length === 0 ? [card.glyph ?? '✦'] : card.apps.map((app) => starterLook(app.folder).emoji);
          const firstMissing = card.missing[0];
          return (
            <Card key={card.name} className="schedule-template" data-testid="schedule-template" data-template={card.name} data-usable={card.usable ? 'true' : 'false'}>
              <span className="schedule-template-glyphs" aria-hidden="true">
                {glyphs.join(' ')}
              </span>
              <span className="schedule-template-title">{card.title}</span>
              <span className="schedule-template-when">{card.when}</span>
              <span className="schedule-template-blurb">{card.blurb}</span>
              {firstMissing === undefined ? (
                <Link to={card.href} className="btn btn-primary schedule-template-act" data-testid="template-use">
                  {TEMPLATES.use}
                </Link>
              ) : (
                <Link to={starterRunHref(firstMissing.folder)} className="btn schedule-template-act" data-testid="template-add">
                  {TEMPLATES.addThen(firstMissing.name)}
                </Link>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
