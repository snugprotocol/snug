// kitDeadPrompts.test.ts — the prompt files no code ever reads are dropped from the kit page
// (TASK-20261010-host-broker PR-3, the owner's kit-ceiling decision 2026-10-11: "take the dead
// prompt files out only from the host kit" instead of raising KIT_SIZE_CEILING_BYTES).
//
// WHY THE CUT IS TRUE. `@snugprotocol/knowledge` ships every file under `prompts/` as ONE object
// (`PROMPT_FILES` in the generated content module), so a bundler cannot tree-shake a file no
// code reads. Two groups are read by nobody that ships in a page:
//   - `skills/**` — the skill-builder's preamble and modes and the vendored Anthropic
//     skill-creator (its SKILL.md, agents, Python scripts, HTML viewers, LICENSE, NOTICE):
//     read only through the six skill loaders, which no app, server, host or script calls;
//   - `README.md` — the prompt store's own map, a repo document no loader names.
// The kit filters them out of the content module at build time (`dropPromptFiles`), measured
// at −253,454 B. The playground and the desktop keep the whole store — they are not built from
// this config.
//
// WHAT THIS FILE PINS, so the cut cannot rot into a silent loss:
//   1. the rule drops exactly `skills/**` and `README.md` — over the REAL store, never a file
//      of the system, knowledge-base, tools, templates or ui layers;
//   2. the plugin rewrites only the content module, keeps the store's one export, and fails
//      the BUILD when it would cut nothing (a dead rule), when the module grows a second
//      export, or when the module is never seen;
//   3. the one kit config registers it on the real content module;
//   4. no source the kit compiles reaches a dropped file: the six skill loaders are named
//      nowhere outside the knowledge package's own definitions, and nothing names the README.
// `kitDeadPromptsSmoke.test.ts` runs every assembly the kit can make against the CUT store.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const HOST = path.resolve(__dirname, '../..');
const REPO = path.resolve(HOST, '../..');
const CONTENT_MODULE = path.join(REPO, 'packages/knowledge/dist/generated/content.js');
const PLUGIN_MODULE = '../plugins/drop-prompt-files.js';

const read = (file: string): string => readFileSync(file, 'utf8');

/** Source with comments blanked — a rule must not be satisfied by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

type Rule = { prefixes: readonly string[]; exact: readonly string[] };
type DropPlugin = {
  name: string;
  enforce?: string;
  transform: (this: PluginCtx, code: string, id: string) => Promise<{ code: string } | string | null | undefined>;
  buildEnd: (this: PluginCtx) => void;
};
type PluginCtx = { error: (message: string) => never };
type PluginModule = {
  KIT_DEAD_PROMPTS: Rule;
  isKitDeadPrompt: (file: string) => boolean;
  filterPromptFiles: (files: Readonly<Record<string, string>>) => { kept: Record<string, string>; dropped: string[] };
  dropPromptFiles: (options: { contentModule: string }) => DropPlugin;
};

// A variable specifier: the module does not exist until the implementation lands, and a
// literal dynamic import would fail the whole file at transform time instead of per test.
const loadPlugin = (): Promise<PluginModule> => import(/* @vite-ignore */ PLUGIN_MODULE) as Promise<PluginModule>;

/** The real store, as the playground and the desktop ship it. */
async function realStore(): Promise<Record<string, string>> {
  const mod = (await import(/* @vite-ignore */ CONTENT_MODULE)) as { PROMPT_FILES: Record<string, string> };
  return mod.PROMPT_FILES;
}

/**
 * Evaluate an ES module's text and answer its namespace — a real ESM import, independent of
 * the plugin's own parser. Written INSIDE the workspace: Vite's module runner refuses to load
 * a file outside `server.fs.allow` (the OS temp dir is outside it).
 */
async function evaluate(code: string): Promise<Record<string, unknown>> {
  const cache = path.join(HOST, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const file = path.join(mkdtempSync(path.join(cache, 'kit-dead-prompts-')), 'content.mjs');
  writeFileSync(file, code);
  return (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
}

/** A plugin context whose `error` throws, as Rollup's does. */
const ctx = (): PluginCtx => ({
  error: (message: string): never => {
    throw new Error(message);
  },
});

describe('the rule — exactly the files no shipped code reads', () => {
  it('names skills/** and README.md, and nothing else', async () => {
    const { KIT_DEAD_PROMPTS } = await loadPlugin();
    expect(KIT_DEAD_PROMPTS).toEqual({ prefixes: ['skills/'], exact: ['README.md'] });
  });

  it('over the REAL store: drops the 26 skill and README files and keeps every other layer whole', async () => {
    const { filterPromptFiles, isKitDeadPrompt } = await loadPlugin();
    const store = await realStore();
    const { kept, dropped } = filterPromptFiles(store);
    const expected = Object.keys(store).filter((file) => file.startsWith('skills/') || file === 'README.md').sort();
    expect(expected.length).toBe(26);
    expect([...dropped].sort()).toEqual(expected);
    expect(Object.keys(kept).length + dropped.length).toBe(Object.keys(store).length);
    for (const [file, text] of Object.entries(kept)) {
      expect(isKitDeadPrompt(file), file).toBe(false);
      expect(text).toBe(store[file]); // kept files are byte-identical
    }
    for (const layer of ['system/', 'knowledge-base/', 'tools/', 'templates/', 'ui/']) {
      const inStore = Object.keys(store).filter((file) => file.startsWith(layer));
      expect(inStore.length, layer).toBeGreaterThan(0);
      for (const file of inStore) expect(kept[file], file).toBe(store[file]);
    }
  });

  it('matches by prefix and exact name only — a look-alike survives', async () => {
    const { isKitDeadPrompt } = await loadPlugin();
    expect(isKitDeadPrompt('skills/skill-creator/SKILL.md')).toBe(true);
    expect(isKitDeadPrompt('skills/modes/create.md')).toBe(true);
    expect(isKitDeadPrompt('README.md')).toBe(true);
    expect(isKitDeadPrompt('knowledge-base/app-authoring/README.md')).toBe(false);
    expect(isKitDeadPrompt('tools/skills.md')).toBe(false);
    expect(isKitDeadPrompt('skills')).toBe(false);
    expect(isKitDeadPrompt('system/10-host-identity.md')).toBe(false);
  });
});

describe('the plugin — rewrites the one module, and fails the build rather than cut nothing', () => {
  it('is a pre plugin named for the kit', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    expect(plugin.name).toBe('snug-host:drop-prompt-files');
    expect(plugin.enforce).toBe('pre');
  });

  it('rewrites the REAL content module to the kept store, with its one export', async () => {
    const { dropPromptFiles, filterPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    const out = await plugin.transform.call(ctx(), read(CONTENT_MODULE), CONTENT_MODULE);
    const code = typeof out === 'string' ? out : out?.code;
    expect(typeof code).toBe('string');
    const namespace = await evaluate(code!);
    expect(Object.keys(namespace)).toEqual(['PROMPT_FILES']);
    expect(namespace.PROMPT_FILES).toEqual(filterPromptFiles(await realStore()).kept);
    expect(code!).not.toContain('skill-creator');
    expect(() => plugin.buildEnd.call(ctx())).not.toThrow();
  });

  it('leaves every other module alone', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    const other = path.join(REPO, 'packages/knowledge/dist/layers.js');
    expect(await plugin.transform.call(ctx(), 'export const PROMPT_FILES = { "README.md": "x" };', other)).toBeFalsy();
  });

  it('fails when the module was never seen — the cut is dead and the bytes are in the page', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    expect(() => plugin.buildEnd.call(ctx())).toThrow(/drop-prompt-files/);
  });

  it('fails when the rule cuts nothing (the store renamed its folders)', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    const code = `export const PROMPT_FILES = ${JSON.stringify({ 'system/10-host-identity.md': 'hi' })};\n`;
    await expect(plugin.transform.call(ctx(), code, CONTENT_MODULE)).rejects.toThrow(/drop-prompt-files/);
  });

  it('fails when an exact name is missing even though a prefix still matches', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    const code = `export const PROMPT_FILES = ${JSON.stringify({ 'skills/modes/create.md': 'x', 'system/10-host-identity.md': 'hi' })};\n`;
    await expect(plugin.transform.call(ctx(), code, CONTENT_MODULE)).rejects.toThrow(/README\.md/);
  });

  it('fails when the content module grows a second export (it would be lost)', async () => {
    const { dropPromptFiles } = await loadPlugin();
    const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
    const code = `export const PROMPT_FILES = ${JSON.stringify({ 'README.md': 'x', 'skills/a.md': 'y', 'ui/b.md': 'z' })};\nexport const OTHER = 1;\n`;
    await expect(plugin.transform.call(ctx(), code, CONTENT_MODULE)).rejects.toThrow(/OTHER/);
  });
});

describe('the one kit config registers it on the real content module', () => {
  it('vite.config.ts calls dropPromptFiles on packages/knowledge/dist/generated/content.js', () => {
    const config = stripComments(read(path.join(HOST, 'vite.config.ts')));
    expect(config).toMatch(/import\s*\{\s*dropPromptFiles\s*\}\s*from\s*'\.\/src\/plugins\/drop-prompt-files\.js'/);
    expect(config).toMatch(/dropPromptFiles\(\s*\{\s*contentModule:\s*here\('\.\.\/\.\.\/packages\/knowledge\/dist\/generated\/content\.js'\)\s*\}\s*\)/);
    expect(statSync(CONTENT_MODULE).isFile()).toBe(true);
  });
});

describe('no source the kit compiles reaches a dropped file', () => {
  const SKILL_LOADERS = ['buildSkillBuilderPrompt', 'getSkillBuilderPreamble', 'listSkillModes', 'getSkillMode', 'listSkillCreatorFiles', 'getSkillCreatorFile'];

  /** Every non-test .ts/.tsx under a directory. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
        out.push(...sources(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  const KIT_ROOTS = [path.join(HOST, 'src'), path.join(REPO, 'apps/playground/src'), ...readdirSync(path.join(REPO, 'packages')).filter((name) => name !== 'knowledge').map((name) => path.join(REPO, 'packages', name, 'src'))].filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

  it('scans the host, the playground and every package but knowledge', () => {
    const files = KIT_ROOTS.flatMap(sources);
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.endsWith(path.join('apps/playground/src/agent/builder.ts')))).toBe(true);
  });

  it('names none of the six skill loaders', () => {
    const hits: string[] = [];
    for (const file of KIT_ROOTS.flatMap(sources)) {
      const code = stripComments(read(file));
      for (const loader of SKILL_LOADERS) if (new RegExp(`\\b${loader}\\b`).test(code)) hits.push(`${path.relative(REPO, file)}: ${loader}`);
    }
    expect(hits).toEqual([]);
  });

  it('inside knowledge, the loaders are only defined and re-exported — no assembly the kit runs calls one', () => {
    const KNOWLEDGE = path.join(REPO, 'packages/knowledge/src');
    const hits: string[] = [];
    for (const file of sources(KNOWLEDGE)) {
      const code = stripComments(read(file));
      const rel = path.relative(KNOWLEDGE, file);
      for (const loader of SKILL_LOADERS) {
        const uses = [...code.matchAll(new RegExp(`\\b${loader}\\b`, 'g'))].length;
        if (uses === 0) continue;
        // index.ts re-exports each name once; layers.ts defines the five and uses them among
        // themselves; assemble.ts defines buildSkillBuilderPrompt, its only caller of the rest.
        if (rel === 'index.ts' && uses === 1) continue;
        if (rel === 'layers.ts' && loader !== 'buildSkillBuilderPrompt') continue;
        if (rel === 'assemble.ts') continue;
        hits.push(`${rel}: ${loader} ×${uses}`);
      }
    }
    expect(hits).toEqual([]);
    // assemble.ts: the skill loaders appear only inside buildSkillBuilderPrompt's body.
    const assemble = stripComments(read(path.join(KNOWLEDGE, 'assemble.ts')));
    const start = assemble.indexOf('export function buildSkillBuilderPrompt(');
    expect(start).toBeGreaterThan(-1);
    const end = assemble.indexOf('\n}\n', start);
    const outside = assemble.slice(0, start) + assemble.slice(end);
    for (const loader of SKILL_LOADERS) expect(outside, loader).not.toMatch(new RegExp(`\\b${loader}\\(`));
  });

  it('names the store README nowhere', () => {
    const hits: string[] = [];
    const rule = path.join(HOST, 'src/plugins/drop-prompt-files.ts'); // the rule itself names it
    for (const file of [...KIT_ROOTS.flatMap(sources), ...sources(path.join(REPO, 'packages/knowledge/src'))]) {
      if (file === rule) continue;
      if (/['"`]README\.md['"`]/.test(stripComments(read(file)))) hits.push(path.relative(REPO, file));
    }
    expect(hits).toEqual([]);
  });
});
