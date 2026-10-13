// host-events-kb.test.ts — TASK-20261010-host-broker PR-6 (contract v2 D-PR6-3, D-PR6-6; AC40f; ADR-0034).
//
// KB 90 (served, NOT inline) teaches `useHostEvents` with the one event the host rings for every
// connected app — the connection wizard's "load my real data" signal — in ONE short paragraph and ONE
// javascript fence, and says that scheduled runs and the access hints have their own hooks.
//
// The event name and its seat are READ from the host that rings it (`apps/playground/src/state/
// appHosts.ts`, `notifyAppRefresh`), never retyped: a KB that taught a different name or seat would
// produce apps whose refresh never fires, and nothing else would catch it.
//
// A NEW file, not a row in auth-kb.test.ts: that suite pins the connection-requirement directive and
// iterates json fences; this claim is about the hooks block and its host-events seat.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { INLINE_KNOWLEDGE_CORE_FILES, getKnowledgeBase } from '../index.js';
import { repoRoot } from './helpers.js';

const KB_FILE = 'knowledge-base/app-authoring/90-auth-and-connected-apis.md';

/** The event and the seat the host rings, read from `notifyAppRefresh`. */
const HOST_SIGNAL = (() => {
  const source = readFileSync(path.join(repoRoot, 'apps', 'playground', 'src', 'state', 'appHosts.ts'), 'utf8');
  const match = /export function notifyAppRefresh\([\s\S]*?entry\.notify\('([\w-]+)', \{ ([^}]+) \}\)/.exec(source);
  if (match === null) throw new Error("apps/playground/src/state/appHosts.ts's notifyAppRefresh no longer rings entry.notify('<event>', { … })");
  const seats = (match[2] as string).split(',').map((part) => (part.split(':')[0] as string).trim());
  return { event: match[1] as string, seats };
})();

/** The copy-exactly hooks block every app carries (PR-6: sections 1–7). */
const EMBEDDED_HOOKS = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'embedded', 'snug-hooks.js'), 'utf8');

function rendered(): string {
  const section = getKnowledgeBase().find((doc) => doc.file === KB_FILE);
  expect(section, `${KB_FILE} missing from the knowledge base`).toBeDefined();
  return (section as { text: string }).text;
}

/** Every fenced ```javascript block in the rendered teaching. */
const fencedJs = (text: string): string[] => [...text.matchAll(/```javascript\r?\n([\s\S]*?)\r?\n```/g)].map((m) => (m[1] as string).trim());

/** The page's prose paragraphs: fences and headings removed, blank-line separated, whitespace folded. */
const paragraphs = (text: string): string[] =>
  text
    .replace(/```[\s\S]*?```/g, '\n\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => !/^#{1,6} /.test(line)).join(' ').replace(/\s+/g, ' ').trim())
    .filter((block) => block !== '');

describe('the host signal KB 90 teaches is the one the host rings (read from appHosts.ts)', () => {
  it('the host rings connection-event with { slot, verified, requestRefresh } — the source this file reads', () => {
    expect(HOST_SIGNAL.event).toBe('connection-event');
    expect(HOST_SIGNAL.seats).toEqual(['slot', 'verified', 'requestRefresh']);
  });
});

describe('PR-6 — KB 90 teaches useHostEvents in ONE paragraph and ONE fence (D-PR6-3)', () => {
  it('the page stays out of the inline core (served only)', () => {
    expect(INLINE_KNOWLEDGE_CORE_FILES).not.toContain(KB_FILE);
  });

  it('carries exactly ONE javascript fence, and it subscribes with useHostEvents to the host’s real event, checking the slot and requestRefresh', () => {
    const fences = fencedJs(rendered());
    expect(fences).toHaveLength(1);
    const fence = fences[0] as string;
    expect(fence).toContain('useHostEvents({');
    expect(fence).toContain(`'${HOST_SIGNAL.event}':`);
    expect(HOST_SIGNAL.seats).toContain('slot');
    expect(HOST_SIGNAL.seats).toContain('requestRefresh');
    expect(fence).toMatch(/\.slot === '[^']+'/);
    expect(fence).toMatch(/\.requestRefresh\b/);
  });

  it('NEGATIVE: the fence reads nothing the seat does not carry — no credential, no raw listener, no other hook’s events', () => {
    const fence = fencedJs(rendered())[0] ?? '';
    // C1: the signal names a slot, never a secret — the app never sees one.
    expect(fence).not.toMatch(/token|secret|password|api_?key|credential/i);
    expect(fence).not.toContain("addEventListener('message'");
    expect(fence).not.toContain('SnugBridge');
    for (const other of ['schedule-run', 'access-changed', 'access-source-changed', 'data-changed', 'access-read']) {
      expect(fence, `${other} has its own hook`).not.toContain(`'${other}'`);
    }
  });

  it('teaches it in ONE paragraph — the one that names useHostEvents — which says scheduled runs and the access hints have their own hooks', () => {
    const about = paragraphs(rendered()).filter((paragraph) => paragraph.includes('useHostEvents'));
    expect(about, 'one paragraph names useHostEvents').toHaveLength(1);
    const paragraph = about[0] as string;
    expect(paragraph).toContain(`\`${HOST_SIGNAL.event}\``);
    expect(paragraph).toMatch(/schedul/i);
    expect(paragraph).toMatch(/access/i);
    expect(paragraph).toMatch(/own hooks?/i);
  });

  it('useHostEvents is a function the embedded hooks block defines', () => {
    expect(EMBEDDED_HOOKS).toContain('function useHostEvents(handlers)');
  });
});
