// oneKit.test.ts — TASK-20261003 K1/K4 (ADR-0072 §1, §3): ONE kit page, and one of everything
// the bindings share. Structural, on purpose: each rule here is a property of the TREE, not
// of any one function, and each was true by convention until it was not.
//
//   K1  `apps/host` has one Vite config, one html entry and one output. The second build (a
//       config, an entry and an output directory of its own for the runner's page) was a
//       restatement of the first, the same size, shipped beside it in the plugin, and it
//       decided a binding at BUILD time. Nothing may name it again outside `docs/` — this
//       file included, which is why its four spellings are assembled below, not written.
//   K4  no capability-block literal outside `hostCapabilities()`; no DOM `CustomEvent` as a
//       host-to-UI signal (three were dispatched and nothing listened); the storage globals
//       read only through `safeStorage.ts`; one base64 decoder; one custody store; one
//       hand-in summary.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const HOST = path.resolve(__dirname, '../..');
const REPO = path.resolve(HOST, '../..');

/** Every file git tracks or would track (the working tree: untracked-but-not-ignored counts, deleted does not). */
function workingTreeFiles(): string[] {
  const list = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((file) => file !== '');
  const files = new Set([...list(['ls-files', '-z']), ...list(['ls-files', '-z', '--others', '--exclude-standard'])]);
  return [...files].filter((file) => existsSync(path.join(REPO, file))).sort();
}

/** Source text with `//` and block comments blanked — a rule must not be satisfied (or tripped) by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const sources = (dir: string): string[] =>
  readdirSync(path.join(REPO, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => path.relative(REPO, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !file.includes('/__tests__/'))
    .sort();

const read = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');

/**
 * K4: does this code read a browser storage global other than through `safeStorage.ts`?
 *
 * Four spellings of the one read. BARE skips a name after `.`, so a parameter's member
 * (`win.sessionStorage`) is not counted — which on its own also let the global through
 * when written off the global object (`window.sessionStorage`, Gate 5 tests/F1), so the
 * global object's members, its bracket form and a destructure off it are arms of their own.
 * `(?<![.\w$])` keeps `win.window.x` and `mywindow.x` (members, not the global) out.
 */
function readsAStorageGlobal(code: string): boolean {
  const bare = /(^|[^.\w'"`])(sessionStorage|localStorage|indexedDB)\s*(\.|\[|\)|,|;|$)/m;
  const viaNavigator = /navigator\??\.storage\b/;
  const globalObject = String.raw`(?<![.\w$])(?:(?:window|globalThis|self)\s*\??\.\s*)*(?:window|globalThis|self)`;
  const member = new RegExp(String.raw`${globalObject}\s*\??\.\s*(sessionStorage|localStorage|indexedDB)\b`);
  const bracket = new RegExp(String.raw`${globalObject}\s*(?:\?\.)?\[\s*['"\`](sessionStorage|localStorage|indexedDB)['"\`]\s*\]`);
  const destructured = new RegExp(String.raw`\{[^}]*\b(sessionStorage|localStorage|indexedDB)\b[^}]*\}\s*=\s*${globalObject}\b`);
  const navigatorDestructured = new RegExp(String.raw`\{[^}]*\bstorage\b[^}]*\}\s*=\s*(?:${globalObject}\s*\??\.\s*)?navigator\b`);
  return [bare, viaNavigator, member, bracket, destructured, navigatorDestructured].some((pattern) => pattern.test(code));
}

describe('K1 — one Vite config, one html entry, one output', () => {
  const top = readdirSync(HOST);

  it('exactly one vite config — a second one is a second page', () => {
    expect(top.filter((name) => /^vite\..*config\.[cm]?[jt]s$/.test(name))).toEqual(['vite.config.ts']);
  });

  it('exactly one html entry, and it enters at src/main.tsx', () => {
    expect(top.filter((name) => name.endsWith('.html'))).toEqual(['index.html']);
    const entries = [...read('apps/host/index.html').matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]);
    expect(entries).toEqual(['./src/main.tsx']);
  });

  it('the build script runs vite ONCE, and names no second config or output', () => {
    const pkg = JSON.parse(read('apps/host/package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('pnpm build:starters && tsc -p tsconfig.json --noEmit && vite build');
    expect(Object.keys(pkg.scripts).sort()).toEqual(['build', 'build:starters', 'test', 'test:e2e']);
    const config = stripComments(read('apps/host/vite.config.ts'));
    expect(config.match(/fileName: '([^']+)'/)?.[1]).toBe('snug-host.html');
    expect(config).not.toMatch(/outDir/);
  });

  it('src/local/ is a directory of MODULES — it is no longer an entry', () => {
    expect(readdirSync(path.join(HOST, 'src/local')).sort()).toEqual(['LocalRefusal.tsx', 'client.ts', 'compose-local.ts', 'handinEvents.ts']);
  });

  it('nothing outside docs/ names the second build — in any tracked file', () => {
    // The four spellings the second build had. Assembled, so this file does not name them.
    const second = new RegExp(['dist' + '-local', 'snug-host' + '-local', 'vite' + '\\.local', 'build' + ':local'].join('|'));
    // `docs/` is the append-only record (decisions, journals, the plan that withdrew the
    // build) and the ONLY directory K1 exempts. ONE file outside it is exempt BY NAME: a
    // filed prompt quoting the decision this range reverses (D-B1, "a second entry of
    // apps/host") — a record of the same kind, kept outside `docs/` and outside this
    // range's files. A named file, not its directory: anything else filed beside it is
    // walked like source. (Whether K1's wording takes the exemption or the prompt moves
    // under `docs/` is the task owner's call; if it moves, the last assertion below reds.)
    const FILED_RECORD = 'Claude outputs/PROMPT-binding-b-plugin-host.md';
    const record = (file: string): boolean => file.startsWith('docs/') || file === FILED_RECORD;
    const tracked = workingTreeFiles();
    const files = tracked.filter((file) => !record(file) && !file.split('/').some((part) => part === 'node_modules' || part === 'dist'));
    expect(files.length, 'the walk must see the repo, not an empty list').toBeGreaterThan(500);
    expect(files).toContain('apps/host/vite.config.ts');
    // The exemption earns its place: the file is there and still names the second build.
    // Once it is moved or reworded this line is the reminder to delete the exemption.
    expect(tracked.includes(FILED_RECORD) && second.test(read(FILED_RECORD)), `${FILED_RECORD} no longer needs its exemption — remove it`).toBe(true);
    const hits: string[] = [];
    for (const file of files) {
      if (second.test(file)) hits.push(`${file} (the path itself)`);
      let text: string;
      try {
        text = read(file);
      } catch {
        continue; // a directory entry (a submodule), or unreadable: not text we own
      }
      const line = text.split('\n').findIndex((candidate) => second.test(candidate));
      if (line !== -1) hits.push(`${file}:${line + 1}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('K4 — one of everything the bindings share', () => {
  const kit = sources('apps/host/src');
  const process_ = sources('apps/host-mcp/src');

  it('the walk is not vacuous', () => {
    expect(kit).toContain('apps/host/src/boot.tsx');
    expect(kit).toContain('apps/host/src/local/compose-local.ts');
    expect(process_).toContain('apps/host-mcp/src/runner.ts');
  });

  it('NO capability-block literal outside hostCapabilities() — the kit, the runner, and the playground’s host fixture', () => {
    // The keys only the whole block carries. A binding's OVERRIDES (`connections`,
    // `oauthRedirect`, `appExport`) are what it is allowed to write.
    const block = /\b(subscriptionMode|hubSyncOrigin|lanHttpPrivate|hubAuth|brainSettings)\s*:/;
    const offenders = [...kit, ...process_, 'apps/playground/src/__tests__/fixtures/hostPlatform.ts'].filter((file) => block.test(stripComments(read(file))));
    expect(offenders).toEqual([]);
    // The positive twin: the pattern does find the one home.
    expect(block.test(stripComments(read('apps/playground/src/platform/hostCapabilities.ts')))).toBe(true);
    // …and each composition takes its table from it.
    for (const file of ['apps/host/src/platform-host.ts', 'apps/host/src/local/compose-local.ts', 'apps/playground/src/__tests__/fixtures/hostPlatform.ts']) {
      expect(stripComments(read(file)), file).toMatch(/hostCapabilities\(/);
    }
  });

  it('no DOM CustomEvent as a host-to-UI signal — the three dead ones are gone, and none came back', () => {
    const offenders = kit.filter((file) => /CustomEvent|dispatchEvent\(|snug:(brain-changed|library-changed|hand-in-note)/.test(stripComments(read(file))));
    expect(offenders).toEqual([]);
    // What replaced them: the playground's signals, and the custody store.
    const local = stripComments(read('apps/host/src/local/compose-local.ts'));
    expect(local).toMatch(/bumpBrainRevision\(\)/);
    const boot = stripComments(read('apps/host/src/boot.tsx'));
    expect(boot).toMatch(/bumpLibraryRevision\(\)/);
    expect(boot).toMatch(/custody\.patch\(\{ note \}\)/);
  });

  it('the storage globals are read ONLY through safeStorage.ts', () => {
    // A bare read of any of these throws at an opaque origin. Members and parameters named
    // after them (`win.sessionStorage`, `sessionStorage: …`, `sessionStorage?.`) are not reads
    // of the global; `host.<name>` inside the accessor is the one place that is.
    const bare = /(^|[^.\w'"`])(sessionStorage|localStorage|indexedDB)\s*(\.|\[|\)|,|;|$)/m;
    const offenders = kit.filter((file) => file !== 'apps/host/src/safeStorage.ts').filter((file) => readsAStorageGlobal(stripComments(read(file))));
    expect(offenders).toEqual([]);
    // The positive twin: the pattern catches the read this rule exists for.
    expect(bare.test('const x = compose(location, sessionStorage, y);')).toBe(true);
    expect(bare.test('sessionStorage.setItem(KEY, note);')).toBe(true);
    expect(bare.test('win.sessionStorage?.getItem(KEY)')).toBe(false);
    expect(bare.test('sessionStorage: safeSessionStorage(win),')).toBe(false);
  });

  it('…and the global read through window / globalThis / self, or destructured off them, is a read too', () => {
    // Gate 5 (tests/F1): the rule above skips any name after a `.` so that a PARAMETER's
    // member (`win.sessionStorage`) passes — and with it the commonest way to write a read
    // of the real global. Each of these throws exactly where the bare read throws.
    for (const spelling of [
      'window.sessionStorage.getItem(K)',
      'globalThis.localStorage.setItem(K, v)',
      'self.indexedDB.open("x")',
      'window?.localStorage',
      'globalThis.window.sessionStorage',
      "window['localStorage'].getItem(K)",
      'const { sessionStorage } = window;',
      'const { localStorage: store, indexedDB } = globalThis;',
      'const { storage } = navigator;',
      'const { storage } = window.navigator;',
    ]) {
      expect(readsAStorageGlobal(spelling), spelling).toBe(true);
    }
    // The negative twins: a parameter's member, a property name, a destructure off a parameter.
    for (const spelling of [
      'win.sessionStorage?.getItem(KEY)',
      'sessionStorage: safeSessionStorage(win),',
      'host.indexedDB',
      'const { sessionStorage } = win;',
      'mywindow.localStorage',
      'safeNavigatorStorage(win)',
    ]) {
      expect(readsAStorageGlobal(spelling), spelling).toBe(false);
    }
  });

  it('one base64 decoder — the db package’s; no private atob loop in the kit', () => {
    const offenders = kit.filter((file) => /\batob\(/.test(stripComments(read(file))));
    expect(offenders).toEqual([]);
    expect(stripComments(read('apps/host/src/local/client.ts'))).toMatch(/import \{ base64ToBytes[^}]*\} from '@snugprotocol\/db'/);
  });

  it('one custody store, one hand-in core, one hand-in summary — each defined once and used by both compositions', () => {
    const defining = (pattern: RegExp): string[] => kit.filter((file) => pattern.test(stripComments(read(file))));
    expect(defining(/export function create\w*CustodyStore\b/)).toEqual(['apps/host/src/storage/custodyStore.ts']);
    expect(defining(/export (async )?function applyAgentBundles\b/)).toEqual(['apps/host/src/handin.ts']);
    expect(defining(/export function createHandInSeat\b/)).toEqual(['apps/host/src/handin.ts']);
    expect(defining(/export function describe\w*HandIn\b/)).toEqual(['apps/host/src/handin.ts']);
    for (const file of ['apps/host/src/compose.ts', 'apps/host/src/local/compose-local.ts']) {
      const code = stripComments(read(file));
      expect(code, `${file} uses the one custody store`).toMatch(/createCustodyStore\(/);
      expect(code, `${file} uses the one hand-in seat`).toMatch(/createHandInSeat\(\)/);
    }
    expect(stripComments(read('apps/host/src/compose.ts'))).toMatch(/applyAgentBundles\(/);
    expect(stripComments(read('apps/host/src/local/handinEvents.ts'))).toMatch(/applyAgentBundles\(/);
  });

  it('one "connections aren’t available" sentence — the kit says it through the playground’s constant, never in words of its own', () => {
    // Three surfaces once said it three ways; the hand-in refusal was the fourth, and named
    // "an artifact" under bindings that are not one (K4; carried from R2 into R4).
    const ownWords = /connect(ions|ed apps)\s+(are not|aren[’']t|are unavailable|unavailable)\b/i;
    const offenders = kit.filter((file) => ownWords.test(stripComments(read(file))));
    expect(offenders).toEqual([]);
    expect(stripComments(read('apps/host/src/handin.ts'))).toMatch(/import \{ CONNECTIONS_UNAVAILABLE \} from '@playground\/platform\/availability'/);
    expect(stripComments(read('apps/host/src/handin.ts'))).toMatch(/\$\{CONNECTIONS_UNAVAILABLE\}/);
    // The positive twin: the pattern catches the sentence this rule exists for, in both spellings.
    expect(ownWords.test('connected apps are not available inside an artifact')).toBe(true);
    expect(ownWords.test(stripComments(read('apps/playground/src/platform/availability.ts')))).toBe(true);
  });

  it('one "still checking" sentence across the wire — the page tells "not checked yet" from "could not be checked" by the runner’s own words', () => {
    // `unknown` is two facts: nobody has looked at the brain yet, or it was asked and could
    // not be read. The wire carries one state for both, and the runner's sentence for the
    // first is the page's only way to tell — so the two ends must spell it alike.
    const said = /export const NOT_PROBED_DETAIL = '([^']+)';/.exec(read('apps/host-mcp/src/brains/registry.ts'))?.[1];
    const read_ = /export const BRAIN_NOT_CHECKED_DETAIL = '([^']+)';/.exec(read('apps/playground/src/platform/copy.ts'))?.[1];
    expect(said, 'the runner’s sentence').toBeTypeOf('string');
    expect(read_, 'the page’s copy of it').toBe(said);
  });

  it('one fallback input cap — the 65,536 a page budgets on when `limits()` cannot be read is spelled once, and imported', () => {
    // R5 review: the refusal sentence for `prompt_too_large` named the cap as
    // `maxPromptBytes ?? 65_536` — a second copy of the probe's fallback, free to drift from the
    // number the builder budgets on (lesson 2026-08-05: a bound re-derived elsewhere is a second
    // bound). One home, the budget's ruler; every reader imports it.
    const spelled = /\b65_?536\b/;
    expect(kit.filter((file) => spelled.test(stripComments(read(file))))).toEqual(['apps/host/src/brains/prompt.ts']);
    for (const file of ['apps/host/src/probe.ts', 'apps/host/src/brains/errors.ts']) {
      expect(stripComments(read(file)), file).toMatch(/import \{[^}]*\bDEFAULT_MAX_PROMPT_BYTES\b[^}]*\} from '\.\/(brains\/)?prompt\.js'/);
    }
    // The positive twin: the pattern catches the copy this rule exists for, in both spellings.
    expect(spelled.test('context.maxPromptBytes ?? 65_536')).toBe(true);
    expect(spelled.test('const cap = 65536;')).toBe(true);
    expect(spelled.test('const cap = 165_5360;')).toBe(false);
  });

  it('one boot: both compositions mount through mountKit, from the one entry', () => {
    const boot = stripComments(read('apps/host/src/boot.tsx'));
    expect(boot.match(/mountKit\(root,/g)).toHaveLength(2);
    expect(boot.match(/createRoot\(/g)).toHaveLength(1);
    expect(kit.filter((file) => /createRoot\(/.test(stripComments(read(file))))).toEqual(['apps/host/src/boot.tsx']);
    expect(stripComments(read('apps/host/src/main.tsx'))).toMatch(/void boot\(\);/);
  });
});

// C2 (TASK-20261003 R5): ONE hosted runtime, one path. The September chat runtime — a flat
// `window.claude.complete` and a per-view `window.storage` at an `about:srcdoc` origin — was
// measured GONE on 2026-10-03: a chat artifact runs in the hosted runtime (a real
// `frame.claudeusercontent.com` origin, `window.claude = { use }`, no `complete`, no
// `window.storage`). Its adapter, its storage backend, its binding and the prompt-budget seat
// R0 added for it were removed; this keeps them from coming back under the old names. Every
// file under the two trees is read — tests and comments included — because a test that still
// builds the chat binding is the old path kept alive. Spellings assembled, so this file does
// not name them. No exemption: the binding was never persisted (the user file carries no
// binding), and `packages/db`'s `window-storage` persistence kind is spelled with a hyphen
// and lives outside both trees — residue of an append-only enum, kept by rule.
describe('C2 — one hosted runtime: the September chat runtime’s names are gone from the kit and the playground', () => {
  const GONE = ['artifact' + '-chat', 'claude' + 'Complete', 'create' + 'CompleteAdapter', 'window' + 'Storage', 'Prompt' + 'BudgetSeat'];
  const gone = new RegExp(GONE.join('|'), 'i');
  const everyFile = (dir: string): string[] =>
    readdirSync(path.join(REPO, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(REPO, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .filter((file) => !file.split('/').includes('node_modules'))
      .sort();

  it('no file under apps/host/src or apps/playground/src names them — source, tests, fixtures, comments', () => {
    const files = [...everyFile('apps/host/src'), ...everyFile('apps/playground/src')];
    // The walk sees both trees, tests included — never an empty list.
    expect(files).toContain('apps/host/src/probe.ts');
    expect(files).toContain('apps/host/src/__tests__/probe.test.ts');
    expect(files).toContain('apps/playground/src/platform/platform.ts');
    expect(files).toContain('apps/playground/src/__tests__/availability.test.ts');
    const hits: string[] = [];
    for (const file of files) {
      if (gone.test(file)) hits.push(`${file} (the path itself)`);
      const line = read(file).split('\n').findIndex((candidate) => gone.test(candidate));
      if (line !== -1) hits.push(`${file}:${line + 1}`);
    }
    expect(hits).toEqual([]);
  });

  it('the pattern catches each name in the shapes it had, and not the persisted kind it must leave alone', () => {
    for (const spelling of [
      "binding?: 'artifact' | 'artifact-static' | '" + GONE[0] + "' | 'local-host' | 'file';",
      `  ${GONE[1]}: isFunction(claude?.complete),`,
      `import { ${GONE[2]}, type CompleteFn } from './brains/complete.js';`,
      `import { createBackend } from './storage/${GONE[3]}.js';`,
      `export function create${GONE[3].replace(/^w/, 'W')}Backend(`,
      `      budget?: ${GONE[4]};`,
    ]) {
      expect(gone.test(spelling), spelling).toBe(true);
    }
    expect(gone.test("case 'window-storage':")).toBe(false);
  });
});
