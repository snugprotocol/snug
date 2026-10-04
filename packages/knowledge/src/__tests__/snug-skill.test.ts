// The Snug skill's own words (TASK-20261003 R4, R5; ADR-0071, ADR-0072, ADR-0069 §7).
//
// `prompts/skills/snug/SKILL.md` is what an agent that installed the plugin reads before it
// builds anything. It is excluded from `content.ts` by name, so no accessor serves it: these
// tests read the source on disk, as `scripts/lib/skill-build.mjs` does when it renders the
// skill into the plugin.
//
// What they hold is what the skill says about the BRAIN and about WHERE IT RUNS. Until the
// brain registry the thinks on the local runner ran on one thing, the user's own Claude CLI;
// they now run on the user's own agent CLI — Claude by default, another agent only by the
// user's own pin — and a skill that still names Claude alone has an agent tell a Codex user
// something false about where their app's data goes. And the runner is picked by SURFACE
// (R5, D6): measured 2026-10-03, a claude.ai chat artifact is the same artifact a tool
// publishes — the same 0.2.67 page wrapper, the same `sample`/`artifact`/`downloads` — so chat
// takes the artifact runner's recipe, and the chat-only delivery planned before that
// measurement (a script build, an npm bootstrap, `window.claude.complete`) was never built (C5).
//
// (The launch protocol the skill splices in — `apps/host-mcp/src/instructions.md` — is pinned
// by `scripts/check-host-mcp.test.mjs`, beside the byte-compare of the bundle that carries it.)
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { promptFilesOnDisk, repoRoot } from './helpers.js';

const SKILL_FILE = 'skills/snug/SKILL.md';

function skillSource(): string {
  const file = promptFilesOnDisk().find((entry) => entry.rel === SKILL_FILE);
  if (file === undefined) throw new Error(`${SKILL_FILE} is not in the prompt store`);
  return file.content;
}

/** The text as sentences: its lines are wrapped, and a claim must not hide across a line break. */
const said = (text: string): string => text.replace(/\s+/g, ' ');

/** The numbered rows under "## Find or start the runner": each row's bold surface, and what it says to do there. */
function routingRows(): { surface: string; body: string }[] {
  const block = said(skillSource()).split('## Find or start the runner')[1]?.split('### The local runner')[0] ?? '';
  return [...block.matchAll(/\d\. \*\*(.+?)\*\* — (.+?)(?= \d\. \*\*|$)/g)].map((match) => ({
    surface: match[1] ?? '',
    body: (match[2] ?? '').trim(),
  }));
}

describe('the Snug skill says what ANSWERS an app’s thinks (ADR-0071)', () => {
  it('the local runner’s thinks run on the user’s own agent CLI — Claude by default', () => {
    // MIGRATED (R5, D6): this read the text between 'the local runner. Follow' and the old
    // second row, '2. **No Snug tools'. The rows are surfaces now; the claim is unchanged.
    const localRunner = routingRows()[0]?.body ?? '';
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

describe('the Snug skill picks the runner by SURFACE (R5: C5, D6)', () => {
  it('has four rows, and the two plugin-surface rows come before the artifact row', () => {
    // Claude Code has an Artifact tool of its own: were the artifact row first, a terminal
    // session would publish an artifact instead of opening the user's own file.
    expect(routingRows()).toHaveLength(4);
  });

  it('row 1 — Claude Code (a terminal, or Claude Desktop’s Code tab) and Claude Desktop’s Cowork tab, with the Snug tools → the local runner', () => {
    const { surface, body } = routingRows()[0] ?? { surface: '', body: '' };
    expect(surface).toMatch(/Claude Code/);
    expect(surface).toMatch(/Claude Desktop's Code tab/);
    expect(surface).toMatch(/Cowork tab/);
    for (const tool of ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps']) expect(surface).toContain(`\`${tool}\``);
    expect(body).toMatch(/^the local runner\. Follow \*The local runner\* below\./);
  });

  it('row 2 — the same surfaces with NO Snug tools → one line, the launcher’s own Node sentence, then stop', () => {
    // A plugin surface shows no Snug tools only when the launcher found no usable Node: every
    // failure after Node is found still answers the handshake, with a refusal (R1, L2). The
    // line is the launcher's own, so the skill and the process cannot tell the user two things.
    const { surface, body } = routingRows()[1] ?? { surface: '', body: '' };
    expect(surface).toMatch(/Claude Code or Cowork/);
    expect(surface).toMatch(/none of the Snug tools/);
    const launcher = readFileSync(path.join(repoRoot, 'scripts', 'lib', 'plugin-launcher.mjs'), 'utf8');
    const major = /export const NODE_MIN_MAJOR = (\d+);/.exec(launcher)?.[1];
    const install = /"Snug needs Node\.js \$\{minMajor\} or newer and could not find one\. (Install it from [^"]+)"/.exec(launcher)?.[1];
    expect(major, 'the launcher no longer exports NODE_MIN_MAJOR').toBeDefined();
    expect(install, 'the launcher no longer prints its Node sentence').toBeDefined();
    expect(body).toContain(`"Snug needs Node.js ${major} or newer. ${install}"`);
    expect(body).toMatch(/Then stop\.$/);
    expect(body).not.toMatch(/artifact/i);
  });

  it('row 3 — claude.ai chat and Claude Desktop’s chat tab → the artifact runner, the same recipe as any artifact', () => {
    const { surface, body } = routingRows()[2] ?? { surface: '', body: '' };
    expect(surface).toMatch(/claude\.ai chat/);
    expect(surface).toMatch(/Claude Desktop's chat tab/);
    // Kept from the tool-based routing it replaces: an unnamed surface that publishes artifacts
    // still gets the artifact runner (rows 1–2 catch Claude Code, which has an Artifact tool too).
    expect(surface).toMatch(/any other surface whose `Artifact` tool takes `capabilities`/);
    expect(body).toMatch(/^the artifact runner\. Follow \*The artifact runner\* below\./);
    expect(body).toMatch(/A chat artifact is the same artifact a tool publishes/);
  });

  it('row 4 — anywhere else → how to get the plugin, then stop', () => {
    const { surface, body } = routingRows()[3] ?? { surface: '', body: '' };
    expect(surface).toMatch(/^Anywhere else$/);
    expect(body).toMatch(/\*No runner\*/);
    expect(body).toMatch(/and stop\./);
    const noRunner = said(skillSource()).split('### No runner')[1]?.split('## Build the app')[0] ?? '';
    expect(noRunner).toContain('/plugin install snug@snug-skill');
  });

  it('the artifact runner publishes the skill’s OWN page as a file, with sample, artifact and downloads, and hands in by snug-embed and a republish', () => {
    const recipe = said(skillSource()).split('### The artifact runner')[1]?.split('### No runner')[0] ?? '';
    expect(recipe).toContain('publish `assets/snug-host.html` from this skill');
    expect(recipe).toContain('`capabilities: { sample: {}, artifact: {}, downloads: true }`');
    // The page is megabytes: an agent cannot retype it, and a retyped page is not this skill's page.
    expect(recipe).toMatch(/Publish the file itself — never retype or paste its contents\./);
    expect(recipe).toContain('run `node scripts/snug-embed.mjs <page.html> --bundle <app.json> --out <page.html>`, then publish the result to the same artifact');
  });

  it('names the artifact’s icon as the Artifact tool takes it — one short generic word — never the deprecated favicon', () => {
    // R5 review: the recipe said "favicon 🔥"; the tool now takes `icon` ("one short generic
    // word … never a product or brand name") and calls `favicon` deprecated.
    const recipe = said(skillSource()).split('### The artifact runner')[1]?.split('### No runner')[0] ?? '';
    expect(recipe).toContain('titled `Snug`, icon `app`,');
    expect(said(skillSource())).not.toMatch(/favicon/i);
  });

  it('routes chat to nothing that was not built — no chat-only runtime, script build, npm bootstrap or `window.claude.complete` (C5)', () => {
    const instructions = readFileSync(path.join(repoRoot, 'apps', 'host-mcp', 'src', 'instructions.md'), 'utf8');
    for (const [name, text] of [['SKILL.md', said(skillSource())], ['instructions.md', said(instructions)]] as const) {
      expect(text, name).not.toMatch(/window\.claude|\.complete\b/);
      expect(text, name).not.toMatch(/snug-host\.js|@snugprotocol\/host|jsdelivr|cdnjs|unpkg/i);
      expect(text, name).not.toMatch(/bootstrap|\bnpm\b/i);
      expect(text, name).not.toMatch(/chat runner|chat-only|chat runtime/i);
    }
  });

  it('describes where the apps run truthfully on every surface it routes — chat included', () => {
    const never = said(skillSource()).split('## Never')[1] ?? '';
    expect(never).toMatch(/Say: Snug apps run inside Claude Code, Cowork, or an artifact in chat\./);
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
