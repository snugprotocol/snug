// @snugprotocol/knowledge — the central layered prompt store (ADR-0004).
// Every LLM-bound prompt lives under prompts/**; this package exposes typed per-layer
// accessors with protocol constants injected from @snugprotocol/protocol. Browser-safe:
// content is inlined at build time by scripts/gen-content.mjs — no runtime fs.

export { APP_BUILDER_TOOL_NAME, renderPrompt } from './render.js';

export {
  getKnowledgeBase,
  getKnowledgeSummary,
  getSkillBuilderPreamble,
  getSkillCreatorFile,
  getSkillMode,
  getSystemLayer,
  getToolPrompt,
  getUiPrompt,
  getUserIdentityTemplate,
  listSkillCreatorFiles,
  listSkillModes,
  type KnowledgeSection,
  type SystemLayerName,
  type ToolPromptName,
  type UiPromptName,
} from './layers.js';

export {
  buildHostSystemPrompt,
  buildSkillBuilderPrompt,
  type HostSystemPromptOptions,
  type SkillBuilderContext,
} from './assemble.js';

export { searchKnowledge, type KnowledgeSearchResult } from './search.js';
