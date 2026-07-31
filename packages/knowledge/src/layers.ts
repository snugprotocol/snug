// layers.ts — typed per-layer accessors over the generated prompt store.
//
// ADR-0004 doctrine: no generic string-keyed public API. Each layer gets its own typed
// accessor; protocol constants are injected at load time via render.ts. Browser-safe:
// content comes from the codegen'd module, never from the filesystem.

import { PROMPT_FILES } from './generated/content.js';
import { extractHeadings, stripPromptHeader } from './markdown.js';
import { renderPrompt } from './render.js';

function rawFile(path: string): string {
  const content = PROMPT_FILES[path];
  if (content === undefined) {
    throw new Error(
      `Prompt file "${path}" is not in the generated store. If it exists under prompts/, ` +
        'regenerate with `pnpm gen:content` (build runs it automatically).',
    );
  }
  return content;
}

/** Header stripped + placeholders rendered — the text that reaches an LLM. */
function renderedFile(path: string): string {
  return renderPrompt(stripPromptHeader(rawFile(path)));
}

function storePaths(prefix: string): string[] {
  return Object.keys(PROMPT_FILES)
    .filter((p) => p.startsWith(prefix))
    .sort();
}

// ---------------------------------------------------------------------------
// System layer — prompts/system/NN-*.md, numbered by injection order.
// ---------------------------------------------------------------------------

export type SystemLayerName =
  | 'host-identity'
  | 'capability-file-creation'
  | 'app-builder-summary'
  | 'app-response-format';

const SYSTEM_LAYER_FILES: Readonly<Record<SystemLayerName, string>> = {
  'host-identity': 'system/10-host-identity.md',
  'capability-file-creation': 'system/20-capability-file-creation.md',
  'app-builder-summary': 'system/30-app-builder-summary.md',
  'app-response-format': 'system/40-app-response-format.md',
};

export function getSystemLayer(name: SystemLayerName): string {
  return renderedFile(SYSTEM_LAYER_FILES[name]);
}

// ---------------------------------------------------------------------------
// Knowledge base — prompts/knowledge-base/app-authoring/*.md.
// Markdown ##/### structure is retrieval-load-bearing (section search splits on it).
// ---------------------------------------------------------------------------

const KB_PREFIX = 'knowledge-base/app-authoring/';

export interface KnowledgeSection {
  /** Posix path relative to prompts/. */
  file: string;
  /** Heading lines (levels 1–3) in document order — the retrieval skeleton. */
  headingTree: string[];
  /** Rendered text (header stripped, placeholders injected). */
  text: string;
}

function knowledgeFilePaths(): string[] {
  return storePaths(KB_PREFIX).filter((p) => p.endsWith('.md'));
}

/** Ordered (by filename) rendered KB sections. */
export function getKnowledgeBase(): KnowledgeSection[] {
  return knowledgeFilePaths().map((file) => {
    const text = renderedFile(file);
    return { file, headingTree: extractHeadings(text), text };
  });
}

/**
 * Compact KB summary for system-prompt injection alongside a section-search tool.
 * If the KB ships a dedicated summary/overview file (00-*summary*.md / 00-*overview*.md),
 * that rendered file wins; otherwise a deterministic section map (file + heading tree)
 * is generated so the model knows what it can search for.
 */
export function getKnowledgeSummary(): string {
  const authored = knowledgeFilePaths().find((p) =>
    /\/00-[^/]*(summary|overview|index)[^/]*\.md$/.test(p),
  );
  if (authored !== undefined) return renderedFile(authored);

  const lines: string[] = ['# App-authoring knowledge base — section map', ''];
  for (const section of getKnowledgeBase()) {
    lines.push(`## ${section.file}`, '');
    for (const heading of section.headingTree) lines.push(`- ${heading}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Tool prompts — prompts/tools/*.md.
// ---------------------------------------------------------------------------

export type ToolPromptName = 'app-builder' | 'artifact-write';

export function getToolPrompt(name: ToolPromptName): string {
  return renderedFile(`tools/${name}.md`);
}

// ---------------------------------------------------------------------------
// UI prompts — prompts/ui/*.md.
// ---------------------------------------------------------------------------

export type UiPromptName = 'build-app-prompt';

export function getUiPrompt(name: UiPromptName): string {
  return renderedFile(`ui/${name}.md`);
}

// ---------------------------------------------------------------------------
// Skills — builder preamble, mode tails, and the vendored Anthropic skill-creator.
// ---------------------------------------------------------------------------

export function getSkillBuilderPreamble(): string {
  return renderedFile('skills/builder-preamble.md');
}

const MODES_PREFIX = 'skills/modes/';

/** Mode names derived from prompts/skills/modes/*.md (data-driven — modes are content). */
export function listSkillModes(): string[] {
  return storePaths(MODES_PREFIX)
    .filter((p) => p.endsWith('.md'))
    .map((p) => p.slice(MODES_PREFIX.length, -'.md'.length));
}

export function getSkillMode(mode: string): string {
  const path = `${MODES_PREFIX}${mode}.md`;
  if (PROMPT_FILES[path] === undefined) {
    throw new Error(`Unknown skill mode "${mode}" — known modes: ${listSkillModes().join(', ')}`);
  }
  return renderedFile(path);
}

const SKILL_CREATOR_PREFIX = 'skills/skill-creator/';

/** Vendored skill-creator files (posix paths relative to skills/skill-creator/). */
export function listSkillCreatorFiles(): string[] {
  return storePaths(SKILL_CREATOR_PREFIX).map((p) => p.slice(SKILL_CREATOR_PREFIX.length));
}

/**
 * A vendored skill-creator file, VERBATIM — no header stripping, no rendering.
 * The vendored tree is commit-pinned upstream Anthropic content (Apache-2.0; see its
 * LICENSE.txt/NOTICE.md) and is checksum-locked by src/generated/skill-creator.sha256.json.
 */
export function getSkillCreatorFile(relPath: string): string {
  const content = PROMPT_FILES[`${SKILL_CREATOR_PREFIX}${relPath}`];
  if (content === undefined) {
    throw new Error(
      `Unknown vendored skill-creator file "${relPath}" — known: ${listSkillCreatorFiles().join(', ')}`,
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
// Templates — prompts/templates/*.md. Returned RAW (header stripped, NOT rendered):
// tenant/user data is runtime data rendered through them downstream (ADR-0004).
// ---------------------------------------------------------------------------

export function getUserIdentityTemplate(): string {
  return stripPromptHeader(rawFile('templates/user-identity.md'));
}
