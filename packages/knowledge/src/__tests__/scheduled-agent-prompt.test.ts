// scheduled-agent-prompt.test.ts — TASK-20261010-host-broker PR-4 (AC29; contract v2 D-PR4-15, D-PR4-16,
// D8 of the design review; feasibility F7).
//
// The scheduled agent's system prompt is a NEW branch of `buildHostSystemPrompt`:
// `{ scheduledAgent: true }` assembles
//
//   10-host-identity + the new `scheduled-agent` system layer [+ 95-platform-desktop on desktop]
//
// and NOTHING else — never 45-app-runtime ("answer the app's request and nothing else") and never
// 40-app-response-format ("respond with ONLY a valid JSON object"): the agent answers a person later,
// in words, after looking things up with tools. The app's runtime contract is appended by the caller
// as the END suffix through `SYSTEM_BLOCK_SEPARATOR` (the transport's rule, ADR-0012), so the
// desktop layer must be the assembly's LAST block; a contract-less app runs on identity + preamble.
//
// The preamble (the `scheduled-agent` layer) says: nobody is watching; the tools; the cap; changes
// wait for the user unless this schedule may make them on its own; and — D8, byte for byte —
// *never say a change was made — say what you proposed; the host reports what it made*. Being one
// static layer for armed and unarmed tasks alike, it never says the changes are "never run
// automatically" (false for an armed task) and states the capture rule instead.
//
// Pinned through the accessors (`getSystemLayer`, the generated store); the call passes the two
// required seats as false so the type holds whichever way the implementation types the new flag.
// RED until the layer, its name and the branch land AND `gen:content` regenerates the store.

import { describe, expect, it } from 'vitest';

import { SYSTEM_BLOCK_SEPARATOR, buildHostSystemPrompt, getSystemLayer, renderRuntimeContract, type SystemLayerName } from '../index.js';

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const LAYER: SystemLayerName = 'scheduled-agent';
const preamble = (): string => flat(getSystemLayer(LAYER));
const D8 = /[Nn]ever say a change was made — say what you proposed; the host reports what it made/;

const scheduled = (platform?: 'web' | 'desktop' | 'host'): string =>
  buildHostSystemPrompt({ appBuilder: false, artifacts: false, scheduledAgent: true, ...(platform !== undefined ? { platform } : {}) });

describe('buildHostSystemPrompt({ scheduledAgent: true }) — the assembly', () => {
  it('the layer is registered under its name', () => {
    expect(() => getSystemLayer(LAYER)).not.toThrow();
    expect(preamble().length).toBeGreaterThan(0);
  });

  it('is EXACTLY identity + the scheduled-agent layer on the web (absent platform and "web" alike)', () => {
    const expected = [getSystemLayer('host-identity'), getSystemLayer(LAYER)].join(SYSTEM_BLOCK_SEPARATOR);
    expect(scheduled()).toBe(expected);
    expect(scheduled('web')).toBe(expected);
  });

  it('the host kit assembles byte-identically to the web', () => {
    expect(scheduled('host')).toBe(scheduled('web'));
  });

  it('desktop appends 95-platform-desktop LAST — the web assembly is a strict prefix of it', () => {
    const desktop = scheduled('desktop');
    expect(desktop).toBe([getSystemLayer('host-identity'), getSystemLayer(LAYER), getSystemLayer('platform-desktop')].join(SYSTEM_BLOCK_SEPARATOR));
    expect(desktop.startsWith(scheduled('web'))).toBe(true);
  });

  it('never carries 45-app-runtime or 40-app-response-format', () => {
    for (const platform of ['web', 'desktop'] as const) {
      const text = scheduled(platform);
      expect(text).not.toContain(getSystemLayer('app-runtime'));
      expect(text).not.toContain(getSystemLayer('app-response-format'));
    }
  });

  it('wins over the builder seats — never an authoring layer, whatever else is asked', () => {
    const text = buildHostSystemPrompt({ appBuilder: true, artifacts: true, scheduledAgent: true });
    expect(text).toBe(scheduled());
    expect(text).not.toContain(getSystemLayer('capability-file-creation'));
    expect(text).not.toContain(getSystemLayer('app-builder-summary'));
  });

  it('a runtime contract rides as the END suffix after the last layer (desktop included)', () => {
    const contract = { overview: 'Ledger keeps the month’s spending.' };
    const system = `${scheduled('desktop')}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`;
    expect(system.endsWith(renderRuntimeContract(contract))).toBe(true);
    expect(system.indexOf(getSystemLayer('platform-desktop'))).toBeLessThan(system.indexOf('## About This App'));
    // The layer count is the assembly's plus the contract: no layer of the preamble can be forged by it.
    expect(system.split(SYSTEM_BLOCK_SEPARATOR)).toHaveLength(4);
  });

  it('the existing branches are untouched by the new seat (appRuntime and the builder assemble as before)', () => {
    const runtime = buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true });
    expect(runtime).toBe([getSystemLayer('host-identity'), getSystemLayer('app-runtime'), getSystemLayer('app-response-format')].join(SYSTEM_BLOCK_SEPARATOR));
    expect(buildHostSystemPrompt({ appBuilder: false, artifacts: false })).toBe(getSystemLayer('host-identity'));
  });
});

describe('the scheduled-agent preamble — what it says', () => {
  it('D8, byte for byte: never say a change was made — say what you proposed; the host reports what it made', () => {
    expect(preamble()).toMatch(D8);
  });

  it('nobody is watching', () => {
    expect(preamble()).toMatch(/\b(?:nobody|no one|no-one)\b[^.]*\b(?:watching|here|present)\b/i);
  });

  it('names its three tools', () => {
    const text = preamble();
    for (const tool of ['data_query', 'data_propose_write', 'fetch_connection']) expect(text).toContain(tool);
  });

  it('says the cap — eight look-ups', () => {
    expect(preamble()).toMatch(/\b(?:8|eight)\b[^.]*\b(?:tool calls?|look-?ups?|calls?)\b/i);
  });

  it('changes wait for the user unless this schedule may make them on its own', () => {
    const text = preamble();
    expect(text).toMatch(/\bwait(?:s|ing)?\b[^.]*\b(?:user|person)\b/i);
    expect(text).toMatch(/\bon its own\b/i);
  });

  it('states the capture rule (one static layer for armed and unarmed tasks alike)', () => {
    expect(preamble()).toContain('no functions, arithmetic or conflict clause');
  });

  it('never says the changes are “never run automatically” (false for an armed task)', () => {
    expect(preamble()).not.toContain('never run automatically');
  });

  it('never asks for a JSON-only reply (the 40 layer’s job, which this branch does not carry)', () => {
    expect(preamble()).not.toMatch(/respond with ONLY a valid JSON object/i);
  });
});
