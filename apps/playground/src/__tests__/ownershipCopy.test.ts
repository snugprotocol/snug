// TASK-20260827-ownership-positioning — AC11: the Playground tells the SAME story as the
// rest of the site (the user owns the app and its state; the host supplies the
// intelligence) without becoming a landing page.
//
// Source-asserted: every claim here is an authoring fact — which copy exists, which label
// is unchanged, what sits above what in the document. Rendering these components would
// re-assert the same authored strings through a much heavier harness and prove nothing
// extra. The RENDERED-output claims that matter for the Playground already live in
// brainChip.test.tsx (byte-pinned honesty copy) and the e2e specs (the export flow).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Relative to THIS file, not the cwd: vitest may be invoked from the repo root.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');

/** Source with whitespace collapsed — JSX prose wraps, and a claim about words should
 *  not fail on where the formatter chose to break the line. */
const flat = (source: string): string => source.replace(/\s+/g, ' ');

const HUB = read('src', 'views', 'HubView.tsx');
const SETTINGS = read('src', 'views', 'SettingsView.tsx');
const CALLOUT = read('src', 'views', 'DemoBrainCallout.tsx');
const INDEX_HTML = read('index.html');

describe('AC11 — the Playground hero is action-oriented and ownership-framed', () => {
  it('leads with building something that belongs to you', () => {
    expect(flat(HUB)).toMatch(/belongs to you/i);
  });

  it('names the whole arc: build it, run it on host intelligence, keep the file', () => {
    expect(HUB).toMatch(/\.snug/);
    expect(flat(HUB)).toMatch(/agent (?:builds|writes)/i);
  });

  it('keeps the build affordance — the demo is the point, not the copy', () => {
    // The create bar and its build button must survive any copy pass. A Playground that
    // reads well and cannot be used has failed at the only job it has.
    expect(HUB).toMatch(/className="create-bar"/);
    expect(HUB).toMatch(/aria-label="describe the app to build"/);
    expect(HUB).toMatch(/onClick=\{\(\) => startBuild\(idea\)\}/);
  });

  it('puts the hero above the create bar, and the create bar above everything else', () => {
    const hero = HUB.indexOf('hub-hero');
    const bar = HUB.indexOf('create-bar');
    const apps = HUB.indexOf('your apps');
    expect(hero).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(hero);
    expect(apps).toBeGreaterThan(bar);
  });
});

describe('AC11 — "apps that outlive the AI that created them" sits where it is tangible', () => {
  it('appears next to the brain/model surface, not in the hero', () => {
    // The claim only becomes concrete where the user can see (and change) which
    // intelligence is running — that is the demo-brain callout, beside the switch.
    expect(CALLOUT).toMatch(/outlive the AI that created them/i);
    expect(HUB).not.toMatch(/outlive the AI/i);
  });

  it('states what actually survives a model or host change', () => {
    expect(flat(CALLOUT)).toMatch(/keep the application, keep its state/i);
    expect(flat(CALLOUT)).toMatch(/without starting over/i);
  });

  it('keeps the honest demo-brain mechanism sentence (ADR-0059 rule 4)', () => {
    // The positioning pass must not displace the one sentence that says the demo brain
    // is a script, not a model.
    expect(CALLOUT).toMatch(/DEMO_BRAIN_BODY/);
    expect(CALLOUT).toMatch(/BYOK_HONESTY_COPY/);
  });
});

describe('AC11 — the hosted Playground is not sold as private', () => {
  const OVERCLAIM =
    /nothing leaves (?:the|your) (?:machine|device|browser)|never leaves your (?:machine|device)|100% private|completely private/i;

  it('the hub makes no privacy claim for the hosted demo', () => {
    expect(HUB).not.toMatch(OVERCLAIM);
  });

  it('the demo callout makes no privacy claim for the hosted demo', () => {
    expect(CALLOUT).not.toMatch(OVERCLAIM);
  });
});

describe('AC11 — the export surface keeps its label and gains ownership context', () => {
  it('the button is still "export snug file"', () => {
    // Located by that exact string in snugFileNaming.test.ts, desktopSettingsView.test.tsx
    // and e2e/starters.spec.ts. Ownership copy goes AROUND the control, never through its
    // label — renaming a working affordance to make a point costs usability.
    expect(SETTINGS).toMatch(/export snug file/);
  });

  it('the surrounding hint frames the export as taking the app with you', () => {
    // Not merely "take it to another hub" (already true before this task) — the hint must
    // name the file as the unit of ownership that survives leaving.
    expect(flat(SETTINGS)).toMatch(/this file is the app/i);
  });

  it('still discloses that secrets are excluded unless opted in', () => {
    expect(flat(SETTINGS)).toMatch(/secrets stay out unless you opt in/i);
  });
});

describe('AC10 — Playground metadata is action-oriented', () => {
  it('the title invites building something you can take with you', () => {
    expect(INDEX_HTML).toMatch(/<title>[^<]*take with you[^<]*<\/title>/i);
  });

  it('og and twitter titles agree with it', () => {
    const og = INDEX_HTML.match(/property="og:title" content="([^"]*)"/)?.[1] ?? '';
    const tw = INDEX_HTML.match(/name="twitter:title" content="([^"]*)"/)?.[1] ?? '';
    expect(og).toMatch(/take with you/i);
    expect(tw).toBe(og);
  });

  it('the social card no longer sells the old slogan', () => {
    expect(INDEX_HTML).not.toMatch(/connects agents to (?:apps|tools)/i);
  });
});
