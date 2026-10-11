// kitDeadPromptsSmoke.test.ts — every prompt the kit can assemble still assembles when the store
// is the kit's CUT store (TASK-20261010-host-broker PR-3; `kitDeadPrompts.test.ts` pins the rule,
// the plugin and the wiring). The knowledge package's content module is replaced here by exactly
// what `dropPromptFiles` leaves in the page, so a loader that reads a dropped file throws its
// "not in the generated store" error in THIS file instead of in a user's kit.
//
// The kit reaches the store through: the host system prompt (all three knowledge deliveries,
// the runtime branch, both platforms), every tool description (the DEMO brain builds the full
// tool list against the mock adapter), the knowledge base and its search, the inline core and
// the summary, the ui and template layers, and the four dedicated-turn assemblers.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../packages/knowledge/dist/generated/content.js', async (importOriginal) => {
  const real = (await importOriginal()) as { PROMPT_FILES: Record<string, string> };
  const { filterPromptFiles } = (await import('../plugins/drop-prompt-files.js')) as {
    filterPromptFiles: (files: Readonly<Record<string, string>>) => { kept: Record<string, string>; dropped: string[] };
  };
  return { PROMPT_FILES: filterPromptFiles(real.PROMPT_FILES).kept };
});

import * as knowledge from '@snugprotocol/knowledge';

const TOOL_PROMPTS = [
  'app-builder',
  'artifact-write',
  'schema-apply',
  'app-doc-write',
  'auth-spec-inferrer',
  'connection-requirement-inferrer',
  'runtime-contract-write',
  'runtime-contract-synthesis',
  'chat-intent-classifier',
  'data-query',
  'data-propose-write',
  'provider-request',
  'present-card',
  'artifact-edit',
  'schedule-propose',
  'access-propose',
] as const satisfies readonly knowledge.ToolPromptName[];

describe('the kit runs on the cut store', () => {
  it('the mock really is the cut store: a skill loader now throws, by name', () => {
    expect(() => knowledge.getSkillCreatorFile('SKILL.md')).toThrow(/Unknown vendored skill-creator file/);
    expect(() => knowledge.getSkillBuilderPreamble()).toThrow(/not in the generated store/);
    expect(knowledge.listSkillModes()).toEqual([]);
  });

  it('assembles the host system prompt for every delivery, the runtime branch and both platforms', () => {
    for (const platform of ['web', 'desktop'] as const) {
      for (const knowledgeDelivery of ['tool', 'inline', 'none'] as const) {
        // A tool-free delivery refuses the artifacts layer by design (assemble.ts), whatever the store.
        for (const artifacts of knowledgeDelivery === 'tool' ? [true, false] : [false]) {
          const prompt = knowledge.buildHostSystemPrompt({ appBuilder: true, artifacts, knowledge: knowledgeDelivery, platform });
          expect(prompt.length, `${platform}/${knowledgeDelivery}/${artifacts}`).toBeGreaterThan(500);
        }
      }
      expect(knowledge.buildHostSystemPrompt({ appBuilder: false, artifacts: true, platform }).length).toBeGreaterThan(100);
      expect(knowledge.buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true, platform }).length).toBeGreaterThan(100);
    }
  });

  it('renders every tool description the demo brain or any lane can build', () => {
    for (const name of TOOL_PROMPTS) expect(knowledge.getToolPrompt(name).length, name).toBeGreaterThan(50);
  });

  it('serves the knowledge base, its search, the inline core and the summary', () => {
    expect(knowledge.getKnowledgeBase().length).toBeGreaterThan(5);
    expect(knowledge.searchKnowledge('persistence').length).toBeGreaterThan(0);
    expect(knowledge.getInlineKnowledgeCore().length).toBe(knowledge.INLINE_KNOWLEDGE_CORE_FILES.length);
    expect(knowledge.getKnowledgeSummary().length).toBeGreaterThan(100);
  });

  it('serves the ui and template layers', () => {
    expect(knowledge.getUiPrompt('build-app-prompt').length).toBeGreaterThan(100);
    expect(knowledge.getUserIdentityTemplate().length).toBeGreaterThan(50);
  });

  it('builds the four dedicated turns: the classifier, the two inferrers and the contract synthesis', () => {
    const classifier = knowledge.buildChatIntentClassifierPrompt({ message: 'add a row', appName: 'Ledger' } as never);
    expect(classifier.system.length).toBeGreaterThan(100);
    const inferrer = knowledge.buildConnectionRequirementInferrerPrompt({ providerName: 'Example' } as never);
    expect(inferrer.system.length).toBeGreaterThan(100);
    const legacy = knowledge.buildAuthSpecInferrerPrompt({ providerName: 'Example' });
    expect(legacy.system.length).toBeGreaterThan(100);
    const synthesis = knowledge.buildRuntimeContractSynthesisPrompt({ html: '<!doctype html><title>x</title>' } as never);
    expect(synthesis.system.length).toBeGreaterThan(100);
  });
});
