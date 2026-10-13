// KB ≡ SDK sync (task AC-1): the copy-exactly hook block in the RENDERED knowledge-base
// template must equal embedded/snug-hooks.js after whitespace normalization. Editing
// either side without the other fails here — the sync discipline that keeps every
// generated app's bridge identical to the SDK reference implementation.
//
// TASK-20261010-host-broker PR-6 (AC40a): the block carries SEVEN sections — 1 the bridge (with
// the source guard and the access-response / host-event dispatch arms), 2–5 as before, 6
// `useHostEvents` + `useSnugSchedule`, 7 `useSnugAccess` — and every structural pin below holds
// over BOTH texts: the embedded file and the rendered KB 20 fence's hook block.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getKnowledgeBase } from '@snugprotocol/knowledge';
import {
  ACCESS_CANDIDATE_CLASSES,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
} from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

const TEMPLATE_FILE = 'knowledge-base/app-authoring/20-html-template.md';
const EMBEDDED_PATH = path.resolve(process.cwd(), 'embedded/snug-hooks.js');

/**
 * The hook portion of the rendered template: the `<script type="text/babel">` body of
 * the ```html fence, cut before the RESPONSE SCHEMA banner (app-authored, not SDK — section 8
 * once PR-6 adds sections 6 and 7; the banner is found by its words, never its number).
 * Throws loudly on structural drift so the extraction never silently shrinks.
 */
function renderedHookBlock(): string {
  const doc = getKnowledgeBase().find((s) => s.file === TEMPLATE_FILE);
  if (!doc) throw new Error(`${TEMPLATE_FILE} is missing from the rendered KB`);
  const html = /```html\n([\s\S]*?)\n```/.exec(doc.text)?.[1];
  if (html === undefined) throw new Error(`${TEMPLATE_FILE} has no \`\`\`html fenced template block`);
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error('template has no <script type="text/babel"> block');
  const lines = script.split('\n');
  const bannerIndex = lines.findIndex((line) => /\d+\. RESPONSE SCHEMA/.test(line));
  if (bannerIndex < 1) throw new Error('template script has no RESPONSE SCHEMA banner');
  return lines.slice(0, bannerIndex - 1).join('\n'); // also drops the ==== line above the banner
}

/** Whitespace normalization: per-line trim (tolerates the template's indentation), blank lines dropped. */
const normalize = (code: string): string =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

describe('KB ≡ SDK sync (20-html-template.md ↔ embedded/snug-hooks.js)', () => {
  it('the rendered KB hook block and embedded/snug-hooks.js are byte-identical after normalization', () => {
    const kb = normalize(renderedHookBlock());
    const embedded = normalize(readFileSync(EMBEDDED_PATH, 'utf8'));
    expect(embedded).toBe(kb);
  });

  it('the embedded file is fully rendered — no un-substituted {{placeholders}} survive', () => {
    const embedded = readFileSync(EMBEDDED_PATH, 'utf8');
    expect(embedded).not.toMatch(/\{\{[A-Za-z0-9_:-]+\}\}/);
    expect(embedded).toContain("'snug:host-ready'"); // frame literals injected from protocol constants
  });

  it('the embedded file covers all SEVEN copy-exactly sections and nothing app-authored (PR-6 AC40a — was five)', () => {
    const embedded = readFileSync(EMBEDDED_PATH, 'utf8');
    for (const name of [
      'SnugBridge',
      'function useSnugApp',
      'function usePersistedState',
      'function useAppDB',
      'function useConnectedFetch',
      'function useHostEvents',
      'function useSnugSchedule',
      'function useSnugAccess',
    ]) {
      expect(embedded).toContain(name);
    }
    expect(embedded).not.toContain('RESPONSE_SCHEMA'); // the RESPONSE SCHEMA section and after stay in the KB only
    expect(embedded).not.toContain('ReactDOM');
  });
});

/** The two texts every PR-6 structural pin holds over (AC40a). */
const TEXTS: ReadonlyArray<{ label: string; text: () => string }> = [
  { label: 'embedded/snug-hooks.js', text: () => readFileSync(EMBEDDED_PATH, 'utf8') },
  { label: 'the rendered KB 20 hook block', text: renderedHookBlock },
];

/** The top-level declarations PR-5's retired KB snippets made (KB 85's listener, KB 87's helper). */
const RETIRED_NAMES = [
  'snugAccessRequest',
  'SNUG_ACCESS_PENDING',
  'onAccessChanged',
  'onAccessSourceChanged',
  'onDataChanged',
  'onAccessRead',
  'SCHEDULE_HANDLED',
  'onScheduledRun',
] as const;

/** The guard every bridge listener opens with (D-PR6-2): the host alone, never a sibling frame. */
const SOURCE_GUARD = 'if (event.source !== window.parent || !data || data.v !== 1) return;';

const lines = (text: string): string[] => normalize(text).split('\n');
const declares = (text: string, keyword: 'function' | 'const', name: string): boolean =>
  new RegExp(`^\\s*${keyword}\\s+${name}\\b`, 'm').test(text);
const sliceBounds = (text: string, seat: string): number[] =>
  [...text.matchAll(new RegExp(`\\b${seat}\\.slice\\(0, (\\d+)\\)`, 'g'))].map((m) => Number(m[1]));

describe('PR-6 — the hooks block carries sections 6 and 7 and the source guard (AC40a)', () => {
  for (const { label, text } of TEXTS) {
    describe(label, () => {
      it('declares the EIGHT copy-exactly names (SnugBridge + the seven hooks) and onHostEvent, proposeSchedule, scheduleInputKey, snugAccessCall', () => {
        const code = text();
        expect(declares(code, 'const', 'SnugBridge'), 'const SnugBridge').toBe(true);
        for (const name of [
          'useSnugApp',
          'usePersistedState',
          'useAppDB',
          'useConnectedFetch',
          'useHostEvents',
          'useSnugSchedule',
          'useSnugAccess',
          'onHostEvent',
          'proposeSchedule',
          'scheduleInputKey',
          'snugAccessCall',
        ]) {
          expect(declares(code, 'function', name), `function ${name}`).toBe(true);
        }
      });

      it('declares NONE of the retired snippets’ top-level names — a re-copied block can never collide with an app that still carries them', () => {
        const code = text();
        for (const name of RETIRED_NAMES) {
          expect(new RegExp(`^\\s*(function|const|let|var)\\s+${name}\\b`, 'm').test(code), name).toBe(false);
        }
      });

      it('has ONE message listener and its first statement after reading data is the source guard, verbatim', () => {
        const code = text();
        expect(code.split("addEventListener('message'").length - 1).toBe(1);
        const all = lines(code);
        const at = all.indexOf("window.addEventListener('message', (event) => {");
        expect(at).toBeGreaterThanOrEqual(0);
        expect(all[at + 1]).toBe('const data = event.data;');
        expect(all[at + 2]?.startsWith(SOURCE_GUARD), all[at + 2]).toBe(true);
        expect(all).not.toContain('if (!data || data.v !== 1) return;'); // the unguarded line is gone
      });

      it('section 1 gains the two seats and the two arms: access-response settles by requestId; host-event dispatches to a COPY of the subscriber set AFTER the theme code', () => {
        const all = lines(text());
        for (const seat of ['accessPending: new Map(),', 'hostEventListeners: new Map(),']) {
          expect(all.some((line) => line.startsWith(seat)), seat).toBe(true);
        }
        // Code only — a trailing comment may be trimmed for the inline budget (D-PR6-5's fallback).
        for (const statement of [
          "if (data.type === 'snug:access-response') {",
          'const settle = SnugBridge.accessPending.get(data.requestId);',
          'if (!settle) return;',
          'SnugBridge.accessPending.delete(data.requestId);',
          'settle(data);',
          'const subscribers = SnugBridge.hostEventListeners.get(data.event);',
          'if (subscribers) for (const fn of [...subscribers]) fn(data.data);',
        ]) {
          expect(all.some((line) => line.startsWith(statement)), statement).toBe(true);
        }
        const settleAt = all.findIndex((line) => line.startsWith('const settle = SnugBridge.accessPending.get(data.requestId);'));
        expect(all[settleAt + 2]?.startsWith('SnugBridge.accessPending.delete(data.requestId);'), 'deleted BEFORE settle — terminal once').toBe(true);
        expect(all[settleAt + 3]).toBe('settle(data);');
        const theme = all.indexOf('SnugBridge.theme = data.data.theme;');
        const dispatch = all.indexOf('const subscribers = SnugBridge.hostEventListeners.get(data.event);');
        expect(theme).toBeGreaterThanOrEqual(0);
        expect(dispatch).toBeGreaterThan(theme);
      });

      it('numbers its sections 1–7 in order, and section 7’s banner says it needs section 6', () => {
        const all = lines(text());
        const numbers = all.map((line) => /^\/\/ (\d+)\. /.exec(line)?.[1]).filter((n): n is string => n !== undefined).map(Number);
        expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(all).toContain('// 6. useHostEvents + useSnugSchedule (copy exactly when the app listens to the host or takes part in schedules; omit otherwise)');
        expect(all).toContain("// 7. useSnugAccess (copy exactly, WITH section 6, when the app reads or changes another app's data; omit otherwise)");
      });

      it('the schedule bounds it applies are the protocol’s constants — the result’s summary and the throw path’s message, the notify title and body', () => {
        const code = text();
        const summary = sliceBounds(code, 'summary');
        const message = sliceBounds(code, 'message');
        const title = sliceBounds(code, 'title');
        const body = sliceBounds(code, 'body');
        for (const [seat, found] of [['summary', summary], ['message', message], ['title', title], ['body', body]] as const) {
          expect(found.length, `${seat}.slice(0, N) appears`).toBeGreaterThan(0);
        }
        for (const n of [...summary, ...message]) expect(n).toBe(SCHEDULE_STEP_SUMMARY_MAX_CHARS);
        for (const n of title) expect(n).toBe(SCHEDULE_TITLE_MAX_CHARS);
        for (const n of body) expect(n).toBe(SCHEDULE_NOTIFY_BODY_MAX_CHARS);
      });

      it('discover admits exactly the protocol’s candidate classes', () => {
        const classes = [...text().matchAll(/candidates === '([a-z]+)'/g)].map((m) => m[1]);
        expect(classes).toEqual([...ACCESS_CANDIDATE_CLASSES]);
      });

      it('is fully rendered — no un-substituted {{placeholder}} — and carries nothing app-authored (no RESPONSE_SCHEMA, no ReactDOM)', () => {
        const code = text();
        expect(code).not.toMatch(/\{\{[A-Za-z0-9_:-]+\}\}/);
        expect(code).not.toContain('RESPONSE_SCHEMA');
        expect(code).not.toContain('ReactDOM');
        expect(code).toContain("'snug:access-request'"); // section 7's frame literal, injected from the protocol constant
        expect(code).toContain("'snug:app-event'"); // section 6's
      });
    });
  }
});
