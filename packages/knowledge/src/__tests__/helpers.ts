// Test-only helpers. Node fs is allowed HERE (codegen/test layer) — never in src/ proper.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getKnowledgeBase,
  getKnowledgeSummary,
  getSkillBuilderPreamble,
  getSystemLayer,
  getToolPrompt,
  getUiPrompt,
  getUserIdentityTemplate,
  listSkillModes,
  getSkillMode,
  type SystemLayerName,
  type ToolPromptName,
} from '../index.js';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRoot = path.resolve(packageRoot, '..', '..');
export const promptsDir = path.join(packageRoot, 'prompts');
export const generatedDir = path.join(packageRoot, 'src', 'generated');

export const SKILL_CREATOR_PREFIX = 'skills/skill-creator/';

/** Recursively list absolute file paths under dir (sorted). */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

export interface DiskPromptFile {
  /** Posix path relative to prompts/. */
  rel: string;
  abs: string;
  content: string;
}

/** All files under prompts/ on disk. Throws (failing the test) when the store is absent. */
export function promptFilesOnDisk(): DiskPromptFile[] {
  if (!existsSync(promptsDir)) {
    throw new Error(
      `prompts/ does not exist at ${promptsDir} — the prompt store has not been written yet ` +
        '(expected while workstreams A/B are still in flight; the integrator runs the full suite).',
    );
  }
  return walkFiles(promptsDir).map((abs) => ({
    rel: path.relative(promptsDir, abs).split(path.sep).join('/'),
    abs,
    content: readFileSync(abs, 'utf8'),
  }));
}

export function isVendored(rel: string): boolean {
  return rel.startsWith(SKILL_CREATOR_PREFIX);
}

export interface RenderedStoreEntry {
  /** Posix path relative to prompts/ ('' only for synthesized text with no single file). */
  file: string;
  text: string;
}

/**
 * Every RENDERED (non-vendored) text the package serves, tagged with its source file.
 * Data-driven where the layer is data-driven (KB files, skill modes).
 */
export function renderedStore(): RenderedStoreEntry[] {
  const systemLayers: [SystemLayerName, string][] = [
    ['host-identity', 'system/10-host-identity.md'],
    ['capability-file-creation', 'system/20-capability-file-creation.md'],
    ['app-builder-summary', 'system/30-app-builder-summary.md'],
    ['app-response-format', 'system/40-app-response-format.md'],
  ];
  const toolNames: ToolPromptName[] = ['app-builder', 'artifact-write', 'auth-spec-inferrer'];

  const entries: RenderedStoreEntry[] = [];
  for (const [name, file] of systemLayers) entries.push({ file, text: getSystemLayer(name) });
  for (const section of getKnowledgeBase()) entries.push({ file: section.file, text: section.text });
  // 00-summary.md is excluded from getKnowledgeBase() (search corpus) but still rendered.
  entries.push({ file: 'knowledge-base/app-authoring/00-summary.md', text: getKnowledgeSummary() });
  for (const name of toolNames) entries.push({ file: `tools/${name}.md`, text: getToolPrompt(name) });
  entries.push({ file: 'ui/build-app-prompt.md', text: getUiPrompt('build-app-prompt') });
  entries.push({ file: 'skills/builder-preamble.md', text: getSkillBuilderPreamble() });
  for (const mode of listSkillModes()) {
    entries.push({ file: `skills/modes/${mode}.md`, text: getSkillMode(mode) });
  }
  // Raw (unrendered) template — still part of the store the repo ships to LLM pipelines.
  entries.push({ file: 'templates/user-identity.md', text: getUserIdentityTemplate() });
  return entries;
}
