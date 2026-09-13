// The Snug skill, built from its sources (ADR-0069 §7, ADR-0065 §8 D6 as amended).
//
// ONE SOURCE EACH. The SKILL.md body is authored in the prompt store
// (`packages/knowledge/prompts/skills/snug/SKILL.md` — every LLM-bound prompt lives there,
// ADR-0004) under the store's mandatory header comment, which this build strips. Its launch
// section is `apps/host-mcp/src/instructions.md` — the SAME text the process hands an MCP
// client at `initialize` (D-B12) — inserted at a marker with its headings demoted, so the
// agent reads one protocol twice rather than two protocols once. The `references/` are the
// app-authoring knowledge base rendered by the knowledge package itself (headers stripped,
// placeholders resolved), so a KB edit reaches the skill on the next build with no copy.
//
// Nothing here is committed: `scripts/build-plugin.mjs` writes the tree into the gitignored
// `dist/plugin/` and the gate re-renders and byte-compares on every run.
//
// Dependency-free node builtins only, like every other file under `scripts/`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SKILL_SOURCE = path.join(REPO, 'packages/knowledge/prompts/skills/snug/SKILL.md');
export const INSTRUCTIONS_SOURCE = path.join(REPO, 'apps/host-mcp/src/instructions.md');
export const KNOWLEDGE_DIST = path.join(REPO, 'packages/knowledge/dist/index.js');

/** Where the launch protocol goes in the source. */
export const LAUNCH_MARKER = '<!-- launch-protocol -->';

/** The skill's name — the directory, the frontmatter and the plugin's `skills/<name>` agree. */
export const SKILL_NAME = 'snug';

/**
 * claude.ai's custom-skill upload caps the description at 200 characters (program record
 * T6); the Agent Skills spec allows more, but a description that survives every host is
 * the one that ships.
 */
export const DESCRIPTION_MAX_CHARS = 200;

/** The trigger words a "build me an app" ask carries, which the description must name. */
export const TRIGGER_WORDS = ['app', 'game', 'tracker', 'tool'];

/** The store header comment at the top of a prompt file, if present. */
export function stripStoreHeader(text) {
  if (!text.startsWith('<!--')) return text;
  const end = text.indexOf('-->');
  if (end === -1) return text;
  return text.slice(end + '-->'.length).replace(/^\r?\n+/, '');
}

/** `## x` → `#### x` for `by = 2`; fenced code is left alone. */
export function demoteHeadings(markdown, by = 1) {
  const extra = '#'.repeat(by);
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      if (!inFence && /^#{1,6}\s/.test(line)) return extra + line;
      return line;
    })
    .join('\n');
}

/** The frontmatter block and the body of a frontmatter-first markdown document. */
export function splitFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return undefined;
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/** A top-level scalar from the frontmatter (`key: value`, quotes removed). */
export function frontmatterField(frontmatter, key) {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return undefined;
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, '$1');
}

/**
 * The problems with a rendered SKILL.md — empty when it may ship. Every rule here is one
 * the plugin's marketplace listing depends on, and each has a mutant in the tests.
 */
export function validateSkill(text) {
  const problems = [];
  const parts = splitFrontmatter(text);
  if (parts === undefined) return ['SKILL.md must start with a --- frontmatter block (the store header must be stripped)'];
  const name = frontmatterField(parts.frontmatter, 'name');
  const description = frontmatterField(parts.frontmatter, 'description');
  const license = frontmatterField(parts.frontmatter, 'license');
  if (name !== SKILL_NAME) problems.push(`frontmatter name must be "${SKILL_NAME}", got "${name}"`);
  if (description === undefined || description === '') problems.push('frontmatter description is missing');
  else {
    if (description.length > DESCRIPTION_MAX_CHARS) problems.push(`description is ${description.length} chars; the cap is ${DESCRIPTION_MAX_CHARS}`);
    for (const word of TRIGGER_WORDS) {
      if (!new RegExp(`\\b${word}\\b`, 'i').test(description)) problems.push(`description does not name "${word}" — the ask it must trigger on`);
    }
    if (!/snug/i.test(description)) problems.push('description does not say Snug');
  }
  if (license !== 'MIT') problems.push(`frontmatter license must be MIT, got "${license}"`);
  if (text.includes(LAUNCH_MARKER)) problems.push('the launch-protocol marker was not replaced');
  if (/\{\{[^{}]+\}\}/.test(parts.body)) problems.push('the body carries an unrendered {{placeholder}}');
  if (parts.body.split('\n').length > 500) problems.push('the body is over 500 lines (skill-creator: add a layer instead)');
  if (/built on MCP|MCP server/i.test(parts.body.replace(/never .*$/gim, ''))) problems.push('the body describes Snug through MCP outside the never-list (ADR-0061)');
  return problems;
}

/**
 * Render SKILL.md from its two sources. Throws with every problem named, so a build never
 * emits a skill the gate would refuse.
 */
export function renderSkill({ source, instructions }) {
  const body = stripStoreHeader(source);
  if (!body.includes(LAUNCH_MARKER)) throw new Error(`the skill source has no ${LAUNCH_MARKER}`);
  // The instructions are the process's OWN text; under the skill's H3 they sit at H4.
  const launch = demoteHeadings(instructions.trim(), 2);
  const text = body.replace(LAUNCH_MARKER, launch);
  const problems = validateSkill(text);
  if (problems.length > 0) throw new Error(`SKILL.md cannot ship:\n  - ${problems.join('\n  - ')}`);
  return text;
}

/**
 * The references: one file per KB section, named as in the store, text as the knowledge
 * package renders it (header stripped, placeholders resolved). Headings are preserved by
 * construction — they are retrieval-load-bearing (ADR-0004) and the tests pin them.
 */
export function renderReferences(knowledgeBase) {
  return knowledgeBase.map((section) => ({ name: path.posix.basename(section.file), text: section.text }));
}

/** The knowledge package's own rendering of the KB, from its BUILT dist. */
export async function loadKnowledgeBase(dist = KNOWLEDGE_DIST) {
  const mod = await import(pathToFileURL(dist).href);
  return mod.getKnowledgeBase();
}

/**
 * Every file of the skill tree, keyed by path relative to `skills/snug/`. Pure once the
 * inputs are read; `buildSkillTree()` with no arguments reads the real sources.
 */
export async function buildSkillTree(inputs = {}) {
  const source = inputs.source ?? readFileSync(SKILL_SOURCE, 'utf8');
  const instructions = inputs.instructions ?? readFileSync(INSTRUCTIONS_SOURCE, 'utf8');
  const knowledgeBase = inputs.knowledgeBase ?? (await loadKnowledgeBase());
  const files = { 'SKILL.md': renderSkill({ source, instructions }) };
  for (const { name, text } of renderReferences(knowledgeBase)) files[`references/${name}`] = text;
  return files;
}
