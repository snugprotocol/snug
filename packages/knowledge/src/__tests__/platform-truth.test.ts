// TASK-20260812-desktop-auth-awareness P2 — platform truth in prompts (AC1) and in the
// inference user slot (AC2). Written RED-FIRST at Gate 3: before the implementation,
// the `platform` seat does not exist (tsc-gated red), `95-platform-desktop` is not a
// layer (accessor throws), and the stale claims are still in the KB sources (grep red).
//
// The claims under test, each traceable to the task file:
//   - AC1 web half: absent platform and platform 'web' assemble BYTE-IDENTICALLY, and
//     neither ever carries desktop copy. The pre-change golden snapshots in
//     assembly.test.ts are deliberately untouched by this phase — that diff staying
//     empty IS the "byte-identical to the pre-change snapshot" proof for layers 10–40.
//   - AC1 desktop half: 'desktop' appends the 95-platform-desktop layer exactly once,
//     LAST, through the same separator discipline as every other layer, carrying the
//     user-typed-LAN rule (P0 security amendment 15) and none of the stale claims.
//   - Stale-claim truth at the SOURCE: "a FUTURE rung that does not exist yet" and the
//     unconditional "blocks private ranges" are gone from prompt sources, so a future
//     paste-back regression fails loudly here rather than resurfacing as model copy.
//   - AC2: the connection-requirement inferrer's USER slot gains the pinned
//     `Platform facts (desktop):` block on desktop ONLY; the SYSTEM slot stays static
//     (D2 placement pin) on every platform.
import { describe, expect, it } from 'vitest';

import {
  buildConnectionRequirementInferrerPrompt,
  buildHostSystemPrompt,
  getKnowledgeBase,
  getSystemLayer,
  SYSTEM_BLOCK_SEPARATOR,
  type HostSystemPromptOptions,
} from '../index.js';

import { isVendored, promptFilesOnDisk } from './helpers.js';

/** The stale claims ADR-0021 falsified. Substrings, exactly as they shipped. */
const STALE_CLAIMS = ['does not exist yet', 'blocks private ranges'] as const;

const WEB_COMBOS: HostSystemPromptOptions[] = [
  { appBuilder: false, artifacts: false },
  { appBuilder: false, artifacts: true },
  { appBuilder: true, artifacts: false },
  { appBuilder: true, artifacts: true },
  { appBuilder: false, artifacts: false, appRuntime: true },
];

describe('stale-claim truth test — the falsified copy is gone from the prompt sources', () => {
  for (const phrase of STALE_CLAIMS) {
    it(`no non-vendored prompt source still contains "${phrase}"`, () => {
      const hits = promptFilesOnDisk()
        .filter((file) => !isVendored(file.rel) && file.rel.endsWith('.md') && file.rel !== 'README.md')
        .filter((file) => file.content.includes(phrase))
        .map((file) => file.rel);
      expect(hits, `stale claim "${phrase}" found in: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('the corrected 90-auth copy states the desktop truth AND the user-typed-LAN rule (amendment 15)', () => {
    const doc = getKnowledgeBase().find(
      (section) => section.file === 'knowledge-base/app-authoring/90-auth-and-connected-apis.md',
    );
    expect(doc).toBeDefined();
    const text = doc!.text;
    // Desktop native fetch is stated as REAL, not future…
    expect(text).toMatch(/desktop app/i);
    // …LAN reach is scoped to the desktop app and to user approval…
    expect(text).toMatch(/RFC-?1918/i);
    expect(text).toMatch(/desktop app only/i);
    // …the browser limit is stated as a BROWSER limit, not a universal one…
    expect(text).toMatch(/browser[^.]*private\s+ranges/i);
    // …and wherever LAN hosts are legal, the address is the USER'S to type (amendment 15).
    expect(text).toMatch(/typed by the user/i);
    expect(text).toMatch(/never propose,\s+guess, or invent/i);
  });

  it('the host-mediation framing survives the correction (true on every platform)', () => {
    const doc = getKnowledgeBase().find(
      (section) => section.file === 'knowledge-base/app-authoring/90-auth-and-connected-apis.md',
    );
    expect(doc!.text).toMatch(/every external HTTP call\s+travels through the host/i);
  });
});

describe('AC1 web half — absent and "web" platforms assemble byte-identically, desktop-copy-free', () => {
  it('platform "web" is byte-identical to no platform at all, for every gating combo', () => {
    for (const combo of WEB_COMBOS) {
      expect(buildHostSystemPrompt({ ...combo, platform: 'web' }), JSON.stringify(combo)).toBe(
        buildHostSystemPrompt(combo),
      );
    }
  });

  it('no web assembly contains the desktop layer or its heading', () => {
    const desktopLayer = getSystemLayer('platform-desktop');
    for (const combo of WEB_COMBOS) {
      const prompt = buildHostSystemPrompt(combo);
      expect(prompt, JSON.stringify(combo)).not.toContain(desktopLayer);
      // A marker that can fail independently of the accessor: the layer's own heading.
      expect(prompt, JSON.stringify(combo)).not.toContain('Snug Desktop App');
    }
  });
});

describe('AC1 desktop half — the 95-platform-desktop layer, separator-clean, last, exactly once', () => {
  it('builder assembly: appended LAST as its own block through the shared separator', () => {
    const prompt = buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'desktop' });
    const parts = prompt.split(SYSTEM_BLOCK_SEPARATOR);
    // 10 + 20 + (30+KB summary) + 40 + 95 — one more than the web assembly's four.
    expect(parts).toHaveLength(5);
    expect(parts[4]).toBe(getSystemLayer('platform-desktop'));
  });

  it('appears exactly ONCE (a duplicated layer would read as reinforcement)', () => {
    const prompt = buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'desktop' });
    const layer = getSystemLayer('platform-desktop');
    expect(prompt.split(layer)).toHaveLength(2);
  });

  it('appRuntime + desktop: identity + runtime doctrine + response format + desktop layer', () => {
    const prompt = buildHostSystemPrompt({
      appBuilder: false,
      artifacts: false,
      appRuntime: true,
      platform: 'desktop',
    });
    const parts = prompt.split(SYSTEM_BLOCK_SEPARATOR);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(getSystemLayer('host-identity'));
    expect(parts[1]).toBe(getSystemLayer('app-runtime'));
    expect(parts[2]).toBe(getSystemLayer('app-response-format'));
    expect(parts[3]).toBe(getSystemLayer('platform-desktop'));
  });

  it('carries the user-typed-LAN rule verbatim enough to bind (P0 security amendment 15)', () => {
    const layer = getSystemLayer('platform-desktop');
    expect(layer).toMatch(/always typed by the user/i);
    expect(layer).toMatch(/never propose,\s+guess, or invent/i);
  });

  it('states what the shell truly adds — native fetch, LAN reach, loopback OAuth, system browser', () => {
    const layer = getSystemLayer('platform-desktop');
    expect(layer).toMatch(/CORS/);
    expect(layer).toMatch(/RFC-?1918/i);
    expect(layer).toMatch(/loopback/i);
    expect(layer).toMatch(/system browser/i);
  });

  it('does NOT contradict C1/C2: mediation, credential custody, and the ceiling are restated', () => {
    const layer = getSystemLayer('platform-desktop');
    expect(layer).toMatch(/through the host/i);
    expect(layer).toMatch(/credentials stay\s+with the host/i);
    expect(layer).toMatch(/ceiling/i);
    // The browser wall stays a BROWSER statement, never "no walls anywhere".
    expect(layer).toMatch(/browser version of Snug\s+refuses private ranges/i);
  });

  it('never carries the stale claims the KB correction removed', () => {
    const prompt = buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'desktop' });
    for (const phrase of STALE_CLAIMS) expect(prompt).not.toContain(phrase);
  });

  it('golden: the desktop builder assembly is snapshot-locked (blast-radius review)', () => {
    expect(buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'desktop' })).toMatchSnapshot();
  });
});

describe('AC2 — the inferrer user slot gains platform facts on desktop ONLY; system stays static (D2)', () => {
  const base = {
    providerName: 'Tidepool Analytics',
    docsText: 'Tidepool Analytics API — pass your key in the X-Api-Key header.',
  };

  it('web and absent platforms produce byte-identical prompts, with no platform block', () => {
    const absent = buildConnectionRequirementInferrerPrompt(base);
    const web = buildConnectionRequirementInferrerPrompt({ ...base, platform: 'web' });
    expect(web.system).toBe(absent.system);
    expect(web.user).toBe(absent.user);
    expect(absent.user).not.toContain('Platform facts');
  });

  it('desktop: the user slot carries the pinned literal line and the three facts', () => {
    const { user } = buildConnectionRequirementInferrerPrompt({ ...base, platform: 'desktop' });
    // The PINNED literal — a whole line, exactly this spelling.
    expect(user).toMatch(/^Platform facts \(desktop\):$/m);
    expect(user).toMatch(/RFC-?1918/i);
    expect(user).toMatch(/typed by the user/i);
    expect(user).toMatch(/[Nn]ever propose/);
    expect(user).toMatch(/loopback/i);
  });

  it('the block is HOST-supplied fact: it sits above the <provider_docs> delimiter, outside it', () => {
    const { user } = buildConnectionRequirementInferrerPrompt({ ...base, platform: 'desktop' });
    const blockAt = user.indexOf('Platform facts (desktop):');
    expect(blockAt).toBeGreaterThanOrEqual(0);
    expect(blockAt).toBeLessThan(user.indexOf('<provider_docs>'));
  });

  it('the SYSTEM slot is byte-identical across platforms — runtime values never enter it', () => {
    const desktop = buildConnectionRequirementInferrerPrompt({ ...base, platform: 'desktop' });
    const absent = buildConnectionRequirementInferrerPrompt(base);
    expect(desktop.system).toBe(absent.system);
  });

  it('desktop platform facts change ONLY the user slot — docs handling is untouched', () => {
    const desktop = buildConnectionRequirementInferrerPrompt({ ...base, platform: 'desktop' });
    const absent = buildConnectionRequirementInferrerPrompt(base);
    // Same docs block, same tail — the platform block is an insertion, not a rewrite.
    expect(desktop.user).toContain('<provider_docs>');
    expect(desktop.user).toContain('Reply with the JSON object only.');
    expect(desktop.user.endsWith(absent.user.slice(absent.user.indexOf('<provider_docs>')))).toBe(true);
  });
});

// TASK-20260905-host-kit step 3: the host kit is a THIRD shell. It assembles exactly as
// 'web' does — the kit renders the playground's own tree inside a foreign host and owns
// no platform facts of its own (the desktop layer's LAN/loopback claims would be false
// there). Absent, 'web' and 'host' are byte-identical on both branches and in the
// inferrer's user slot; 'desktop' stays the one platform with a layer (positive twin).
describe("TASK-20260905-host-kit: 'host' assembles byte-identically to 'web'", () => {
  const builder = { appBuilder: true, artifacts: true } as const;
  const runtime = { appBuilder: false, artifacts: false, appRuntime: true } as const;

  it("builder branch: 'host' === 'web' === absent", () => {
    const web = buildHostSystemPrompt({ ...builder, platform: 'web' });
    const host = buildHostSystemPrompt({ ...builder, platform: 'host' });
    expect(host).toBe(web);
    expect(host).toBe(buildHostSystemPrompt(builder));
    expect(host).not.toContain(getSystemLayer('platform-desktop'));
  });

  it("app-runtime branch: 'host' === 'web' === absent", () => {
    const web = buildHostSystemPrompt({ ...runtime, platform: 'web' });
    const host = buildHostSystemPrompt({ ...runtime, platform: 'host' });
    expect(host).toBe(web);
    expect(host).toBe(buildHostSystemPrompt(runtime));
  });

  it("'desktop' still differs from 'host' (positive twin — the layer exists and lands on desktop only)", () => {
    const desktop = buildHostSystemPrompt({ ...builder, platform: 'desktop' });
    expect(desktop).not.toBe(buildHostSystemPrompt({ ...builder, platform: 'host' }));
    expect(desktop).toContain(getSystemLayer('platform-desktop'));
  });

  it("inferrer user slot: 'host' carries no platform facts, exactly like 'web'", () => {
    const input = { providerName: 'Acme', docsText: 'docs' } as const;
    const web = buildConnectionRequirementInferrerPrompt({ ...input, platform: 'web' });
    const host = buildConnectionRequirementInferrerPrompt({ ...input, platform: 'host' });
    expect(host).toEqual(web);
    expect(host).toEqual(buildConnectionRequirementInferrerPrompt(input));
  });
});
