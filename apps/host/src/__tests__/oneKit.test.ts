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
    const viaNavigator = /navigator\??\.storage\b/;
    const offenders = kit
      .filter((file) => file !== 'apps/host/src/safeStorage.ts')
      .filter((file) => {
        const code = stripComments(read(file));
        return bare.test(code) || viaNavigator.test(code);
      });
    expect(offenders).toEqual([]);
    // The positive twin: the pattern catches the read this rule exists for.
    expect(bare.test('const x = compose(location, sessionStorage, y);')).toBe(true);
    expect(bare.test('sessionStorage.setItem(KEY, note);')).toBe(true);
    expect(bare.test('win.sessionStorage?.getItem(KEY)')).toBe(false);
    expect(bare.test('sessionStorage: safeSessionStorage(win),')).toBe(false);
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

  it('one boot: both compositions mount through mountKit, from the one entry', () => {
    const boot = stripComments(read('apps/host/src/boot.tsx'));
    expect(boot.match(/mountKit\(root,/g)).toHaveLength(2);
    expect(boot.match(/createRoot\(/g)).toHaveLength(1);
    expect(kit.filter((file) => /createRoot\(/.test(stripComments(read(file))))).toEqual(['apps/host/src/boot.tsx']);
    expect(stripComments(read('apps/host/src/main.tsx'))).toMatch(/void boot\(\);/);
  });
});
