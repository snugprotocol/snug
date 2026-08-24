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

// --- centralization lint (ADR-0004) primitives -------------------------------
// Shared so `centralization-lint-marker.test.ts` can pin PROMPT_MARKER's behaviour
// against the REAL value rather than a retyped copy (a fence that restates its data
// cannot test it -- lessons.md 2026-08-13).

export const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Markers that suggest a literal is LLM-bound.
 *
 * `You are` is ANCHORED; the other three are not. It is the only marker that occurs in
 * ordinary second-person prose -- `apps/playground/src/legal/eula.ts` says "the version
 * you are running" in the DMG license text, which is not a prompt and must not trip this
 * lint (the string's only consumers are the Settings->about screen and the byte-pinned
 * DMG SLA resource).
 *
 * The anchor class is [\n`] and NOT bare \n on purpose: `TEMPLATE_LITERAL` matches
 * include the surrounding backticks, so a system prompt written the natural way --
 * `You are Snug, ...` -- carries its marker at index 1, neither at ^ nor after a newline.
 * A \n-only anchor would clear the EULA and silently stop catching real prompts.
 *
 * `\b` keeps "You aren't" from matching.
 */
export const PROMPT_MARKER = /(?:^|[\n`])\s*(?:You are\b)|MUST respond|CRITICAL|system prompt/i;

export const MAX_LITERAL_CHARS = 400;

// Handles escaped backticks; nested ${`...`} interpolation is beyond the heuristic.
// Used only via String.prototype.match, which resets lastIndex despite the /g flag.
export const TEMPLATE_LITERAL = /`(?:[^`\\]|\\[\s\S])*`/g;

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
    ['app-runtime', 'system/45-app-runtime.md'],
    ['app-response-format', 'system/40-app-response-format.md'],
    ['platform-desktop', 'system/95-platform-desktop.md'],
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
