// AC1/AC2 — the skill is built from its sources, and every rule has a mutant.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildSkillTree,
  demoteHeadings,
  DESCRIPTION_MAX_CHARS,
  frontmatterField,
  INSTRUCTIONS_SOURCE,
  LAUNCH_MARKER,
  renderReferences,
  renderSkill,
  SKILL_SOURCE,
  splitFrontmatter,
  stripStoreHeader,
  validateSkill,
} from './skill-build.mjs';

const source = readFileSync(SKILL_SOURCE, 'utf8');
const instructions = readFileSync(INSTRUCTIONS_SOURCE, 'utf8');

const fakeKb = [
  { file: 'knowledge-base/app-authoring/10-overview.md', text: '# Overview\n\n## What\n\ntext', headingTree: ['# Overview', '## What'] },
  { file: 'knowledge-base/app-authoring/20-template.md', text: '# Template\n\n```\n## not a heading\n```\n', headingTree: ['# Template'] },
];

describe('the real skill source', () => {
  it('renders, and the rendered SKILL.md is frontmatter-first', () => {
    const text = renderSkill({ source, instructions });
    assert.ok(text.startsWith('---\nname: snug\n'), text.slice(0, 40));
  });

  it('carries the store header in the SOURCE (the store’s rule) and not in the OUTPUT (the skill’s)', () => {
    assert.ok(source.startsWith('<!--\nlayer: skill'));
    assert.ok(!renderSkill({ source, instructions }).includes('<!--\nlayer:'));
  });

  it('inserts the launch protocol from instructions.md, headings demoted under the runner section', () => {
    const text = renderSkill({ source, instructions });
    // The process's first sentence, verbatim.
    assert.ok(text.includes(instructions.trim().split('\n')[0]));
    // Its `## Launching` sits at H4 under `### The local runner`.
    assert.ok(text.includes('\n#### Launching'), 'expected the demoted heading');
    assert.ok(!text.includes('\n## Launching'));
    assert.ok(text.indexOf('### The local runner') < text.indexOf('#### Launching'));
    assert.ok(!text.includes(LAUNCH_MARKER));
  });

  it('has a description under the claude.ai cap that names the asks it must trigger on', () => {
    const { frontmatter } = splitFrontmatter(renderSkill({ source, instructions }));
    const description = frontmatterField(frontmatter, 'description');
    assert.ok(description.length <= DESCRIPTION_MAX_CHARS, `${description.length} > ${DESCRIPTION_MAX_CHARS}`);
    assert.match(description, /\bapp\b/i);
    assert.match(description, /\bgame\b/i);
    assert.match(description, /Snug/);
  });

  it('is under 500 lines and carries no unrendered placeholder', () => {
    assert.deepEqual(validateSkill(renderSkill({ source, instructions })), []);
  });

  it('tells the truth about connections on the local runner — the bundle carries none', () => {
    const text = renderSkill({ source, instructions });
    assert.match(text, /"connections": \[\]/);
    assert.match(text, /connections door/);
  });

  it('never defines Snug through MCP outside the never-list (ADR-0061)', () => {
    const text = renderSkill({ source, instructions });
    const outsideNever = text.split('## Never')[0];
    assert.ok(!/built on MCP|MCP server/i.test(outsideNever));
  });
});

describe('validateSkill — every rule can fail', () => {
  const good = renderSkill({ source, instructions });
  const withDescription = (d) => good.replace(/^description: .*$/m, `description: "${d}"`);

  it('refuses a description over the cap', () => {
    const long = `Snug app game tracker tool ${'x'.repeat(DESCRIPTION_MAX_CHARS)}`;
    assert.ok(validateSkill(withDescription(long)).some((p) => p.includes('cap')));
  });

  it('refuses a description that would not trigger on an app ask', () => {
    assert.ok(validateSkill(withDescription('Snug does things.')).some((p) => p.includes('trigger')));
  });

  it('refuses the wrong name', () => {
    assert.ok(validateSkill(good.replace('name: snug', 'name: snugg')).some((p) => p.includes('name')));
  });

  it('refuses a leftover marker', () => {
    assert.ok(validateSkill(`${good}\n${LAUNCH_MARKER}\n`).some((p) => p.includes('marker')));
  });

  it('refuses an unrendered placeholder in the body', () => {
    assert.ok(validateSkill(`${good}\nsee {{cdnAllowlist}}\n`).some((p) => p.includes('placeholder')));
  });

  it('refuses a source without frontmatter (a header that was not stripped)', () => {
    assert.ok(validateSkill(`<!-- x -->\n${good}`).some((p) => p.includes('frontmatter')));
  });
});

describe('the pieces', () => {
  it('stripStoreHeader removes only a leading comment', () => {
    assert.equal(stripStoreHeader('<!--\nlayer: x\n-->\n\n---\nname: y\n---\n'), '---\nname: y\n---\n');
    assert.equal(stripStoreHeader('---\nname: y\n---\n'), '---\nname: y\n---\n');
  });

  it('demoteHeadings leaves fenced code alone', () => {
    assert.equal(demoteHeadings('## a\n```\n## b\n```\n# c', 2), '#### a\n```\n## b\n```\n### c');
  });

  it('renderReferences keeps the store’s file names and the knowledge package’s text byte for byte', () => {
    const refs = renderReferences(fakeKb);
    assert.deepEqual(refs.map((r) => r.name), ['10-overview.md', '20-template.md']);
    assert.equal(refs[0].text, fakeKb[0].text);
  });

  it('buildSkillTree lays the files out as a skill folder', async () => {
    const tree = await buildSkillTree({ source, instructions, knowledgeBase: fakeKb });
    assert.deepEqual(Object.keys(tree).sort(), ['SKILL.md', 'references/10-overview.md', 'references/20-template.md']);
  });
});

describe('against the REAL knowledge base', () => {
  it('renders every KB section as a reference with its headings intact', async () => {
    const tree = await buildSkillTree({ source, instructions });
    const refs = Object.keys(tree).filter((k) => k.startsWith('references/'));
    assert.ok(refs.length >= 10, `expected the ten KB files, got ${refs.length}`);
    for (const name of ['10-overview-and-contract.md', '20-html-template.md', '90-auth-and-connected-apis.md', '95-runtime-contract.md']) {
      assert.ok(refs.includes(`references/${name}`), `missing ${name}`);
    }
    // Rendered, not raw: no store header, and none of the PROTOCOL placeholders the knowledge
    // package resolves at render time. (The auth reference keeps `{{api_key}}`-style runtime
    // template placeholders on purpose — they are part of what it teaches.)
    for (const key of refs) {
      assert.ok(!tree[key].startsWith('<!--'), `${key} still carries the store header`);
      assert.ok(!/\{\{(cdnAllowlist|appBuilderToolName|frameType:[^}]+)\}\}/.test(tree[key]), `${key} carries an unrendered protocol placeholder`);
      assert.ok(tree[key].includes('cdn.jsdelivr.net') || !key.includes('80-cdn'), 'the CDN reference must carry the resolved allowlist');
    }
    // Every reference the SKILL.md points the agent at exists.
    for (const [, name] of tree['SKILL.md'].matchAll(/references\/([0-9a-z-]+\.md)/g)) {
      assert.ok(refs.includes(`references/${name}`), `SKILL.md cites a missing reference ${name}`);
    }
  });
});

describe('the MCP rule exempts the never-list SECTION, not any line with the word (review, 2026-09-13)', () => {
  it('catches "Snug is an MCP server" above the never-list even on a line that also says never', () => {
    const good = renderSkill({ source, instructions });
    const bad = good.replace('## Build the app', 'Snug is an MCP server, never forget.\n\n## Build the app');
    assert.ok(validateSkill(bad).some((p) => p.includes('MCP')));
  });

  it('accepts the never-list’s own mention', () => {
    assert.deepEqual(validateSkill(renderSkill({ source, instructions })), []);
  });

  it('refuses an install line or repository that drifted from plugin-manifests.mjs', () => {
    const good = renderSkill({ source, instructions });
    assert.ok(validateSkill(good.replace('snug@snug-skill', 'snug@elsewhere')).some((p) => p.includes('install line')));
    assert.ok(validateSkill(good.replace('https://github.com/snugprotocol/snug-skill', 'https://example.com/x')).some((p) => p.includes('repository')));
  });
});
