// chips.ts — the suggestion chips and the build-prompt template both come from the
// knowledge store's ui layer (prompts/ui/build-app-prompt.md) — no prompt literals in
// app code (ADR-0004). The renderer leaves {{appIdea}} as a runtime placeholder for us.

import { getUiPrompt } from '@snugprotocol/knowledge';

const TEMPLATE_HEADING = '## User Message Template';
const CHIPS_HEADING_RE = /^## DATA: Suggestion Chips/m;
const RUNTIME_PLACEHOLDER = '{{appIdea}}';

export interface BuildPrompt {
  /** The user-message template with {{appIdea}} still unresolved. */
  template: string;
  /** The one-tap suggestion chips, in document order. */
  chips: string[];
}

function sectionAfter(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) return '';
  const rest = source.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function parseBuildPrompt(source: string = getUiPrompt('build-app-prompt')): BuildPrompt {
  const template = sectionAfter(source, TEMPLATE_HEADING);
  const chipsMatch = CHIPS_HEADING_RE.exec(source);
  const chipsBlock = chipsMatch === null ? '' : source.slice(chipsMatch.index);
  const chips = chipsBlock
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((chip) => chip !== '');
  return { template, chips };
}

/** Fill {{appIdea}} with what the user typed (or tapped). */
export function buildUserMessage(appIdea: string, prompt: BuildPrompt = parseBuildPrompt()): string {
  return prompt.template.split(RUNTIME_PLACEHOLDER).join(appIdea);
}
