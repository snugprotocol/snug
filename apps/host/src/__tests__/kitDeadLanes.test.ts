// kitDeadLanes.test.ts — the chat's data lane, and PR-2's chat door and brain's ask on top of
// it, are swapped OUT of the kit page (TASK-20261010-host-broker PR-2, the owner's kit-ceiling
// decision 2026-10-11: cut dead bytes instead of raising KIT_SIZE_CEILING_BYTES).
//
// WHY THE CUT IS TRUE. Every kit binding — artifact, artifact-static, file and the local
// runner's page (the MCP binding) — pins the platform brain: the HOST brain, composed
// `tools: false`, or the DEMO brain. Under that pin `resolveBrain` answers host or demo
// whatever the WebLLM flag says; the chat classifier is skipped under the host brain
// (`classifierApplies`) and has no wire under the demo brain (`decideWire` → unavailable), so
// a chat turn in the kit never gets a lane, `laneToolsFor` is never asked for one, and the
// tool-free builder never builds `access_propose`. The modules are therefore shipped but
// unreachable; the kit swaps them for stubs by resolved path (`swapResolved`, whose dead-swap
// guard fails the build if a swap stops being hit). The playground and the desktop keep the
// real modules — they are not built from this config.
//
// WHAT THIS FILE PINS, so the cut cannot rot into a silent loss:
//   1. the five swaps are in the ONE config, each to a stub under `src/stubs/`;
//   2. every kit host brain is composed `tools: false`, and a pinned brain resolves to host
//      or demo whatever the WebLLM flag — the invariant the cut stands on (a kit binding that
//      ever gains a keyed or tool-calling brain reds HERE, not silently in production);
//   3. each stub exports every runtime name the real module exports (no import breaks), and
//      imports nothing from the module it replaces (no bytes ride back in);
//   4. the stubs answer the kit's only reachable calls inertly and fail LOUDLY, by name, on a
//      call the invariant says cannot happen.
//
// TASK-20261010-host-broker PR-4 (AC29; contract v2 D-PR4-15) — section 5: the scheduled agent
// (`schedule/appAgent.ts`, *Ask <App>'s AI* that can look things up) rides out of the kit the same
// way. The kit runs the scheduler, but the executors' brain gates send every kit brain AWAY from the
// agent before it is reached: the demo brain is refused (`blockedBy: 'brain'`) and the host brain —
// composed `tools: false` — has no data lane (`chatDoorOpen` is false for it), so a tools step
// degrades to the tool-free step. The swap is pinned with that invariant; the stub keeps the real
// module's runtime names and throws the one loud sentence.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

// PR-5 (D-PR5-16, F20): the stubs' shapes against the real modules' — type-only, erased at runtime.
import type { AccessCardState as RealAccessCardState } from '@playground/agent/accessCard.js';
import type { AccessProposal as RealAccessProposal } from '@playground/agent/accessProposeTool.js';
import type { AccessWriteCardState as RealAccessWriteCardState } from '@playground/agent/accessWriteCard.js';
import type { AccessCardState as StubAccessCardState } from '../stubs/accessCard.js';
import type { AccessProposal as StubAccessProposal } from '../stubs/accessProposeTool.js';
import type { AccessWriteCardState as StubAccessWriteCardState } from '../stubs/accessWriteCard.js';

const HOST = path.resolve(__dirname, '../..');
const PLAYGROUND = path.resolve(HOST, '../playground/src');
const read = (file: string): string => readFileSync(file, 'utf8');

/** Source with comments blanked — a rule must not be satisfied by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The five playground modules the kit swaps out, and the stub each becomes. */
const SWAPS = [
  { real: 'agent/chatRouter.ts', stub: 'src/stubs/chatRouter.ts' },
  { real: 'agent/laneTools.ts', stub: 'src/stubs/laneTools.ts' },
  { real: 'agent/accessProposeTool.ts', stub: 'src/stubs/accessProposeTool.ts' },
  { real: 'agent/accessCard.ts', stub: 'src/stubs/accessCard.ts' },
  { real: 'access/AccessCard.tsx', stub: 'src/stubs/AccessCard.tsx' },
] as const;

/** Runtime (value) export names of a module's source: functions, async functions, classes, consts, lets. */
function valueExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of stripComments(source).matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/** Every module specifier a source imports (static and dynamic, type-only included). */
function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

/** Load a stub through a variable specifier so this file transforms before the stubs exist. */
async function stub<T>(file: string): Promise<T> {
  const specifier = path.join(HOST, file);
  return (await import(/* @vite-ignore */ specifier)) as T;
}

const LOUD = /host kit has no data lane/;

describe('1 — the five swaps live in the ONE kit config', () => {
  const config = stripComments(read(path.join(HOST, 'vite.config.ts')));

  it.each(SWAPS)('vite.config.ts swaps $real for $stub by resolved path', ({ real, stub: target }) => {
    const realPath = real.replace(/\./g, '\\.');
    const targetPath = target.replace(/^src\//, '').replace(/\./g, '\\.');
    expect(config).toMatch(new RegExp(String.raw`\[\`\$\{playgroundSrc\}/${realPath}\`\]\s*:\s*here\('\./src/${targetPath}'\)`));
  });

  it('the swaps sit inside the swapResolved table (the dead-swap guard covers them)', () => {
    const table = config.slice(config.indexOf('swapResolved({'), config.indexOf('}),', config.indexOf('swapResolved({')));
    for (const { real } of SWAPS) expect(table).toContain(`/${real}\``);
  });
});

describe('2 — the invariant the cut stands on: a kit brain never opens the data lane', () => {
  it('every host brain the kit composes is tool-free (`tools: false`) — the probe’s hosted brain and the local runner’s', () => {
    for (const file of ['src/probe.ts', 'src/local/compose-local.ts']) {
      const code = stripComments(read(path.join(HOST, file)));
      const hostBrains = [...code.matchAll(/kind:\s*'host'/g)].length;
      expect(hostBrains, `${file} composes a host brain`).toBeGreaterThan(0);
      // Every `tools:` seat in the brain composition answers false; none answers true or a variable.
      const toolSeats = [...code.matchAll(/\btools:\s*([^,\n}]+)/g)].map((match) => match[1]!.trim());
      expect(toolSeats.length, `${file} declares the tools seat`).toBeGreaterThan(0);
      expect(toolSeats.every((value) => value === 'false'), `${file} tools seats: ${toolSeats.join(', ')}`).toBe(true);
    }
  });

  it('a PINNED platform brain resolves to host or demo whatever the WebLLM flag and the GPU say', async () => {
    const { resolveBrain } = await import('@playground/state/webllm.js');
    const pins = [{ kind: 'demo' as const }, { kind: 'host' as const, label: 'kit', adapter: { complete: async () => ({ ok: false as const, code: 'X', message: 'x', retryable: false }) }, streaming: true, tools: false }];
    for (const pinned of pins) {
      for (const flag of [false, true]) {
        for (const gpu of ['yes', 'no', 'unknown'] as const) {
          expect(['host', 'demo']).toContain(resolveBrain(flag, gpu, pinned as never).kind);
        }
      }
    }
  });

  it('the REAL chat router skips the classifier under the host brain — the lane the stubs remove is unreachable there', async () => {
    const { classifierApplies } = await import('@playground/agent/chatRouter.js');
    expect(classifierApplies({ brain: 'host', contextTarget: 'app-1', serverTurn: false })).toBe(false);
  });
});

describe('3 — each stub keeps the real module’s runtime surface and pulls none of its bytes back', () => {
  it.each(SWAPS)('$stub exports every runtime name $real exports', ({ real, stub: target }) => {
    const realNames = valueExports(read(path.join(PLAYGROUND, real)));
    const stubNames = valueExports(read(path.join(HOST, target)));
    expect(realNames.length).toBeGreaterThan(0);
    expect(stubNames).toEqual(expect.arrayContaining(realNames));
  });

  it.each(SWAPS)('$stub imports nothing from the playground (type-only imports of shapes excepted)', ({ stub: target }) => {
    const code = stripComments(read(path.join(HOST, target)));
    // A value import from the playground would drag the swapped module's graph back into the page.
    const valueImports = [...code.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]!);
    expect(valueImports.filter((spec) => spec.startsWith('@playground') || spec.includes('playground/src'))).toEqual([]);
    expect(importSpecifiers(code).filter((spec) => /chatRouter|laneTools|accessProposeTool|accessCard|AccessCard|dataTools|providerTools|inferrerAdapter/.test(spec) && !/^\.\//.test(spec))).toEqual([]);
  });
});

describe('4 — the stubs answer the kit’s reachable calls inertly and fail LOUDLY on the rest', () => {
  it('chatRouter: classifierApplies is false for every brain; routeChatMessage refuses by name', async () => {
    const mod = await stub<typeof import('@playground/agent/chatRouter.js')>('src/stubs/chatRouter.ts');
    for (const brain of ['settings', 'webllm', 'demo', 'host'] as const) {
      expect(mod.classifierApplies({ brain, contextTarget: 'app-1', serverTurn: false })).toBe(false);
    }
    await expect(mod.routeChatMessage({} as never)).rejects.toThrow(LOUD);
    expect(mod.MIN_ROUTING_CONFIDENCE).toBeTypeOf('number');
    expect(mod.DEFAULT_CLARIFY_QUESTION).toBeTypeOf('string');
  });

  it('laneTools: an unrouted turn and the feature lane answer `undefined` (the builder set); a routed lane refuses by name', async () => {
    const mod = await stub<typeof import('@playground/agent/laneTools.js')>('src/stubs/laneTools.ts');
    await expect(mod.laneToolsFor(undefined, {} as never)).resolves.toBeUndefined();
    await expect(mod.laneToolsFor({ lane: 'feature', intent: 'feature_add' } as never, {} as never)).resolves.toBeUndefined();
    await expect(mod.laneToolsFor({ lane: 'data', intent: 'data_read' } as never, {} as never)).rejects.toThrow(LOUD);
  });

  it('accessProposeTool: the tool name is the real one; building the tool refuses by name', async () => {
    const real = await import('@playground/agent/accessProposeTool.js');
    const mod = await stub<typeof real>('src/stubs/accessProposeTool.ts');
    expect(mod.ACCESS_PROPOSE_TOOL_NAME).toBe(real.ACCESS_PROPOSE_TOOL_NAME);
    expect(() => mod.buildAccessProposeTool({} as never)).toThrow(LOUD);
  });

  it('accessCard: a persisted card renders as NO card (a row from another host), the reads answer nothing, staging refuses by name', async () => {
    const mod = await stub<typeof import('@playground/agent/accessCard.js')>('src/stubs/accessCard.ts');
    const persisted = { access: { purpose: 'to compare spending', appId: 'app-1', threadId: 't-1' } };
    expect(mod.metaToAccessCard(persisted)).toBeUndefined();
    expect(mod.readAccessCardRow({ listChatMessages: () => [], getThread: () => undefined } as never, 't-1', 1)).toBeUndefined();
    expect(() => mod.persistAccessResolution({} as never, {} as never)).not.toThrow();
    expect(() => mod.stageAccessCard({ purpose: 'x' }, { appId: 'app-1', threadId: 't-1' })).toThrow(LOUD);
    expect(() => mod.accessCardToMeta({} as never)).toThrow(LOUD);
  });

  it('AccessCard: renders nothing', async () => {
    const mod = await stub<typeof import('@playground/access/AccessCard.js')>('src/stubs/AccessCard.tsx');
    expect(mod.AccessCard({ card: {} as never, messageId: 1, busy: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 5 — TASK-20261010-host-broker PR-4: the scheduled agent is swapped out too (D-PR4-15)
// ---------------------------------------------------------------------------------------------

const AGENT_SWAP = { real: 'schedule/appAgent.ts', stub: 'src/stubs/appAgent.ts' } as const;

describe('5 — the scheduled agent (schedule/appAgent.ts) is swapped for a loud stub, with the invariant that makes it dead', () => {
  const config = stripComments(read(path.join(HOST, 'vite.config.ts')));

  it('vite.config.ts swaps schedule/appAgent.ts for src/stubs/appAgent.ts by resolved path, inside the swapResolved table', () => {
    expect(config).toMatch(/\[`\$\{playgroundSrc\}\/schedule\/appAgent\.ts`\]\s*:\s*here\('\.\/src\/stubs\/appAgent\.ts'\)/);
    const table = config.slice(config.indexOf('swapResolved({'), config.indexOf('}),', config.indexOf('swapResolved({')));
    expect(table).toContain('/schedule/appAgent.ts`');
  });

  it('the stub exports every runtime name the real module exports', () => {
    const realNames = valueExports(read(path.join(PLAYGROUND, AGENT_SWAP.real)));
    const stubNames = valueExports(read(path.join(HOST, AGENT_SWAP.stub)));
    expect(realNames).toContain('executeAppAgent');
    expect(stubNames).toEqual(expect.arrayContaining(realNames));
  });

  it('the stub imports no value from the playground and none of the agent’s graph', () => {
    const code = stripComments(read(path.join(HOST, AGENT_SWAP.stub)));
    const valueImports = [...code.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]!);
    expect(valueImports.filter((spec) => spec.startsWith('@playground') || spec.includes('playground/src'))).toEqual([]);
    expect(importSpecifiers(code).filter((spec) => /appAgent|gatedAdapter|fetchConnectionTool|dataTools|providerTools|proposalGate|@snugprotocol\/adapters/.test(spec) && !/^\.\//.test(spec))).toEqual([]);
  });

  it('executeAppAgent fails LOUDLY, by name', async () => {
    const mod = await stub<{ executeAppAgent: (...args: unknown[]) => Promise<unknown> }>(AGENT_SWAP.stub);
    await expect(Promise.resolve().then(() => mod.executeAppAgent({} as never, {} as never))).rejects.toThrow(LOUD);
    await expect(Promise.resolve().then(() => mod.executeAppAgent({} as never, {} as never))).rejects.toThrow(/appAgent\.executeAppAgent/);
  });

  it('the invariant: no kit brain opens the data lane the agent needs — the host brain and the demo brain both answer chatDoorOpen false', async () => {
    const { chatDoorOpen } = await import('@playground/access/egress.js');
    expect(chatDoorOpen({ kind: 'host', provider: 'mock', keyMissing: false, hostLabel: 'kit' })).toBe(false);
    expect(chatDoorOpen({ kind: 'demo', provider: 'mock', keyMissing: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 6 — TASK-20261010-host-broker PR-5: the chat's cross-app write rides out of the kit too (D-PR5-16)
// ---------------------------------------------------------------------------------------------
//
// The chat's cross-app card — its state module `agent/accessWriteCard.ts` (which exports
// `approveCrossAppWrite`) and its surface `access/AccessWriteCard.tsx` — is swapped for stubs the
// same way: no kit turn is ever routed to the data lane (sections 2 and 5), so no card is ever staged
// and a persisted one from another host renders as NO card. The chat's write verbs
// (`access/chatWrite.ts`) stay OUTSIDE the kit graph by construction: their ONLY importers are
// `agent/laneTools.ts` and `agent/accessWriteCard.ts`, both swapped (D-PR5-12, SC13). The stubs
// mirror the real modules' TYPES (`expectTypeOf`, checked by the package's `tsc -p
// tsconfig.test.json` step) so a shape that drifts on one side reds here, not in a page.

const SWAPS_PR5 = [
  { real: 'agent/accessWriteCard.ts', stub: 'src/stubs/accessWriteCard.ts' },
  { real: 'access/AccessWriteCard.tsx', stub: 'src/stubs/AccessWriteCard.tsx' },
] as const;

const NUMBER_WORDS: Readonly<Record<number, string>> = { 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };

describe('6 — PR-5 D-PR5-16: the cross-app card is swapped for loud stubs, and the chat’s write verbs are reachable only through swapped modules', () => {
  const raw = read(path.join(HOST, 'vite.config.ts'));
  const config = stripComments(raw);
  const table = config.slice(config.indexOf('swapResolved({'), config.indexOf('}),', config.indexOf('swapResolved({')));

  it.each(SWAPS_PR5)('vite.config.ts swaps $real for $stub by resolved path, inside the swapResolved table', ({ real, stub: target }) => {
    const realPath = real.replace(/\./g, '\\.');
    const targetPath = target.replace(/^src\//, '').replace(/\./g, '\\.');
    expect(config).toMatch(new RegExp(String.raw`\[\`\$\{playgroundSrc\}/${realPath}\`\]\s*:\s*here\('\./src/${targetPath}'\)`));
    expect(table).toContain(`/${real}\``);
  });

  it('the header’s count of swapped modules is the table’s: ten (was eight)', () => {
    const entries = [...table.matchAll(/\[`\$\{playgroundSrc\}\/[^`]+`\]\s*:/g)].length;
    expect(entries).toBe(10);
    expect(raw).toContain(`${NUMBER_WORDS[entries]} modules are swapped by resolved path`);
  });

  it.each(SWAPS_PR5)('$stub exports every runtime name $real exports', ({ real, stub: target }) => {
    const realNames = valueExports(read(path.join(PLAYGROUND, real)));
    const stubNames = valueExports(read(path.join(HOST, target)));
    expect(realNames.length).toBeGreaterThan(0);
    expect(stubNames).toEqual(expect.arrayContaining(realNames));
  });

  it.each(SWAPS_PR5)('$stub imports no value from the playground and none of the card’s graph', ({ stub: target }) => {
    const code = stripComments(read(path.join(HOST, target)));
    const valueImports = [...code.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]!);
    expect(valueImports.filter((spec) => spec.startsWith('@playground') || spec.includes('playground/src'))).toEqual([]);
    expect(importSpecifiers(code).filter((spec) => /chatWrite|writeBroker|accessWriteCard|AccessWriteCard|AccessSheet|dataTools|grants/.test(spec) && !/^\.\//.test(spec))).toEqual([]);
  });

  it('accessWriteCard: a persisted cross-app card renders as NO card; approving refuses by name', async () => {
    const mod = await stub<{ metaToAccessWrite: (meta: unknown) => unknown; approveCrossAppWrite: (...args: unknown[]) => Promise<unknown> }>('src/stubs/accessWriteCard.ts');
    const persisted = {
      accessWrite: {
        appId: 'app-1',
        target: { grantId: '11111111-1111-4111-8111-111111111111', grantedAt: '2026-10-12T09:00:00.000Z', sourceAppId: 'app-2', table: 'transactions' },
        sql: 'UPDATE "transactions" SET amount = 1 WHERE id = 1',
        previewed: 1,
      },
    };
    expect(mod.metaToAccessWrite(persisted)).toBeUndefined();
    await expect(Promise.resolve().then(() => mod.approveCrossAppWrite({} as never, {} as never))).rejects.toThrow(LOUD);
    await expect(Promise.resolve().then(() => mod.approveCrossAppWrite({} as never, {} as never))).rejects.toThrow(/accessWriteCard\.approveCrossAppWrite/);
  });

  it('AccessWriteCard: renders nothing', async () => {
    const mod = await stub<{ AccessWriteCard: (props: Record<string, unknown>) => unknown }>('src/stubs/AccessWriteCard.tsx');
    expect(mod.AccessWriteCard({ card: {} as never, messageId: 1, busy: false })).toBeNull();
  });

  it('SC13 — access/chatWrite.ts exists and its ONLY importers in the playground are agent/laneTools.ts and agent/accessWriteCard.ts (both swapped)', () => {
    const target = path.join(PLAYGROUND, 'access', 'chatWrite.ts');
    expect(existsSync(target), 'access/chatWrite.ts exists (D-PR5-12)').toBe(true);
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || full === target) continue;
        const specs = importSpecifiers(read(full));
        const reaches = specs.some((spec) => spec.startsWith('.') && path.resolve(path.dirname(full), spec.replace(/\.js$/, '.ts')) === target);
        if (reaches) importers.push(path.relative(PLAYGROUND, full));
      }
    };
    walk(PLAYGROUND);
    expect(importers.sort()).toEqual([path.join('agent', 'accessWriteCard.ts'), path.join('agent', 'laneTools.ts')]);
    // …and both importers are swapped out of the kit, so no kit byte reaches the verbs.
    const swapped = [...SWAPS, ...SWAPS_PR5].map((swap) => swap.real);
    for (const importer of importers) expect(swapped, importer).toContain(importer.split(path.sep).join('/'));
  });

  it('F20 — the stubs mirror the real modules’ TYPES: AccessCardState, AccessProposal, AccessWriteCardState (checked by tsc)', () => {
    expectTypeOf<StubAccessCardState>().toEqualTypeOf<RealAccessCardState>();
    expectTypeOf<StubAccessProposal>().toEqualTypeOf<RealAccessProposal>();
    expectTypeOf<StubAccessWriteCardState>().toEqualTypeOf<RealAccessWriteCardState>();
  });
});
