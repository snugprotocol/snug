// TASK-20260827-ownership-positioning — the public story is ONE story: the user is the
// durable owner of the application and its accumulated state; the host supplies the
// intelligence.
//
// Two seams, deliberately:
//   - Source-asserted where the claim is an AUTHORING fact ("this section exists", "this
//     heading is not that heading"). Reading dist/ would assert the same authored strings
//     after a template pass and prove nothing extra.
//   - dist-asserted where the claim is about RENDERED output (metadata a scraper reads).
//     A claim about rendered output cannot be proven by grepping source (lessons
//     2026-08-23) — and the two shells here emit different markup for the same meta tag.
//
// The negative assertions matter as much as the positive ones. Half this file exists so a
// later copy edit cannot quietly re-introduce an overclaim ("your data never leaves your
// machine" outside the local-only figure) or delete a caveat while keeping the promise.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf8');

const INDEX = src('pages', 'index.astro');
const ARCHITECTURE = src('pages', 'architecture.astro');
const FIGURES = src('components', 'ArchitectureFigures.astro');
const DIFFERENTIATORS = src('components', 'Differentiators.astro');
const WIRE = src('components', 'WireDemo.astro');
const PERSONAL = join(ROOT, 'src', 'components', 'PersonalSoftware.astro');

/** Visible prose only — strip the frontmatter, <style> blocks, and HTML comments. */
function prose(source: string): string {
  return source
    .replace(/^---[\s\S]*?^---/m, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/**
 * The sentence a reader actually sees: prose with inline markup removed and whitespace
 * collapsed. A headline is authored as `a <em class="hero-em">landlord</em>.` — matching
 * the source string would pin the MARKUP, so a later `<strong>` swap would fail a test
 * about the words. Astro's own newline-trimming at inline-tag boundaries is why
 * architecturePage.test.ts checks the rendered join separately; here we only care that the
 * words are present and in order.
 */
function sentence(source: string): string {
  return prose(source)
    .replace(/\{'\s*'\}/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');
}

describe('AC1 — the homepage leads with ownership, not with MCP', () => {
  it('the hero headline is the landlord line', () => {
    expect(sentence(INDEX)).toMatch(/Your software shouldn'?(?:&#39;|’|')?t need a landlord/i);
  });

  it('the MCP comparison is gone from the homepage entirely', () => {
    // Not "moved lower" — gone. MCP is complementary infrastructure, never the foil Snug
    // defines itself against.
    const body = prose(INDEX);
    expect(body).not.toMatch(/MCP/);
    expect(body).not.toMatch(/connects agents to (?:apps|tools)/i);
  });

  it('keeps the protocol identification eyebrow', () => {
    expect(INDEX).toMatch(/The Snug Protocol · open spec · MIT/);
  });

  it('carries the ownership subheadline', () => {
    const hero = sentence(INDEX);
    expect(hero).toMatch(/live with you/i);
    expect(hero).toMatch(/your choice of intelligence/i);
  });

  it('still explains, technically, what Snug actually is', () => {
    // A developer landing cold must learn the mechanism from the hero, not just the
    // promise: agent builds it · state in a portable .snug · host supplies intelligence.
    const hero = INDEX.slice(0, INDEX.indexOf('</section>'));
    expect(hero).toMatch(/\.snug/);
    expect(hero).toMatch(/host/i);
    expect(hero).toMatch(/runtime/i);
  });

  it('keeps all three primary CTAs', () => {
    expect(INDEX).toMatch(/href="\/download\/"/);
    expect(INDEX).toMatch(/site\.playground/);
    expect(INDEX).toMatch(/href="\/docs\/spec\/"/);
  });
});

describe('AC2 — the larger thesis lands on the homepage', () => {
  it('asks why the applications are still trapped', () => {
    expect(INDEX).toMatch(/still trapped/i);
  });

  it('names what is already portable, standardised and interchangeable', () => {
    const body = prose(INDEX);
    expect(body).toMatch(/portable/i);
    expect(body).toMatch(/standardi[sz]ed/i);
    expect(body).toMatch(/interchangeable/i);
  });

  it('states the boundary Snug draws instead', () => {
    expect(prose(INDEX)).toMatch(/intelligence is supplied by the host|host supplies the intelligence/i);
  });
});

describe('AC3 — the anti-SaaS section is scoped, not absolute', () => {
  it('the section exists', () => {
    expect(existsSync(PERSONAL), 'PersonalSoftware.astro missing').toBe(true);
    expect(readFileSync(PERSONAL, 'utf8')).toMatch(/Not every app needs to become a service/i);
    expect(INDEX).toMatch(/PersonalSoftware/);
  });

  it('scopes the claim to an APPLICATION-SPECIFIC backend', () => {
    // The whole nuance of the section. "Snug removes the SaaS backend" is false; "Snug
    // removes the need for an application-specific SaaS backend accumulating your state"
    // is what the architecture earns.
    const body = prose(readFileSync(PERSONAL, 'utf8'));
    expect(body).toMatch(/application-specific/i);
  });

  it('does not claim external services disappear', () => {
    const body = prose(readFileSync(PERSONAL, 'utf8'));
    expect(body).not.toMatch(/no third part(?:y|ies) (?:ever )?sees?/i);
    expect(body).not.toMatch(/never leaves your (?:machine|device|computer)/i);
    expect(body).not.toMatch(/100% private|zero.knowledge/i);
  });
});

describe('AC4 — the body/mind concept survives as architecture', () => {
  it('the homepage wire demo still carries it', () => {
    const body = sentence(WIRE);
    expect(body).toMatch(/The app is a body/i);
    expect(body).toMatch(/The agent is its mind/i);
  });

  it('the architecture hero still carries it', () => {
    const body = sentence(ARCHITECTURE);
    expect(body).toMatch(/The app is a body/i);
    expect(body).toMatch(/The agent is the mind/i);
  });

  it('the architecture hero ties it to ownership', () => {
    expect(ARCHITECTURE).toMatch(/stays with you|belongs to (?:the user|you)/i);
  });
});

describe('AC5 — "why it\'s different" is defensible, not absolute', () => {
  it('drops the unprovable "no app platform gives you" claim', () => {
    expect(prose(DIFFERENTIATORS)).not.toMatch(/no app platform/i);
  });

  it('leads with what changes when the app belongs to you', () => {
    expect(DIFFERENTIATORS).toMatch(/belongs to you|change[s]? what you own/i);
  });

  it('keeps all three technical concepts, each mapped to ownership', () => {
    const body = prose(DIFFERENTIATORS);
    // 1 — runtime relationship, not codegen
    expect(body).toMatch(/runtime/i);
    // 2 — one portable file
    expect(body).toMatch(/\.snug/);
    expect(body).toMatch(/SQLite/i);
    // 3 — credentials outside generated code
    expect(body).toMatch(/credential/i);
    expect(body).toMatch(/no network/i);
  });
});

describe('AC6 — every figure carries an explicit takeaway', () => {
  it('there are six takeaway lines, one per figure', () => {
    // Matches the whole class attribute: `fig-takeaway` and `fig-takeaway fig-takeaway-major`
    // are each ONE element. Counting the bare substring would double-count the major ones.
    const takeaways = [...FIGURES.matchAll(/class="fig-takeaway(?: fig-takeaway-major)?"/g)];
    expect(takeaways.length, 'expected one .fig-takeaway per figure').toBe(6);
    // Count the markup, not the stylesheet — the `.fig-takeaway-major` rule lives in the
    // same file and would otherwise read as a fourth peak.
    const major = [...prose(FIGURES).matchAll(/fig-takeaway-major"/g)];
    expect(major.length, 'Fig 4, 5 and 6 carry the page\'s three peaks').toBe(3);
  });

  const TAKEAWAYS: ReadonlyArray<readonly [string, RegExp]> = [
    ['Fig 1 — improves without a rebuild', /without rebuilding the app|without a rebuild/i],
    ['Fig 2 — the model is a choice, not a dependency', /a choice, not an application dependency/i],
    ['Fig 3 — connected without credential exposure', /Connected doesn'?(?:&#39;|’|')?t have to mean credential-exposed/i],
    ['Fig 4 — accumulation, not access', /isn'?(?:&#39;|’|')?t access\.? It'?(?:&#39;|’|')?s accumulation/i],
    ['Fig 5 — nothing leaves the machine (local only)', /Nothing leaves the machine/i],
    ['Fig 6 — ownership means you can leave', /Ownership means you can leave/i],
  ];

  it.each(TAKEAWAYS)('%s', (_label, pattern) => {
    expect(FIGURES).toMatch(pattern);
  });

  it('keeps the existing ledes and captions that already do the honest work', () => {
    // These were precise before this task and are not collateral to it.
    expect(sentence(FIGURES)).toMatch(/no intermediary that accumulates/i);
    expect(FIGURES).toMatch(/SimpleFIN is an aggregator too/i);
    expect(FIGURES).toMatch(/Openable with any SQLite tool/i);
  });
});

describe('AC9 — the fully-local claim appears ONLY where it is true', () => {
  // "Nothing leaves the machine" is defensible for exactly one configuration: the Fig 5
  // all-local deployment where the model runs on the same box. Anywhere else it is a lie
  // a critical reader catches — and a reader who catches one overclaim stops believing
  // the honest claims too (the standing BrainChip rule, ADR-0059 rule 4).
  const LOCALITY = /nothing leaves the (?:machine|device)|never leaves your (?:machine|device|computer)/gi;

  it('the homepage makes no unqualified no-data-leaves claim', () => {
    expect(prose(INDEX).match(LOCALITY) ?? []).toEqual([]);
  });

  it('the differentiators make no unqualified no-data-leaves claim', () => {
    expect(prose(DIFFERENTIATORS).match(LOCALITY) ?? []).toEqual([]);
  });

  it('in the figures it appears only inside figures that depict a local model', () => {
    // Fig 2's local-adapter box and Fig 4's local-model box both depict an on-device model;
    // Fig 5 is the whole-system local configuration. The FIGURE is the unit of scope — a
    // byte window would pass or fail on where a caption happens to wrap.
    const figures = FIGURES.split(/{\/\* =+ FIG /).slice(1);
    expect(figures.length, 'figures did not split — has the marker comment changed?').toBe(6);

    let claims = 0;
    for (const [i, figure] of figures.entries()) {
      const hits = figure.match(LOCALITY) ?? [];
      if (hits.length === 0) continue;
      claims += hits.length;
      expect(figure, `Fig ${i + 1} claims locality without depicting a local model`).toMatch(
        /Local (?:model|LLM)|Ollama|local model|local endpoint/i,
      );
    }
    expect(claims, 'no locality claim found at all').toBeGreaterThan(0);
  });

  it('Fig 5 is the figure that carries the whole-system local claim', () => {
    const fig5 = FIGURES.split(/{\/\* =+ FIG /)[5] ?? '';
    expect(fig5, 'Fig 5 should be the private-mode figure').toMatch(/Private mode/i);
    expect(fig5).toMatch(/Nothing leaves the machine/i);
    // …and it must qualify itself in the same breath: the sentence is true of THIS
    // configuration, and a hosted provider still sees what is sent to it.
    expect(fig5).toMatch(/hosted provider|sees what is\s+sent to it|for inference/i);
  });

  it('the architecture page keeps the hosted-model caveat next to the local story', () => {
    expect(ARCHITECTURE).toMatch(/hosted model/i);
    expect(ARCHITECTURE).toMatch(/that provider'?(?:&#39;|’|')?s normal terms apply/i);
  });
});

describe('AC7 — the architecture closer does not define Snug through MCP', () => {
  it('the MCP comparison is gone from the page', () => {
    const body = prose(ARCHITECTURE);
    expect(body).not.toMatch(/MCP connected agents to tools/i);
    expect(body).not.toMatch(/connects agents to apps/i);
  });

  it('the closer leads with ownership', () => {
    const closer = ARCHITECTURE.slice(ARCHITECTURE.lastIndexOf('class="section closer"'));
    expect(closer).toMatch(/belongs to the user|user keeps the app/i);
  });

  it('keeps the MIT / source / spec CTAs', () => {
    expect(ARCHITECTURE).toMatch(/site\.githubRepo/);
    expect(ARCHITECTURE).toMatch(/href="\/docs\/spec\/"/);
    expect(ARCHITECTURE).toMatch(/href="\/download\/"/);
  });
});

describe('AC8 — the transparency section is untouched in substance', () => {
  // architecturePage.test.ts already pins the six residuals by regex. This is the
  // belt-and-braces check that the SECTION itself was not softened while re-positioning
  // the page around ownership — the honest half is the reason a skeptical reader
  // believes the rest.
  it('still says the model sees your app data', () => {
    expect(sentence(ARCHITECTURE)).toMatch(/The model does see your app'?(?:&#39;|’|')?s data/i);
  });

  it('still says local inference is what keeps the data put', () => {
    expect(ARCHITECTURE).toMatch(/local model is what makes the data stay put|Choosing a local model/i);
  });

  it('still separates credentials from application data as concerns', () => {
    expect(sentence(ARCHITECTURE)).toMatch(/never travels is the credential/i);
  });

  it('still names the platform limitation and the pre-1.0 state', () => {
    expect(ARCHITECTURE).toMatch(/macOS-only through 1\.0/i);
    expect(ARCHITECTURE).toMatch(/pre-1\.0/i);
  });

  it('still disclaims third-party provider practices', () => {
    expect(sentence(ARCHITECTURE)).toMatch(/model provider you choose to connect|those have their own terms/i);
  });
});

describe('the new sections do not break the 375px viewport', () => {
  // Standing tripwire (lessons 2026-08-23): no horizontal scroll at 375px. A bare
  // `minmax(24rem, 1fr)` track cannot shrink below 384px and overflowed a 375px viewport
  // the first time this section shipped — caught in a real browser, pinned here.
  const AUTHORED = [
    join(ROOT, 'src', 'pages', 'index.astro'),
    join(ROOT, 'src', 'components', 'PersonalSoftware.astro'),
    join(ROOT, 'src', 'components', 'ArchitectureFigures.astro'),
  ];

  it.each(AUTHORED)('%s declares no unshrinkable grid track', (file) => {
    // Strip comments first — a CSS or JS comment EXPLAINING minmax (like the one beside the
    // fix in index.astro) is prose, not a declaration, and must not read as a violation.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // minmax(<length>, …) is safe only when the floor can collapse — i.e. wrapped in min()
    // against a percentage. Anything else pins a track wider than a phone.
    const tracks = [...source.matchAll(/minmax\(\s*([^,]+?)\s*,/g)].map((m) => m[1].trim());
    const rigid = tracks.filter((t) => /^\d+(?:\.\d+)?(?:rem|px|em)$/.test(t));
    expect(rigid, `unshrinkable grid track(s) in ${file} — wrap in min(…, 100%)`).toEqual([]);
  });
});

describe('the mobile nav control is icon-only but still named', () => {
  // Owner call 2026-08-27: drop the visible "Menu" word and the Download CTA from the
  // sheet. The lesson the visible word originally served (2026-08-18 — a bare glyph must
  // not be nameless) is still live, so these pin the REPLACEMENT guarantee rather than the
  // old markup: the name moves to aria-label, and the now-square control keeps a full tap
  // target in both axes.
  const LAYOUT = src('layouts', 'MarketingLayout.astro');

  it('carries no visible "Menu" label inside the summary', () => {
    const summary = LAYOUT.slice(LAYOUT.indexOf('<summary'), LAYOUT.indexOf('</summary>'));
    expect(summary).not.toMatch(/<span>\s*Menu\s*<\/span>/);
  });

  it('still gives the glyph an accessible name', () => {
    expect(LAYOUT).toMatch(/<summary[^>]*aria-label="Menu"/);
  });

  it('keeps a full tap target in BOTH axes now that it is square', () => {
    // A 44px-tall, 30px-wide button is still a miss on a phone.
    const rule = LAYOUT.slice(LAYOUT.indexOf('.nav-mobile > summary {'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toMatch(/min-height:\s*var\(--tap\)/);
    expect(block).toMatch(/min-width:\s*var\(--tap\)/);
  });

  it('the sheet carries the nav destinations and no Download CTA', () => {
    const sheet = LAYOUT.slice(LAYOUT.indexOf('<div class="nav-sheet">'), LAYOUT.indexOf('</details>'));
    for (const dest of ['/architecture/', '/docs/', '/docs/spec/', 'site.playground', 'site.githubOrg']) {
      expect(sheet, `mobile sheet lost ${dest}`).toContain(dest);
    }
    expect(sheet, 'Download CTA should not be in the mobile sheet').not.toMatch(/href="\/download\/"/);
  });

  it('leaves no orphaned CSS for the removed CTA', () => {
    expect(LAYOUT).not.toMatch(/nav-sheet-cta/);
  });

  it('/download/ is still reachable on the homepage without the sheet', () => {
    // Removing it from the menu must not strand the page it pointed at.
    expect(INDEX).toMatch(/href="\/download\/"/);
  });
});

describe('AC10 — metadata carries the new positioning', () => {
  const DIST = join(ROOT, 'dist');
  const distPage = (p: string): string => readFileSync(join(DIST, p), 'utf8');

  const meta = (html: string, key: string): string | undefined => {
    const attr = key.startsWith('twitter:') ? 'name' : 'property';
    const m = html.match(
      new RegExp(
        `<meta[^>]*${attr}="${key}"[^>]*content="([^"]*)"[^>]*/?>|` +
          `<meta[^>]*content="([^"]*)"[^>]*${attr}="${key}"[^>]*/?>`,
      ),
    );
    return m ? (m[1] ?? m[2]) : undefined;
  };

  const description = (html: string): string | undefined =>
    html.match(/<meta name="description" content="([^"]*)"/)?.[1];

  it('dist/ exists (turbo builds before test)', () => {
    expect(existsSync(DIST), 'run `pnpm --filter website build`').toBe(true);
  });

  it('the homepage title says the apps belong to you', () => {
    const html = distPage('index.html');
    expect(html).toMatch(/<title>[^<]*belong to you[^<]*<\/title>/i);
    expect(meta(html, 'og:title')).toMatch(/belong to you/i);
  });

  it('the homepage description leads with the protocol and ownership, not MCP', () => {
    const value = description(distPage('index.html')) ?? '';
    expect(value).toMatch(/open protocol/i);
    expect(value).toMatch(/portable|keep the app/i);
    expect(value).not.toMatch(/MCP/);
  });

  it('the architecture title names ownership, portability and runtime intelligence', () => {
    const html = distPage(join('architecture', 'index.html'));
    expect(html).toMatch(/<title>[^<]*Ownership[^<]*<\/title>/i);
    expect(description(html) ?? '').toMatch(/portable file|fully local|runtime intelligence/i);
  });

  it('no built marketing page still advertises the old slogan', () => {
    for (const page of ['index.html', join('architecture', 'index.html'), join('download', 'index.html')]) {
      const html = distPage(page);
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head, `${page} head still carries the old positioning`).not.toMatch(
        /connects agents to (?:apps|tools)/i,
      );
    }
  });
});
