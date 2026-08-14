// connectionSurfaces — TASK-20260813 AC9/AC10.
//
// AC9: an app that has connection rows shows a "connections" control in its OWN header,
// beside export and theme. Before this there was no way back to a connection once it was
// established — Settings held a cross-app list, but the app itself offered nothing, so
// "manage what this app is connected to" had no door from where the user actually was.
//
// AC10: connection surfaces stop borrowing the failure palette. "This app would like to
// connect" is the ORDINARY case and was arriving in the same alarm red as "the provider
// rejected your key". Red is a strong claim; spending it on routine setup leaves nothing
// louder for the real failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../..');
const read = (rel: string): string => readFileSync(resolve(appRoot, rel), 'utf8');

const css = read('src/theme/app.css');
const runView = read('src/run/RunView.tsx');
const repairBanner = read('src/run/AuthRepairBanner.tsx');

/** One CSS rule body, anchored so `.connection-note` ≠ `.connection-note-title`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.]/g, '\\.');
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`no ${selector} rule in app.css`);
  return match[2];
}

describe('AC9 — the app header offers a way back to its connections', () => {
  it('renders a connections control gated on the app having rows', () => {
    // The gate is `connectionSlots > 0` — rows exist, whatever their status. An app
    // that is already CONNECTED is precisely the case the owner reported as having no
    // door, so gating on "not yet approved" would rebuild the same gap.
    expect(runView).toMatch(/connectionSlots > 0/);
    expect(runView).toContain('data-testid="manage-connections"');
  });

  it('counts rows for THIS app only, not every app in the hub', () => {
    // `listConnections()` with no argument returns every app's rows — using that would
    // show the control on apps that connect to nothing.
    expect(runView).toMatch(/listConnections\(id\)/);
  });

  it('opens the wizard for this app rather than re-deriving which connection was meant', () => {
    expect(runView).toMatch(/openConnectionWizardForApp\(id,\s*'settings'\)/);
  });

  it('re-reads when the wizard changes something, so connecting reveals the control', () => {
    // Without this the count is captured once on mount: an app connected for the first
    // time would show no control until a full reload.
    expect(runView).toMatch(/connectionWizardRevisionStore/);
    expect(runView).toMatch(/\[id,\s*wizardRevision\]/);
  });

  it('excludes starters, whose declaration has no persisted rows yet', () => {
    // A starter declares via a bundled manifest; the wizard would open empty.
    expect(runView).toMatch(/connectionSlots > 0 && !isStarterId\(id\)/);
  });

  it('sits in the same action cluster as export and the theme toggle', () => {
    // The owner asked for it "in a common place like the header where export and
    // light/dark are" — so assert the ORDERING, not merely that it exists somewhere.
    const manage = runView.indexOf('data-testid="manage-connections"');
    const exportBtn = runView.indexOf('export .sqlite');
    const theme = runView.indexOf('switch to ${theme');
    expect(manage).toBeGreaterThan(-1);
    expect(manage).toBeLessThan(exportBtn);
    expect(exportBtn).toBeLessThan(theme);
  });
});

describe('AC10 — needing a connection is not styled as a failure', () => {
  it('the calm surface exists and does not use the danger palette', () => {
    const note = rule('.connection-note');
    expect(note).toMatch(/border-left:\s*3px solid var\(--ember\)/);
    expect(note).toMatch(/background:\s*var\(--surface\)/);
    // The whole point: the ordinary case must not wear --danger.
    expect(note).not.toMatch(/var\(--danger/);
  });

  it('keeps a distinct FAILURE variant, so the two states are told apart', () => {
    // Same structure, different temperature — a surface that changes shape as well as
    // colour stops being recognisable as the same thing.
    const errorVariant = rule('.connection-note.is-error');
    expect(errorVariant).toMatch(/var\(--danger/);
  });

  it('the net-error CTA uses the calm surface, not the failure one', () => {
    // "this app tried to reach the network and has nothing approved" is setup, not
    // breakage.
    const cta = runView.slice(runView.indexOf('data-testid="net-auth-cta"') - 200, runView.indexOf('data-testid="net-auth-cta"') + 40);
    expect(cta).toContain('className="connection-note"');
    expect(cta).not.toContain('className="error-note"');
  });

  it('a REJECTED credential still reads as a failure', () => {
    // The one connection surface that genuinely is one keeps the danger accent —
    // otherwise AC10 would have flattened a real error into routine chrome.
    expect(repairBanner).toContain('className="connection-note is-error"');
  });

  it('both surfaces keep one primary action and a quiet dismiss', () => {
    for (const [name, source] of [
      ['net-auth-cta', runView],
      ['auth-repair-banner', repairBanner],
    ] as const) {
      const at = source.indexOf(`data-testid="${name}"`);
      // Wide enough to reach the dismiss at the end of the actions row — the net-error
      // CTA's two conditional copy branches push it out past 1900 characters.
      const region = source.slice(at, at + 2400);
      expect(region, `${name} lost its primary action`).toMatch(/variant="primary"/);
      expect(region, `${name} lost its dismiss`).toMatch(/variant="ghost"/);
    }
  });

  it('keeps role="alert" on both, so the change is visual only', () => {
    // Restyling must not quietly drop assistive-tech semantics that existing suites
    // and real screen readers depend on.
    expect(runView).toMatch(/className="connection-note" role="alert"/);
    expect(repairBanner).toMatch(/className="connection-note is-error" role="alert"/);
  });
});
