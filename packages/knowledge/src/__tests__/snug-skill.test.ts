// The Snug skill's own words (TASK-20261003 R4; ADR-0071, ADR-0069 §7).
//
// `prompts/skills/snug/SKILL.md` is what an agent that installed the plugin reads before it
// builds anything. It is excluded from `content.ts` by name, so no accessor serves it: these
// tests read the source on disk, as `scripts/lib/skill-build.mjs` does when it renders the
// skill into the plugin.
//
// What they hold is what the skill says about the BRAIN. Until the brain registry the thinks
// on the local runner ran on one thing, the user's own Claude CLI, and the skill said so in
// two places. They now run on the user's own agent CLI — Claude by default, another agent
// only by the user's own pin — and a skill that still names Claude alone has an agent tell a
// Codex user something false about where their app's data goes.
//
// (The launch protocol the skill splices in — `apps/host-mcp/src/instructions.md` — is pinned
// by `scripts/check-host-mcp.test.mjs`, beside the byte-compare of the bundle that carries it.)
import { describe, expect, it } from 'vitest';

import { promptFilesOnDisk } from './helpers.js';

const SKILL_FILE = 'skills/snug/SKILL.md';

function skillSource(): string {
  const file = promptFilesOnDisk().find((entry) => entry.rel === SKILL_FILE);
  if (file === undefined) throw new Error(`${SKILL_FILE} is not in the prompt store`);
  return file.content;
}

/** The text as sentences: its lines are wrapped, and a claim must not hide across a line break. */
const said = (text: string): string => text.replace(/\s+/g, ' ');

describe('the Snug skill says what ANSWERS an app’s thinks (ADR-0071)', () => {
  it('the local runner’s thinks run on the user’s own agent CLI — Claude by default', () => {
    const localRunner = said(skillSource()).split('the local runner. Follow')[1]?.split('2. **No Snug tools')[0] ?? '';
    expect(localRunner).toMatch(/thinks run on the user's own agent CLI — Claude by default\./);
  });

  it('nowhere says the brain is the user’s "Claude CLI"', () => {
    expect(said(skillSource())).not.toMatch(/Claude CLI/);
  });

  it('keeps the rule that the agent never runs a model itself — and names `codex` beside `claude`', () => {
    const never = said(skillSource()).split('## Never')[1] ?? '';
    expect(never).toMatch(/- Never run `claude`, `codex` or any model yourself to answer an app's think\. The runner does that, on the user's own agent CLI\./);
  });

  it('still says an artifact’s thinks run on the VIEWER’s own Claude — that binding has one brain', () => {
    // Binding A is the artifact runtime's `sample`: there is no registry and no other agent
    // there, so the rewording must not have reached it.
    expect(said(skillSource())).toMatch(/the artifact runner\. Follow \*The artifact runner\* below\. Apps think on the viewer's own Claude/);
  });
});

describe('the Snug skill leaves the hand-in’s answers to the launch protocol', () => {
  it('has exactly one launch-protocol marker for the build to replace', () => {
    expect(skillSource().split('<!-- launch-protocol -->').length - 1).toBe(1);
  });

  it('restates neither the answers nor the deleted-app rule: one source, so the two cannot drift', () => {
    // `snug_hand_in`'s answers and "a hand-in installs a deleted app again" are true of the
    // LOCAL runner only, and are said by the text spliced in under that heading.
    const text = said(skillSource());
    expect(text).not.toMatch(/not confirmed/);
    expect(text).not.toMatch(/deleted/);
    expect(text).not.toMatch(/never restores/);
  });
});

describe('the Snug skill keeps its shape', () => {
  it('carries the store header, then the frontmatter the skill ships with', () => {
    const source = skillSource();
    expect(source.startsWith('<!--\nlayer: skill\n')).toBe(true);
    expect(source.slice(source.indexOf('-->') + '-->'.length)).toMatch(/^\n---\nname: snug\n/);
  });
});
