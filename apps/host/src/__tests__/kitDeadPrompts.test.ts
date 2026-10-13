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
//
// Gate-5 fold (D-PR5-16, the next-steps kit-dead prompt cut, ≈ 9 KB — the owner's 2026-10-11
// pattern, taken because PR-5 crossed its 60 KB budget): the rule ALSO drops the scheduled agent's
// three prompt files — `system/50-scheduled-agent.md`, `tools/fetch-connection.md` and
// `tools/data-propose-write-scheduled.md`. They are read only by the scheduled agent
// (`schedule/appAgent.ts`, swapped out of the kit since PR-4) and by the data lane's scheduled seat
// it alone builds; section 5 below pins that no source the kit compiles asks for them. The chat's
// `tools/data-propose-write.md` stays.
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

/** Gate-5 fold (D-PR5-16): the scheduled agent's three prompt files, cut from the kit by exact name. */
const SCHEDULED_AGENT_PROMPTS = ['system/50-scheduled-agent.md', 'tools/data-propose-write-scheduled.md', 'tools/fetch-connection.md'] as const;
const isCut = (file: string): boolean => file.startsWith('skills/') || file === 'README.md' || (SCHEDULED_AGENT_PROMPTS as readonly string[]).includes(file);
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
  it('names skills/**, README.md and the scheduled agent’s three prompt files, and nothing else (Gate-5 fold D-PR5-16)', async () => {
    const { KIT_DEAD_PROMPTS } = await loadPlugin();
    expect(KIT_DEAD_PROMPTS.prefixes).toEqual(['skills/']);
    expect([...KIT_DEAD_PROMPTS.exact].sort()).toEqual(['README.md', ...SCHEDULED_AGENT_PROMPTS].sort());
  });

  it('over the REAL store: drops the 26 skill and README files and the scheduled agent’s 3, and keeps every other file whole (Gate-5 fold D-PR5-16)', async () => {
    const { filterPromptFiles, isKitDeadPrompt } = await loadPlugin();
    const store = await realStore();
    const { kept, dropped } = filterPromptFiles(store);
    for (const file of SCHEDULED_AGENT_PROMPTS) expect(store[file], `${file} is in the real store`).toBeTypeOf('string');
    const expected = Object.keys(store).filter(isCut).sort();
    expect(expected.length).toBe(26 + 3);
    expect([...dropped].sort()).toEqual(expected);
    expect(Object.keys(kept).length + dropped.length).toBe(Object.keys(store).length);
    for (const [file, text] of Object.entries(kept)) {
      expect(isKitDeadPrompt(file), file).toBe(false);
      expect(text).toBe(store[file]); // kept files are byte-identical
    }
    for (const layer of ['system/', 'knowledge-base/', 'tools/', 'templates/', 'ui/']) {
      const inStore = Object.keys(store).filter((file) => file.startsWith(layer) && !isCut(file));
      expect(inStore.length, layer).toBeGreaterThan(0);
      for (const file of inStore) expect(kept[file], file).toBe(store[file]);
    }
    // Gate-5 fold D-PR5-16: the chat's own data_propose_write prompt and the runtime layer stay.
    expect(kept['tools/data-propose-write.md']).toBe(store['tools/data-propose-write.md']);
    expect(kept['system/45-app-runtime.md']).toBe(store['system/45-app-runtime.md']);
    for (const file of SCHEDULED_AGENT_PROMPTS) expect(kept[file], file).toBeUndefined();
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
    // Gate-5 fold D-PR5-16: the three by exact name; their chat and runtime neighbours survive.
    for (const file of SCHEDULED_AGENT_PROMPTS) expect(isKitDeadPrompt(file), file).toBe(true);
    expect(isKitDeadPrompt('tools/data-propose-write.md')).toBe(false);
    expect(isKitDeadPrompt('tools/data-query.md')).toBe(false);
    expect(isKitDeadPrompt('system/45-app-runtime.md')).toBe(false);
    expect(isKitDeadPrompt('system/50-scheduled-agent.md.bak')).toBe(false);
    expect(isKitDeadPrompt('tools/fetch-connection')).toBe(false);
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
    // Gate-5 fold D-PR5-16: the scheduled agent's three files are out of the page too.
    for (const file of SCHEDULED_AGENT_PROMPTS) expect(Object.keys(namespace.PROMPT_FILES as Record<string, string>), file).not.toContain(file);
    expect(code!).not.toContain('You Are Answering a Scheduled Question');
    expect(code!).not.toContain('## Tool: fetch connection');
    expect(code!).toMatch(/^\/\/ drop-prompt-files: \d+ of \d+ prompt files dropped from the kit page\./);
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

  it('fails when one of the scheduled agent’s files is renamed away even though every other rule matches (Gate-5 fold D-PR5-16)', async () => {
    const { dropPromptFiles } = await loadPlugin();
    for (const missing of SCHEDULED_AGENT_PROMPTS) {
      const plugin = dropPromptFiles({ contentModule: CONTENT_MODULE });
      const store: Record<string, string> = { 'README.md': 'r', 'skills/modes/create.md': 'x', 'system/10-host-identity.md': 'hi' };
      for (const file of SCHEDULED_AGENT_PROMPTS) if (file !== missing) store[file] = 'y';
      const code = `export const PROMPT_FILES = ${JSON.stringify(store)};\n`;
      await expect(plugin.transform.call(ctx(), code, CONTENT_MODULE), missing).rejects.toThrow(new RegExp(missing.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
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

  // -------------------------------------------------------------------------------------------
  // Gate-5 fold (D-PR5-16): the scheduled agent's three prompt files are dead in the kit. They are
  // read only by `buildHostSystemPrompt({scheduledAgent: true})` (system/50), `buildFetchConnectionTool`
  // (tools/fetch-connection) and `buildDataTools` with a `scheduled` seat (tools/data-propose-write-
  // scheduled) — and every such call lives in a module the kit SWAPS for a stub (`schedule/appAgent.ts`;
  // `agent/laneTools.ts` holds the chat's buildDataTools). The swapped real modules are not compiled
  // into the page, so the scan skips them; the stubs (under src/stubs/) are scanned like any source.
  // -------------------------------------------------------------------------------------------
  describe('Gate-5 fold D-PR5-16 — no source the kit compiles asks for the scheduled agent’s prompts', () => {
    const PLAYGROUND = path.join(REPO, 'apps/playground/src');
    const config = stripComments(read(path.join(HOST, 'vite.config.ts')));
    const table = config.slice(config.indexOf('swapResolved({'), config.indexOf('}),', config.indexOf('swapResolved({')));
    /** The real playground modules the kit swaps out — not compiled into the page. */
    const SWAPPED = [...table.matchAll(/\[`\$\{playgroundSrc\}\/([^`]+)`\]\s*:/g)].map((match) => path.join(PLAYGROUND, match[1]!));
    const kitSources = (): string[] => KIT_ROOTS.flatMap(sources).filter((file) => !SWAPPED.includes(file));
    const APP_AGENT = path.join(PLAYGROUND, 'schedule/appAgent.ts');

    /** The text between an opener at `open` ('(' or '{') and its matching closer (comments already blanked). */
    function balanced(code: string, open: number): string {
      const pair: Record<string, string> = { '(': ')', '{': '}' };
      const opener = code[open]!;
      const closer = pair[opener];
      if (closer === undefined) throw new Error(`no opener at ${open}`);
      let depth = 0;
      for (let i = open; i < code.length; i += 1) {
        if (code[i] === opener) depth += 1;
        else if (code[i] === closer && (depth -= 1) === 0) return code.slice(open + 1, i);
      }
      throw new Error('unbalanced');
    }

    /** Every CALL of `name` in a source (a definition `function name(` is not a call): its argument text. */
    function callArgs(code: string, name: string): string[] {
      const out: string[] = [];
      for (const match of code.matchAll(new RegExp(String.raw`(?<!function\s+)\b${name}\s*\(`, 'g'))) {
        out.push(balanced(code, match.index! + match[0].length - 1));
      }
      return out;
    }

    /** The calls a source makes that would read one of the three files. */
    function scheduledPromptCalls(code: string): string[] {
      const hits: string[] = [];
      for (const args of callArgs(code, 'buildHostSystemPrompt')) if (/\bscheduledAgent\b/.test(args)) hits.push('buildHostSystemPrompt({scheduledAgent})');
      for (const _args of callArgs(code, 'buildFetchConnectionTool')) hits.push('buildFetchConnectionTool(…)');
      for (const args of callArgs(code, 'buildDataTools')) if (/\bscheduled\b/.test(args)) hits.push('buildDataTools({scheduled})');
      return hits;
    }

    it('the kit swaps schedule/appAgent.ts and agent/laneTools.ts, and the scan skips exactly the swapped modules', () => {
      expect(SWAPPED).toContain(APP_AGENT);
      expect(SWAPPED).toContain(path.join(PLAYGROUND, 'agent/laneTools.ts'));
      for (const file of SWAPPED) expect(statSync(file).isFile(), file).toBe(true);
      const scanned = kitSources();
      expect(scanned.length).toBeGreaterThan(300);
      for (const file of SWAPPED) expect(scanned, file).not.toContain(file);
      // The modules that DEFINE the readers are compiled (and scanned): only their calls are dead.
      expect(scanned).toContain(path.join(PLAYGROUND, 'agent/fetchConnectionTool.ts'));
      expect(scanned).toContain(path.join(PLAYGROUND, 'agent/dataTools.ts'));
    });

    it('positive control: the scanner FINDS all three calls in the swapped scheduled agent (schedule/appAgent.ts)', () => {
      expect(scheduledPromptCalls(stripComments(read(APP_AGENT))).sort()).toEqual(['buildDataTools({scheduled})', 'buildFetchConnectionTool(…)', 'buildHostSystemPrompt({scheduledAgent})']);
    });

    it('no kit source calls buildHostSystemPrompt with scheduledAgent, buildFetchConnectionTool, or buildDataTools with a scheduled seat', () => {
      const hits: string[] = [];
      for (const file of kitSources()) {
        for (const hit of scheduledPromptCalls(stripComments(read(file)))) hits.push(`${path.relative(REPO, file)}: ${hit}`);
      }
      expect(hits).toEqual([]);
    });

    it('…nor names `scheduledAgent` or `buildFetchConnectionTool` at all outside its one definition (a spread options object cannot hide the call)', () => {
      const hits: string[] = [];
      const definer = path.join(PLAYGROUND, 'agent/fetchConnectionTool.ts');
      for (const file of kitSources()) {
        const code = stripComments(read(file));
        if (/\bscheduledAgent\b/.test(code)) hits.push(`${path.relative(REPO, file)}: scheduledAgent`);
        const fetchTool = [...code.matchAll(/\bbuildFetchConnectionTool\b/g)].length;
        const allowed = file === definer ? (code.match(/export function buildFetchConnectionTool\(/g) ?? []).length : 0;
        if (fetchTool !== allowed) hits.push(`${path.relative(REPO, file)}: buildFetchConnectionTool ×${fetchTool}`);
      }
      expect(hits).toEqual([]);
    });

    it('the prompt names the kit compiles sit only inside the dead readers: fetch-connection in buildFetchConnectionTool, data-propose-write-scheduled in scheduledProposeDef (chosen only under a scheduled seat)', () => {
      const literal = /['"`](?:system\/)?(?:50-)?scheduled-agent(?:\.md)?['"`]|['"`](?:tools\/)?fetch-connection(?:\.md)?['"`]|['"`](?:tools\/)?data-propose-write-scheduled(?:\.md)?['"`]/g;
      const named: string[] = [];
      // The rule itself names the three (KIT_DEAD_PROMPTS.exact, pinned above) — a Vite plugin run at
      // build time, never in the page; skipped as the README pin skips it (code lane, Gate-5 D-PR5-16).
      const rule = path.join(HOST, 'src/plugins/drop-prompt-files.ts');
      for (const file of kitSources()) {
        if (file === rule) continue;
        for (const match of stripComments(read(file)).matchAll(literal)) named.push(`${path.relative(PLAYGROUND, file)}: ${match[0]}`);
      }
      expect(named.sort()).toEqual([`agent${path.sep}dataTools.ts: 'data-propose-write-scheduled'`, `agent${path.sep}fetchConnectionTool.ts: 'fetch-connection'`]);

      const fetchTool = stripComments(read(path.join(PLAYGROUND, 'agent/fetchConnectionTool.ts')));
      const fetchStart = fetchTool.indexOf('export function buildFetchConnectionTool(');
      expect(fetchStart).toBeGreaterThan(-1);
      const fetchBody = balanced(fetchTool, fetchTool.indexOf('{', fetchTool.indexOf(')', fetchStart)));
      expect(fetchBody).toContain("getToolPrompt('fetch-connection')");

      const dataTools = stripComments(read(path.join(PLAYGROUND, 'agent/dataTools.ts')));
      const defStart = dataTools.indexOf('const scheduledProposeDef =');
      expect(defStart).toBeGreaterThan(-1);
      const defBody = balanced(dataTools, dataTools.indexOf('(', dataTools.indexOf('=>', defStart)));
      expect(defBody).toContain("getToolPrompt('data-propose-write-scheduled')");
      // scheduledProposeDef is called once, and only when buildDataTools was handed a scheduled seat.
      expect(callArgs(dataTools, 'scheduledProposeDef')).toHaveLength(1);
      expect(dataTools).toMatch(/scheduled\s*===\s*undefined\s*\?\s*chatProposeDef\(\)\s*:\s*scheduledProposeDef\(\)/);
    });

    it('inside knowledge, system/50 is assembled only on the scheduledAgent branch of buildHostSystemPrompt', () => {
      const KNOWLEDGE = path.join(REPO, 'packages/knowledge/src');
      const assemble = stripComments(read(path.join(KNOWLEDGE, 'assemble.ts')));
      const branch = assemble.indexOf('if (opts.scheduledAgent === true)');
      expect(branch).toBeGreaterThan(-1);
      const body = balanced(assemble, assemble.indexOf('{', branch));
      expect(body).toContain("getSystemLayer('scheduled-agent')");
      const hits: string[] = [];
      for (const file of sources(KNOWLEDGE)) {
        const code = stripComments(read(file));
        const uses = [...code.matchAll(/getSystemLayer\(\s*'scheduled-agent'\s*\)/g)].length;
        if (uses === 0) continue;
        if (file === path.join(KNOWLEDGE, 'assemble.ts') && uses === 1) continue;
        hits.push(`${path.relative(KNOWLEDGE, file)} ×${uses}`);
      }
      expect(hits).toEqual([]);
    });
  });
});
