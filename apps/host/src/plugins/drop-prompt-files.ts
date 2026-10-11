// drop-prompt-files.ts — drop the prompt files no shipped code reads from the KIT page
// (TASK-20261010-host-broker PR-3; the owner's decision of 2026-10-11: take the dead prompt
// files out of the host kit instead of raising KIT_SIZE_CEILING_BYTES).
// `@snugprotocol/knowledge` ships every file under `prompts/` as ONE object, `PROMPT_FILES`,
// in its generated content module, so a bundler cannot tree-shake a file nothing reads. Two
// groups are read by nothing that ships in a page: everything under `skills/` — the
// skill-builder preamble and modes and the vendored Anthropic skill-creator — reached only
// through the six skill loaders (`buildSkillBuilderPrompt`, `getSkillBuilderPreamble`,
// `listSkillModes`, `getSkillMode`, `listSkillCreatorFiles`, `getSkillCreatorFile`), which no
// app, server, host or script calls; and `README.md`, the store's own map, a repo document.
// This pre-transform rewrites the content module to the kept files (−253,454 B measured) —
// KIT ONLY: the playground and the desktop are not built from this config and keep the
// whole store.
// Three guards fail the BUILD rather than ship a silent loss: a content module with any
// export beyond `PROMPT_FILES` (the rewrite would drop it), a rule that matches nothing (a
// renamed folder means the bytes are back in the page and only the ceiling would notice),
// and a module never seen (the dead-swap guard of swap-resolved.ts, mirrored).
// `src/__tests__/kitDeadPrompts.test.ts` pins the rule, the plugin and the wiring;
// `kitDeadPromptsSmoke.test.ts` assembles every prompt the kit can make against the cut store.

import { runInNewContext } from 'node:vm';

import type { Plugin } from 'vite';

/** The files the kit drops: every key under a prefix, and each exact name. */
export const KIT_DEAD_PROMPTS: { prefixes: readonly string[]; exact: readonly string[] } = {
  prefixes: ['skills/'],
  exact: ['README.md'],
};

export function isKitDeadPrompt(file: string): boolean {
  return KIT_DEAD_PROMPTS.prefixes.some((prefix) => file.startsWith(prefix)) || KIT_DEAD_PROMPTS.exact.includes(file);
}

/** Split a store into the files the kit keeps (byte-identical, in order) and the names it drops. */
export function filterPromptFiles(files: Readonly<Record<string, string>>): { kept: Record<string, string>; dropped: string[] } {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (isKitDeadPrompt(file)) dropped.push(file);
    else kept[file] = text;
  }
  return { kept, dropped };
}

const STORE_EXPORT = 'export const PROMPT_FILES';

// Every top-level export's head: a declaration (`export const NAME`, `export function NAME`,
// `export default …`) or a re-export (`export {`, `export *`). The store's keys and values are
// JSON-encoded on one line each, so an `export` at a line start is always a statement.
const EXPORT_HEADS = /^export\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class|default)\s*\w*|^export\s*[{*]/gm;

const stripQuery = (id: string): string => {
  const query = id.indexOf('?');
  return query === -1 ? id : id.slice(0, query);
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((text) => typeof text === 'string');

/**
 * Evaluate the store's object literal. It is the repo's OWN generated file, read at build
 * time, and not strict JSON (a trailing comma) — so `node:vm` in an empty context, not
 * `JSON.parse`, and not a dynamic import of a `data:` URL, which vitest's module runner
 * cannot do and `vite build` should not.
 */
const evaluateLiteral = (literal: string): unknown => runInNewContext(`(${literal})`, Object.create(null));

export function dropPromptFiles(options: { contentModule: string }): Plugin {
  let transformed = 0;
  return {
    name: 'snug-host:drop-prompt-files',
    enforce: 'pre',
    async transform(code, id) {
      const file = stripQuery(id);
      if (file !== options.contentModule) return null;

      const heads = [...code.matchAll(EXPORT_HEADS)].map((match) => match[0].replace(/\s+/g, ' '));
      const others = heads.filter((head) => head !== STORE_EXPORT);
      if (others.length > 0) {
        this.error(`drop-prompt-files: ${file} exports more than PROMPT_FILES (${others.join(', ')}) — the rewrite would drop it`);
      }
      const start = code.indexOf(`${STORE_EXPORT} =`);
      const end = code.lastIndexOf(';');
      if (heads.length !== 1 || start === -1 || end < start) {
        this.error(`drop-prompt-files: ${file} is not exactly one \`${STORE_EXPORT} = {…};\``);
      }

      const store = evaluateLiteral(code.slice(start + STORE_EXPORT.length + 2, end));
      if (!isStringRecord(store)) this.error(`drop-prompt-files: ${file} is not an object of file → text`);

      // Every rule must match a file; one that matches nothing — the folder was renamed, the
      // README moved — puts its bytes back in the page, and only the ceiling would notice.
      // (A rule set that cuts nothing at all is the case where every rule is unmatched.)
      const files = Object.keys(store);
      const unmatched = [
        ...KIT_DEAD_PROMPTS.prefixes.filter((prefix) => !files.some((name) => name.startsWith(prefix))).map((prefix) => `${prefix}**`),
        ...KIT_DEAD_PROMPTS.exact.filter((name) => !files.includes(name)),
      ];
      if (unmatched.length > 0) {
        this.error(`drop-prompt-files: ${unmatched.join(', ')} matched nothing in ${file} — the rule is dead and its bytes are in the page`);
      }

      const { kept, dropped } = filterPromptFiles(store);
      transformed += 1;
      const banner = `// drop-prompt-files: ${dropped.length} of ${files.length} prompt files dropped from the kit page.`;
      return { code: `${banner}\nexport const PROMPT_FILES = ${JSON.stringify(kept)};\n`, map: null };
    },
    buildEnd() {
      if (transformed === 0) {
        this.error(`drop-prompt-files: ${options.contentModule} was never transformed — the cut is dead and its bytes are in the page`);
      }
    },
  };
}
