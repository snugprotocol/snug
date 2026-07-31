// assemble.ts — prompt pipelines: host system prompt and skill-builder prompt.
// Golden snapshot tests lock both assemblies so any edit shows its blast radius.

import {
  getKnowledgeSummary,
  getSkillBuilderPreamble,
  getSkillCreatorFile,
  getSkillMode,
  getSystemLayer,
} from './layers.js';

const SEPARATOR = '\n\n---\n\n';

export interface HostSystemPromptOptions {
  /** Include the app-builder layers (30-summary + 40-response-format). */
  appBuilder: boolean;
  /** Include the file-creation capability layer (20-capability-file-creation). */
  artifacts: boolean;
}

/**
 * Assemble the host system prompt: system layers joined in numeric file order.
 * 10-host-identity is unconditional; 20 gates on `artifacts`; 30 + 40 gate on
 * `appBuilder` (ancestor triple-gate pattern, simplified to config). The KB summary
 * (knowledge-base/app-authoring/00-summary.md) is appended DIRECTLY beneath the
 * 30-app-builder-summary layer so that layer's "summary below" sentence is true.
 */
export function buildHostSystemPrompt(opts: HostSystemPromptOptions): string {
  const layers: string[] = [getSystemLayer('host-identity')];
  if (opts.artifacts) layers.push(getSystemLayer('capability-file-creation'));
  if (opts.appBuilder) {
    layers.push(
      `${getSystemLayer('app-builder-summary').trimEnd()}\n\n${getKnowledgeSummary()}`,
      getSystemLayer('app-response-format'),
    );
  }
  return layers.join(SEPARATOR);
}

export interface SkillBuilderContext {
  /** Slug of the skill being created/edited. */
  slug?: string;
  /** Current SKILL.md content when editing an existing skill. */
  existingSkillMd?: string;
}

/**
 * Assemble the skill-builder prompt: Snug preamble → vendored skill-creator SKILL.md
 * (verbatim) → per-mode tail → optional current-skill context block.
 */
export function buildSkillBuilderPrompt(mode: string, ctx?: SkillBuilderContext): string {
  const parts: string[] = [
    getSkillBuilderPreamble(),
    getSkillCreatorFile('SKILL.md'),
    getSkillMode(mode),
  ];
  if (ctx !== undefined && (ctx.slug !== undefined || ctx.existingSkillMd !== undefined)) {
    const block: string[] = ['## Current skill'];
    if (ctx.slug !== undefined) block.push('', `Slug: \`${ctx.slug}\``);
    if (ctx.existingSkillMd !== undefined) {
      block.push('', 'Existing SKILL.md:', '', '<existing-skill-md>', ctx.existingSkillMd, '</existing-skill-md>');
    }
    parts.push(block.join('\n'));
  }
  return parts.join(SEPARATOR);
}
