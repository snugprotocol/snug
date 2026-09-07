// chips.ts — the suggestion chips and the build-prompt template both come from the
// knowledge store's ui layer (prompts/ui/build-app-prompt.md) — no prompt literals in
// app code (ADR-0004). The renderer leaves {{appIdea}} as a runtime placeholder for us.

import { getUiPrompt, type KnowledgeDelivery } from '@snugprotocol/knowledge';

/**
 * One user-message template per knowledge delivery (ADR-0066): the tooled one tells the
 * model to use the app-builder tool FIRST; the inline one points at the rules the system
 * prompt now carries; the unaided one says there is no knowledge base. Each must describe
 * ONLY what its system slot actually carries — the Gate-5 review found the inline wording
 * sent to webllm, whose system slot disclaims the knowledge base. The view picks by
 * `knowledgeDeliveryFor(brain)`, the same derivation the system slot uses.
 *
 * Headings are matched as whole lines (CRLF-tolerant), and a missing section THROWS: an
 * empty template would ride the wire as an empty message that `useBuilderChat.send` drops
 * silently — the "silently thinner prompt" failure this task exists to remove.
 */
const TEMPLATE_HEADINGS: Readonly<Record<KnowledgeDelivery, RegExp>> = {
  tool: /^## User Message Template \(tool\)[ \t]*\r?$/m,
  inline: /^## User Message Template \(inline\)[ \t]*\r?$/m,
  none: /^## User Message Template \(unaided\)[ \t]*\r?$/m,
};
const CHIPS_HEADING_RE = /^## DATA: Suggestion Chips/m;
const RUNTIME_PLACEHOLDER = '{{appIdea}}';

export interface BuildPrompt {
  /** The user-message templates, {{appIdea}} still unresolved, one per knowledge delivery. */
  templates: Readonly<Record<KnowledgeDelivery, string>>;
  /** The one-tap suggestion chips, in document order. */
  chips: string[];
}

function sectionAfter(source: string, heading: RegExp): string {
  const match = heading.exec(source);
  if (match === null) throw new Error(`build-app-prompt.md: the section ${heading.source} is missing from the ui prompt`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const section = (next === -1 ? rest : rest.slice(0, next)).trim();
  if (!section.includes(RUNTIME_PLACEHOLDER)) throw new Error(`build-app-prompt.md: the section ${heading.source} carries no ${RUNTIME_PLACEHOLDER} placeholder`);
  return section;
}

export function parseBuildPrompt(source: string = getUiPrompt('build-app-prompt')): BuildPrompt {
  const templates = {
    tool: sectionAfter(source, TEMPLATE_HEADINGS.tool),
    inline: sectionAfter(source, TEMPLATE_HEADINGS.inline),
    none: sectionAfter(source, TEMPLATE_HEADINGS.none),
  };
  const chipsMatch = CHIPS_HEADING_RE.exec(source);
  const chipsBlock = chipsMatch === null ? '' : source.slice(chipsMatch.index);
  const chips = chipsBlock
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((chip) => chip !== '');
  return { templates, chips };
}

/** Fill {{appIdea}} with what the user typed (or tapped) into the template for this delivery. */
export function buildUserMessage(appIdea: string, template: string): string {
  return template.split(RUNTIME_PLACEHOLDER).join(appIdea);
}
