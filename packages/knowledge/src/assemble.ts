// assemble.ts — prompt pipelines: host system prompt and skill-builder prompt.
// Golden snapshot tests lock both assemblies so any edit shows its blast radius.

import {
  getKnowledgeSummary,
  getSkillBuilderPreamble,
  getSkillCreatorFile,
  getSkillMode,
  getSystemLayer,
  getToolPrompt,
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

// ---------------------------------------------------------------------------
// Auth-spec-inferrer prompt (AL-04 plan D8) — the dedicated inference turn.
// ---------------------------------------------------------------------------

export interface AuthSpecInferrerPromptInput {
  /** Provider display name — echoed into the user slot, never into the system slot. */
  providerName: string;
  /** Optional auth-kind hint from the user/caller. */
  kindHint?: string;
  /** UNTRUSTED pasted provider docs. Rides ONLY inside the delimited data block. */
  docsText?: string;
}

export interface AuthSpecInferrerPrompt {
  /** Trusted instruction sections (task, rules, few-shot, output contract) — AdapterRequest.system (D2). */
  system: string;
  /** The runtime data block: provider identity + delimited <provider_docs> — the single user message (D2). */
  user: string;
}

/**
 * Neutralize a delimiter breakout inside pasted docs: a literal `</provider_docs>`
 * (or opening variant) in the untrusted text must not terminate the data block the
 * system prompt's DATA-framing rule points at. Prompt-side hardening only — the
 * real walls are the host-side schema/registry/review (D8: injection resistance is
 * layered, prompt-last).
 */
function defangProviderDocs(text: string): string {
  return text.replace(/<(\/?provider_docs)/gi, '‹$1');
}

/**
 * Build the two wire slots of the inference turn (D2 placement pin): the SYSTEM slot
 * is the statically rendered tools/auth-spec-inferrer.md — runtime values never enter
 * it — and the USER slot carries the provider identity plus the delimited untrusted
 * docs block. The caller (playground adapter layer) sends them as
 * `AdapterRequest.system` and the single user message respectively; packages/auth
 * receives only the finished strings (its dep surface cannot include this package).
 */
export function buildAuthSpecInferrerPrompt(input: AuthSpecInferrerPromptInput): AuthSpecInferrerPrompt {
  return buildInferrerPromptFor('auth-spec-inferrer', input);
}

/**
 * Dynamic Auth v2 (TASK-20260810-p2-pipeline, R2): the same two-slot placement, aimed at
 * the FULL-requirement prompt. The v3 builder above keeps shipping under the B1 cutover
 * rule; its removal is P4's named exit item.
 *
 * The SLOT SPLIT IS THE POINT and is unchanged: trusted instructions in `system`,
 * untrusted pasted docs inside a delimited block in `user`. There is no credential seat
 * in either — inference runs at BUILD time, before any credential exists (C1).
 */
export function buildConnectionRequirementInferrerPrompt(
  input: AuthSpecInferrerPromptInput,
): AuthSpecInferrerPrompt {
  return buildInferrerPromptFor('connection-requirement-inferrer', input);
}

function buildInferrerPromptFor(
  tool: 'auth-spec-inferrer' | 'connection-requirement-inferrer',
  input: AuthSpecInferrerPromptInput,
): AuthSpecInferrerPrompt {
  const system = getToolPrompt(tool);
  const docs =
    input.docsText !== undefined && input.docsText.trim().length > 0
      ? defangProviderDocs(input.docsText)
      : '(no documentation was pasted — answer from your own knowledge of this provider, or refuse honestly as in Example 3)';
  const user = [
    `Provider name: ${input.providerName}`,
    `Kind hint: ${input.kindHint ?? '(none given — infer the kind)'}`,
    '',
    '<provider_docs>',
    docs,
    '</provider_docs>',
    '',
    'Reply with the JSON object only.',
  ].join('\n');
  return { system, user };
}
