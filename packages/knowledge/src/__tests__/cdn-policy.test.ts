// The CDN page says exactly what the app frame's policy admits (TASK-20261003 R5 — the plan's
// process-owed "80-cdn-compatibility vs the S2 CSP").
//
// The page told a builder the frame "permits scripts ONLY from" the CDN allowlist and said
// nothing of stylesheets or fonts, while `RUNNER_CSP` (packages/runner/src/csp.ts — the one
// policy every Snug app frame carries, C2) admits both from that same allowlist. And its
// artifact section claimed "measured on both viewers" for a rule the September chat viewer's
// own policy did not hold (T1 S2, verbatim: its `style-src` listed jsDelivr `/npm/` and
// cdnjs). That viewer is gone — measured 2026-10-03, a chat artifact runs in the hosted
// viewer — so one artifact rule remains: the hosted viewer's, measured in T1 S1 (2026-09-05).
//
// HOW THE TWO ARE TIED: the policy is read from csp.ts's SOURCE (this package does not depend
// on the runner, and must not for a test), with `${CDN}` filled from the protocol's
// `CDN_ALLOWLIST` exactly as csp.ts fills it. Every directive that admits anything must be one
// bullet under "## The Allowlist Is Fixed", naming exactly the sources it admits. A policy
// change without a page change, or a page change without a policy change, is red.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CDN_ALLOWLIST } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { getKnowledgeBase } from '../index.js';
import { repoRoot } from './helpers.js';

type Policy = Map<string, string[]>;

/** `RUNNER_CSP` as csp.ts assembles it: directive → its sources. */
function runnerPolicy(): Policy {
  const source = readFileSync(path.join(repoRoot, 'packages', 'runner', 'src', 'csp.ts'), 'utf8');
  // The substitution below is faithful only while csp.ts builds `CDN` this way.
  expect(source).toContain("const CDN = CDN_ALLOWLIST.join(' ');");
  const declaration = /export const RUNNER_CSP: string =([\s\S]*?);\n/.exec(source)?.[1];
  if (declaration === undefined) throw new Error('csp.ts no longer declares RUNNER_CSP as this test reads it');
  const text = [...declaration.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1] ?? '')
    .join('')
    .replaceAll('${CDN}', CDN_ALLOWLIST.join(' '));
  return parsePolicy(text);
}

function parsePolicy(text: string): Policy {
  const policy: Policy = new Map();
  for (const directive of text.split(';').map((part) => part.trim()).filter((part) => part !== '')) {
    const [name = '', ...sources] = directive.split(/\s+/);
    policy.set(name, sources);
  }
  return policy;
}

/** The page's words for the directives it describes. */
const DIRECTIVE_OF: Record<string, string> = {
  scripts: 'script-src',
  stylesheets: 'style-src',
  fonts: 'font-src',
  images: 'img-src',
};

/** The bullets under "## The Allowlist Is Fixed": directive → the sources the bullet names. */
function pageClaims(page: string): Policy {
  const section = page.split('## The Allowlist Is Fixed')[1]?.split('\n## ')[0] ?? '';
  const claims: Policy = new Map();
  for (const [, resource = '', words = ''] of section.matchAll(/^- (\w+) — (.+)$/gm)) {
    const sources = [
      ...(/\binline\b/.test(words) ? ["'unsafe-inline'"] : []),
      ...(words.includes('`eval`') ? ["'unsafe-eval'"] : []),
      ...(words.match(/https:\/\/[^\s,;]+/g) ?? []),
      ...(words.includes('`data:`') ? ['data:'] : []),
      ...(words.includes('`blob:`') ? ['blob:'] : []),
    ];
    claims.set(DIRECTIVE_OF[resource] ?? `(unknown resource "${resource}")`, sources);
  }
  return claims;
}

/** Every disagreement between what the policy admits and what the page says it admits. */
function disagreements(policy: Policy, page: string): string[] {
  const claims = pageClaims(page);
  const admitting = [...policy].filter(([name, sources]) => name !== 'default-src' && !(sources.length === 1 && sources[0] === "'none'"));
  const problems: string[] = [];
  for (const [name, sources] of admitting) {
    const said = claims.get(name);
    if (said === undefined) problems.push(`RUNNER_CSP's ${name} admits ${sources.join(' ')}, and the page says nothing of it`);
    else if ([...sources].sort().join(' ') !== [...said].sort().join(' ')) problems.push(`${name}: RUNNER_CSP admits ${[...sources].sort().join(' ')}; the page says ${[...said].sort().join(' ')}`);
  }
  for (const name of claims.keys()) {
    if (!admitting.some(([admitted]) => admitted === name)) problems.push(`the page describes ${name}, which RUNNER_CSP does not admit`);
  }
  return problems;
}

const cdnPage = (): string => {
  const section = getKnowledgeBase().find((entry) => entry.file.endsWith('80-cdn-compatibility.md'));
  if (section === undefined) throw new Error('the KB has no 80-cdn-compatibility.md');
  return section.text;
};

describe('the CDN page and the app frame’s policy say one thing (R5)', () => {
  it('every directive RUNNER_CSP admits is one bullet of the page, naming exactly its sources — stylesheets and fonts included', () => {
    expect(disagreements(runnerPolicy(), cdnPage())).toEqual([]);
  });

  it('the policy this test reads is the real one: four admitting directives, connect-src closed', () => {
    // A reading that found nothing would agree with an empty page.
    const policy = runnerPolicy();
    expect([...policy.keys()]).toEqual(expect.arrayContaining(['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']));
    expect(policy.get('connect-src')).toEqual(["'none'"]);
    expect(policy.get('style-src')).toEqual(["'unsafe-inline'", ...CDN_ALLOWLIST]);
  });

  it('the comparison fails a page that drifts from the policy, either way', () => {
    // The rule on inputs built to break it: a green run cannot tell a working tie from one that compares nothing.
    const page = cdnPage();
    const real = runnerPolicy();
    const widened = new Map(real).set('media-src', ['https://example.com']);
    expect(disagreements(widened, page)).toEqual(["RUNNER_CSP's media-src admits https://example.com, and the page says nothing of it"]);
    const narrowed = new Map(real).set('style-src', ["'unsafe-inline'"]);
    expect(disagreements(narrowed, page)).toHaveLength(1);
    expect(disagreements(narrowed, page)[0]).toMatch(/^style-src: RUNNER_CSP admits 'unsafe-inline'; the page says /);
    const closed = new Map(real).set('font-src', ["'none'"]);
    expect(disagreements(closed, page)).toEqual(['the page describes font-src, which RUNNER_CSP does not admit']);
  });

  it('the artifact section keeps the narrower rule, and no longer claims a measurement on a viewer that is gone', () => {
    const page = cdnPage();
    // As sentences: a claim must not hide across a wrapped line.
    const artifact = (page.split('## Inside a Claude Artifact')[1]?.split('\n## ')[0] ?? '').replace(/\s+/g, ' ');
    expect(artifact).toMatch(/no CDN stylesheet\s+or font/i);
    expect(artifact).not.toMatch(/both viewers/);
    expect(artifact).toMatch(/a chat artifact runs in the same one/);
  });
});
