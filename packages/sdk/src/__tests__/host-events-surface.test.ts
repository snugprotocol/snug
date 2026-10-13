// The module SDK's public surface for host events (TASK-20261010-host-broker PR-6, AC40c; D-PR6-3).
//
// `useHostEvents` and its `HostEventHandlers` type land in `hostEvents.ts` (the `HostEventListener`-
// in-`bridge.ts` precedent) and are exported from the index beside `onHostEvent`; `types.ts` is NOT
// touched (website-sync tracks its bytes — D-PR6-11). The TYPE rows compile a probe through the
// TypeScript compiler API instead of importing the names: a literal `import type { HostEventHandlers }`
// of a name the index does not export yet would fail the package's `tsc -p tsconfig.test.json` pass
// and so every suite in it — here only these rows are red until the export lands.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd(); // packages/sdk
const SRC = path.join(ROOT, 'src');
const REPO = path.resolve(ROOT, '..', '..');
const PROBE = path.join(SRC, '__tests__', '__host-events-surface-probe__.ts');

/** The type assertions, exactly as an app author would write them against the index. */
const PROBE_SOURCE = `
import { expectTypeOf } from 'vitest';
import { onHostEvent, useHostEvents } from '../index.js';
import type { HostEventHandlers, HostEventListener } from '../index.js';

expectTypeOf<HostEventHandlers>().toEqualTypeOf<Readonly<Record<string, HostEventListener>>>();
expectTypeOf(useHostEvents).parameters.toEqualTypeOf<[HostEventHandlers]>();
expectTypeOf(useHostEvents).returns.toEqualTypeOf<void>();
expectTypeOf(onHostEvent).returns.toEqualTypeOf<() => void>();
// The gmail adoption (D-PR6-8) type-checks as written.
useHostEvents({ 'connection-event': (payload: unknown) => { void payload; } });
// @ts-expect-error a handler must be a HostEventListener, not a string
useHostEvents({ 'connection-event': 'refresh' });
`;

/** Type-checks the probe against the package's own test config; answers the probe's diagnostics as text. */
function probeDiagnostics(): string[] {
  const configPath = path.join(ROOT, 'tsconfig.test.json');
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    path.resolve(fileName) === PROBE ? ts.createSourceFile(fileName, PROBE_SOURCE, languageVersion, true) : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) => path.resolve(fileName) === PROBE || fileExists(fileName);
  host.readFile = (fileName) => (path.resolve(fileName) === PROBE ? PROBE_SOURCE : readFile(fileName));
  const program = ts.createProgram([PROBE], options, host);
  const probe = program.getSourceFile(PROBE);
  if (!probe) throw new Error('the probe did not load');
  return ts.getPreEmitDiagnostics(program, probe).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('the module surface for host events (PR-6 AC40c)', () => {
  it('types: useHostEvents(handlers: HostEventHandlers): void and HostEventHandlers = Readonly<Record<string, HostEventListener>>, both from the index', () => {
    expect(probeDiagnostics()).toEqual([]);
  }, 60_000);

  it('HostEventHandlers is declared in hostEvents.ts — never in types.ts', () => {
    const file = path.join(SRC, 'hostEvents.ts');
    expect(existsSync(file), 'packages/sdk/src/hostEvents.ts exists').toBe(true);
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/^export type HostEventHandlers = Readonly<Record<string, HostEventListener>>;/m);
    expect(source).toMatch(/^export function useHostEvents\(handlers: HostEventHandlers\): void/m);
    expect(readFileSync(path.join(SRC, 'types.ts'), 'utf8')).not.toContain('HostEventHandlers');
  });

  it('types.ts is byte-identical to the bytes the website-sync record pins (D-PR6-11 — no website sync in PR-6)', () => {
    const record = JSON.parse(readFileSync(path.join(REPO, 'apps', 'website', 'docs-sync.json'), 'utf8')) as unknown;
    const pinned: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const entry = node as Record<string, unknown>;
        if (entry.path === 'packages/sdk/src/types.ts' && typeof entry.sha256 === 'string') pinned.push(entry.sha256);
        Object.values(entry).forEach(walk);
      }
    };
    walk(record);
    expect(pinned.length, 'docs-sync.json tracks packages/sdk/src/types.ts').toBeGreaterThan(0);
    const actual = createHash('sha256').update(readFileSync(path.join(SRC, 'types.ts'))).digest('hex');
    for (const sha of pinned) expect(actual).toBe(sha);
  });

  it('the three comment blocks (index.ts, schedule.ts, access.ts) no longer say the embedded form has no hook — both forms carry it', () => {
    for (const file of ['index.ts', 'schedule.ts', 'access.ts']) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      expect(source, file).not.toMatch(/embedded form has no hook/i);
      expect(source, file).not.toMatch(/snippet beside the (copy-exactly )?block/i);
      expect(source, file).not.toMatch(/not as a hook/i);
    }
  });
});
