// hostCopy.test.ts — TASK-20260905-host-kit AC2/AC5: the platform disclosure copy and the
// run view's failed-load copy, pinned byte-for-byte on every arm (pure functions).
import { describe, expect, it } from 'vitest';

import {
  BRAIN_AUTO,
  BRAIN_MARK_WORD,
  BRAIN_UNVERIFIED_BODY,
  BRAIN_UNVERIFIED_LABEL,
  autoChoiceLine,
  BRAIN_NOT_CHECKED_DETAIL,
  brainLevels,
  brainMark,
  brainReadyState,
  brainRemedy,
  brainStateWords,
  custodyDisclosure,
  demoStandIn,
  proseParts,
  storageDisclosure,
  tierAutoLabel,
  tierLabel,
  tierSubstitutionNote,
} from '../platform/copy.js';
import type { BrainOptionView } from '../platform/platform.js';
import { isNamedLoadRefusal, missingAppCopy } from '../run/copy.js';

describe('storageDisclosure — names the rung that WORKED', () => {
  it('has one sentence per backend kind and nothing when the platform did not say', () => {
    expect(storageDisclosure('opfs')).toBe('this copy of your file lives in this browser’s private storage for this page.');
    expect(storageDisclosure('idb')).toBe('this copy of your file lives in this browser’s IndexedDB for this page.');
    expect(storageDisclosure('memory')).toBe(
      'this copy of your file lives in memory only — it is gone when the page closes, so export it to keep it.',
    );
    expect(storageDisclosure('file')).toBe('this copy of your file lives on this computer’s disk.');
    expect(storageDisclosure(undefined)).toBeUndefined();
  });
  it('names the two artifact kinds (T4 AC4/AC5) — the switch is exhaustive', () => {
    expect(storageDisclosure('window-storage')).toBe(
      'this copy of your file lives in this chat’s page storage — this view only; the published link keeps its own.',
    );
    expect(storageDisclosure('artifact-html')).toBe(
      'the working copy of your file lives in this browser; the saved copy is the artifact page itself.',
    );
  });
});

describe('custodyDisclosure — the "your file" chip, one arm per binding × state (T4 AC7, D8)', () => {
  const clean = { dirty: false, readOnly: false } as const;
  it('a hosted artifact: Anthropic-hosted, saved on the act, a republish rewrites unless merged, export any time', () => {
    expect(custodyDisclosure('artifact', 'artifact-html', clean)).toEqual({
      label: 'your file: in this artifact',
      headline: 'in this artifact',
      body:
        'Anthropic-hosted, saved when you save it. a republish from Claude Code rewrites it unless the agent merges it (snug-embed does). export any time.',
    });
  });
  it('the state line: dirty, the two divergence directions, read-only — read-only outranks the rest', () => {
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, dirty: true }).status).toBe('unsaved changes — save to this artifact to keep them.');
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, divergence: 'newer' }).status).toBe('this browser’s copy is newer than the page’s saved copy.');
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, divergence: 'older' }).status).toBe('the page’s saved copy is newer than this browser’s.');
    expect(custodyDisclosure('artifact', 'artifact-html', { dirty: true, readOnly: true, divergence: 'older' }).status).toBe('read-only view — export to keep a copy.');
    expect(custodyDisclosure('artifact', 'artifact-html', clean).status).toBeUndefined();
  });
  it('the static page, the chat view, and the plain-file rungs', () => {
    expect(custodyDisclosure('artifact-static', 'opfs', clean)).toMatchObject({ label: 'your file: not saved here', headline: 'a copy of the artifact page' });
    expect(custodyDisclosure('artifact-static', 'opfs', clean).body).toContain('export');
    expect(custodyDisclosure('artifact-chat', 'window-storage', clean)).toMatchObject({ label: 'your file: in this chat', headline: 'in this chat’s page storage' });
    expect(custodyDisclosure('artifact-chat', 'window-storage', clean).body).toContain('published link keeps its own');
    expect(custodyDisclosure('file', 'opfs', clean)).toMatchObject({ label: 'your file: in this browser', body: storageDisclosure('opfs') });
    // CHANGED for Binding B (ADR-0068): under `local-host` the file is a real file on disk
    // served by the local host process, so the old fall-through label ("in this browser")
    // was false for this binding. `file` and the default keep the browser wording.
    expect(custodyDisclosure('local-host', 'file', clean)).toMatchObject({
      label: 'your file: on this Mac',
      headline: 'on this Mac',
    });
    expect(custodyDisclosure('local-host', 'file', clean).body).toMatch(/~\/Snug\/user\.snug/);
    // The holder line names WHO, because "close the other app" is the whole remedy and an
    // unnamed refusal leaves the user guessing (ADR-0068 D-B10).
    expect(custodyDisclosure('local-host', 'file', { ...clean, heldBy: 'Snug for Mac' }).status).toBe(
      'Snug for Mac has your file open — close it to use Snug here.',
    );
    // It outranks the generic read-only line: both are true, only one is actionable.
    expect(custodyDisclosure('local-host', 'file', { ...clean, readOnly: true, heldBy: 'Snug for Mac' }).status).toMatch(/Snug for Mac/);
    // The positive twin: a plain file: page is still "in this browser".
    expect(custodyDisclosure('file', 'idb', clean)).toMatchObject({ label: 'your file: in this browser', body: storageDisclosure('idb') });
    expect(custodyDisclosure('file', 'memory', clean)).toMatchObject({ label: 'your file: in memory', body: storageDisclosure('memory') });
  });
  it('S2 — a memory-only WORKING copy under an artifact says the tab holds it, on every arm, and never without the flag', () => {
    const memory = { ...clean, workingCopy: 'memory' as const };
    for (const binding of ['artifact', 'artifact-static', 'artifact-chat'] as const) {
      expect(custodyDisclosure(binding, 'memory', memory).body).toContain('in memory only — close it unsaved and the changes are gone');
      expect(custodyDisclosure(binding, 'artifact-html', clean).body).not.toContain('in memory only');
    }
  });
});

describe('missingAppCopy — a named failure becomes the lesson', () => {
  it('without a reason it is the library miss, byte-identical to before', () => {
    expect(missingAppCopy()).toEqual({
      title: 'app not found',
      lesson: 'it may live in the other mode — check settings, or build a new one.',
    });
  });
  it('with a reason the reason is what the user reads (the starter loader’s offline refusal)', () => {
    const reason = 'starters load from the network — this page is offline or the starters package is unreachable';
    expect(missingAppCopy(reason)).toEqual({ title: 'this app didn’t load', lesson: reason });
  });
});

describe('isNamedLoadRefusal — the only failure the run view quotes', () => {
  it('matches the loader\'s named error by NAME and nothing else', () => {
    expect(isNamedLoadRefusal(Object.assign(new Error('starters load from the network'), { name: 'StarterLoadError' }))).toBe(true);
    expect(isNamedLoadRefusal(new Error('database disk image is malformed'))).toBe(false);
    expect(isNamedLoadRefusal('starters load from the network')).toBe(false);
  });
});

describe('the thinking-level copy (TASK-20260906 AC4/AC5, ADR-0067) — the contract’s own terms, every arm pinned', () => {
  const seat = { viewerDefault: 'default' as const };
  it('labels each tier by what it does and marks the viewer’s default; an unavailable tier names what answered instead', () => {
    const none = { unavailable: {} };
    expect(tierLabel('quick', seat, none)).toBe('quick — answers at once, no thinking first');
    expect(tierLabel('default', seat, none)).toBe('default — thinks first (the viewer’s default)');
    expect(tierLabel('complex', seat, none)).toBe('complex — thinks longest, for hard reasoning');
    expect(tierLabel('complex', seat, { unavailable: { complex: 'default' } })).toBe('complex — not on this plan, answered on default');
    // The marker follows the seat, not a constant: a contract whose default moved is labelled right.
    expect(tierLabel('quick', { viewerDefault: 'quick' }, none)).toBe('quick — answers at once, no thinking first (the viewer’s default)');
  });
  it('the auto label names the pins, and a pin the plan overrode by what answers (review C3)', () => {
    const seat = { auto: { app: 'quick' as const, chat: 'default' as const } };
    expect(tierAutoLabel(seat, { unavailable: {} })).toBe('auto — quick for app replies, default for building');
    expect(tierAutoLabel(seat, { unavailable: { default: 'quick' } })).toBe('auto — quick for app replies, quick for building');
    expect(tierAutoLabel(seat, { unavailable: { quick: 'default' } })).toBe('auto — default for app replies, default for building');
  });
  it('the substitution note derives from the recorded pair; nothing recorded → no note', () => {
    expect(tierSubstitutionNote(undefined)).toBeUndefined();
    expect(tierSubstitutionNote({ asked: 'complex', answered: 'default' })).toBe('asked for complex — this view answered on default (the viewer’s plan)');
  });
});

describe('the brain switcher’s words (TASK-20261003 B6/B8, ADR-0071) — one derivation for the chip, the passport and the runner', () => {
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const claude = (over: Partial<BrainOptionView> = {}): BrainOptionView => ({
    id: 'claude',
    name: 'Claude',
    via: 'your Claude Code CLI',
    state: 'ready',
    verified: true,
    efforts: FIVE,
    models: [
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: ['low', 'high'] },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
    ],
    ...over,
  });
  const codex = (over: Partial<BrainOptionView> = {}): BrainOptionView => ({ id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'ready', verified: false, efforts: ['minimal', 'low'], models: [], ...over });

  it('the thinking levels are the MODEL’s own: the brain’s with none chosen, the model’s when listed (even none), the brain’s for one typed by hand', () => {
    const brain = claude();
    expect(brainLevels(brain, undefined)).toEqual(FIVE);
    expect(brainLevels(brain, 'claude-sonnet-5-5')).toEqual(['low', 'high']);
    expect(brainLevels(brain, 'claude-haiku-4-5-20251001')).toEqual([]);
    expect(brainLevels(brain, 'claude-some-future-model')).toEqual(FIVE);
  });

  it('the five states, and anything else read as unknown — never as ready', () => {
    for (const state of ['ready', 'logged-out', 'outdated', 'absent', 'unknown']) expect(brainReadyState(state)).toBe(state);
    for (const state of ['rate-limited', '', 'READY', 'constructor', '__proto__', 'toString']) expect(brainReadyState(state), JSON.stringify(state)).toBe('unknown');
  });

  it('three marks, each with a word: ready, needs attention, not installed', () => {
    expect(['ready', 'logged-out', 'outdated', 'absent', 'unknown', 'rate-limited'].map(brainMark)).toEqual(['ready', 'attention', 'attention', 'absent', 'attention', 'attention']);
    expect(BRAIN_MARK_WORD).toEqual({ ready: 'ready', attention: 'needs attention', absent: 'not installed' });
  });

  it('a few words per state, for the chip', () => {
    expect(['ready', 'logged-out', 'outdated', 'absent', 'unknown', 'rate-limited'].map((state) => brainStateWords({ state }))).toEqual([
      'ready',
      'not logged in',
      'out of date',
      'not installed',
      'not checked yet',
      'needs attention',
    ]);
  });

  it('`unknown` is two facts, told apart by the runner’s own sentence: nobody has looked yet, or it was asked and could not be read', () => {
    // Found by looking at the built page (R4 verifier): a brain whose login check had TIMED
    // OUT was labelled "not checked yet" on the chip — it had been checked.
    expect(BRAIN_NOT_CHECKED_DETAIL).toBe('Snug is still checking this brain.');
    expect(brainStateWords({ state: 'unknown', detail: BRAIN_NOT_CHECKED_DETAIL })).toBe('not checked yet');
    expect(brainStateWords({ state: 'unknown', detail: '' })).toBe('not checked yet');
    expect(brainStateWords({ state: 'unknown', detail: 'Your Codex CLI did not answer the login check in time.' })).toBe('could not be checked');
    // Only `unknown` has the two readings: a detail never changes another state's words.
    expect(brainStateWords({ state: 'logged-out', detail: 'Your Codex CLI is not logged in — run `codex login`, then check again.' })).toBe('not logged in');
    expect(brainStateWords({ state: 'rate-limited', detail: 'try again at noon' })).toBe('needs attention');
  });

  it('the remedy is the RUNNER’s sentence, verbatim; with none (or an empty one) it is the state in words', () => {
    const detail = 'Your Codex CLI is not logged in — run `codex login`, then check again.';
    expect(brainRemedy({ name: 'Codex', state: 'logged-out', detail })).toBe(detail);
    expect(brainRemedy({ name: 'Codex', state: 'logged-out', detail: '' })).toBe('Codex is not logged in.');
    expect(brainRemedy({ name: 'Codex', state: 'outdated' })).toBe('Codex is out of date.');
    expect(brainRemedy({ name: 'Codex', state: 'absent' })).toBe('Codex is not installed.');
    // `unknown` is "not checked yet", not "broken": every brain says it until the runner's first look lands.
    expect(brainRemedy({ name: 'Codex', state: 'unknown' })).toBe('Codex has not been checked yet.');
    expect(brainRemedy({ name: 'Codex', state: 'rate-limited' })).toBe('Codex needs attention.');
  });

  it('the unverified label and its one sentence are pinned — the claim is a decision, not a tweak (ADR-0071 §2)', () => {
    expect(BRAIN_UNVERIFIED_LABEL).toBe('experimental — not yet verified on this machine');
    expect(BRAIN_UNVERIFIED_BODY).toBe('its tools are switched off by flags and a tripwire, and nobody has yet proven that on a logged-in run here.');
  });

  describe('proseParts — a sentence with its commands marked', () => {
    it('text between backticks is a command; the rest is text; nothing is lost', () => {
      expect(proseParts('run `claude` and `/login`, then check again.')).toEqual([
        { text: 'run ', code: false },
        { text: 'claude', code: true },
        { text: ' and ', code: false },
        { text: '/login', code: true },
        { text: ', then check again.', code: false },
      ]);
      expect(proseParts('nothing to mark')).toEqual([{ text: 'nothing to mark', code: false }]);
      expect(proseParts('`codex login`')).toEqual([{ text: 'codex login', code: true }]);
      expect(proseParts('')).toEqual([]);
    });

    it('an UNPAIRED backtick stays the character it is — never half a sentence set as a command', () => {
      expect(proseParts('it’s 5 o`clock somewhere')).toEqual([
        { text: 'it’s 5 o', code: false },
        { text: '`clock somewhere', code: false },
      ]);
      expect(proseParts('run `a` then `b')).toEqual([
        { text: 'run ', code: false },
        { text: 'a', code: true },
        { text: ' then ', code: false },
        { text: '`b', code: false },
      ]);
      // No word is lost or reordered, however the backticks fall (an EMPTY pair marks nothing and goes).
      const words = (text: string): string => text.replaceAll('`', '');
      for (const sample of ['a `b` c', '`a', 'a`', '``', 'a `b` `c', '```', '`a``b`', 'a``b']) {
        expect(words(proseParts(sample).map((part) => part.text).join('')), sample).toBe(words(sample));
        expect(proseParts(sample).every((part) => part.text !== ''), sample).toBe(true);
      }
    });
  });

  describe('demoStandIn — why the demo brain is answering, and what to do', () => {
    const remedy = 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.';

    it('nothing stands in while a brain answers', () => {
      expect(demoStandIn({ choice: BRAIN_AUTO, active: 'claude', brains: [claude()] })).toBeUndefined();
      expect(demoStandIn({ choice: 'codex', active: 'codex', brains: [claude({ state: 'logged-out' }), codex()] })).toBeUndefined();
    });

    it('no brain reported yet: it is looking — not a claim that nothing is there', () => {
      expect(demoStandIn({ choice: BRAIN_AUTO, brains: [] })).toEqual({ why: 'looking for your agents', remedy: 'the runner has not said yet which of your agents can answer.' });
      expect(demoStandIn({ choice: 'codex', brains: [] })?.why, 'even under a pin: the list is not in yet').toBe('looking for your agents');
    });

    it('auto: the reason is the runner’s default brain — the first VERIFIED one — with its own remedy', () => {
      const down = claude({ state: 'logged-out', detail: remedy });
      expect(demoStandIn({ choice: BRAIN_AUTO, brains: [down, codex()] })).toEqual({ why: 'Claude · not logged in', remedy, brain: down });
      // An unverified brain's state is never auto's reason, wherever it is listed.
      expect(demoStandIn({ choice: BRAIN_AUTO, brains: [codex({ state: 'absent' }), down] })?.brain).toBe(down);
    });

    it('a pin: the reason is the PINNED brain, though another is ready', () => {
      const pinned = codex({ state: 'outdated' });
      expect(demoStandIn({ choice: 'codex', brains: [claude(), pinned] })).toEqual({ why: 'Codex · out of date', remedy: 'Codex is out of date.', brain: pinned });
    });

    it('a pin on a brain the runner no longer lists says so, and how to get out', () => {
      expect(demoStandIn({ choice: 'hermes', brains: [claude()] })).toEqual({
        why: 'the agent you picked is gone',
        remedy: 'the agent you picked (hermes) is not on this computer any more — choose auto, or another agent.',
      });
    });

    it('auto with no verified brain at all: there is nothing auto may pick — pick one yourself', () => {
      expect(demoStandIn({ choice: BRAIN_AUTO, brains: [codex()] })).toEqual({
        why: 'no agent picked',
        remedy: 'auto only uses an agent that has been verified on this machine — pick one below to use it.',
      });
    });

    it('auto, the default brain says ready, yet nothing is active: it does not invent a fault', () => {
      expect(demoStandIn({ choice: BRAIN_AUTO, brains: [claude()] })).toEqual({ why: 'no agent is answering', remedy: 'check again, or pick an agent below.' });
    });

    it('NEVER "nothing to configure" — on the runner there is always something the user can do', () => {
      const states = [
        { choice: BRAIN_AUTO, brains: [] },
        { choice: BRAIN_AUTO, brains: [claude({ state: 'absent' })] },
        { choice: BRAIN_AUTO, brains: [codex()] },
        { choice: BRAIN_AUTO, brains: [claude()] },
        { choice: 'hermes', brains: [claude()] },
        { choice: 'codex', brains: [codex({ state: 'unknown' })] },
      ];
      for (const state of states) {
        const standIn = demoStandIn(state);
        expect(`${standIn?.why} ${standIn?.remedy}`).not.toMatch(/nothing to configure|no host brain/);
        expect(standIn?.remedy).not.toBe('');
      }
    });
  });

  describe('autoChoiceLine — one plain line: what auto means here', () => {
    it('chosen and answering: on whom, and that it never switches by itself', () => {
      expect(autoChoiceLine({ choice: BRAIN_AUTO, active: 'claude', brains: [claude(), codex()] })).toBe('answers on Claude — and never switches to another agent by itself.');
    });
    it('chosen, the default agent not ready while another IS: it names the one that is not — never "nothing is ready"', () => {
      // MIGRATED (R4 fix): this pinned "nothing is ready…" for exactly this state, two lines
      // above a Codex row marked "ready" (found by looking at the built page).
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [claude({ state: 'absent' }), codex()] })).toBe(
        'Claude is not ready, so the demo brain answers — auto never switches to another agent by itself.',
      );
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [claude({ state: 'unknown' }), codex()] })).toBe(
        'Claude is not ready, so the demo brain answers — auto never switches to another agent by itself.',
      );
      // Wherever it is listed: the default is the first VERIFIED brain, as `demoStandIn` reads it.
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [codex(), claude({ state: 'logged-out' })] })).toBe(
        'Claude is not ready, so the demo brain answers — auto never switches to another agent by itself.',
      );
    });
    it('chosen with NO agent ready — said only when it is true', () => {
      const none = 'no agent is ready, so the demo brain answers — auto never switches to another agent by itself.';
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [claude({ state: 'absent' }), codex({ state: 'logged-out' })] })).toBe(none);
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [claude({ state: 'logged-out' })] })).toBe(none);
    });
    it('chosen before the runner has reported any agent: "still looking" — not a verdict on agents nobody has seen', () => {
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [] })).toBe('still looking for your agents, so the demo brain answers — auto never switches to another agent by itself.');
    });
    it('chosen, an agent ready that auto may not take or has not been given: it invents no fault', () => {
      const idle = 'no agent is answering, so the demo brain answers — auto never switches to another agent by itself.';
      // Only an unverified brain is here: ready, and never auto's.
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [codex()] })).toBe(idle);
      // The default brain says ready and the runner has not named it active.
      expect(autoChoiceLine({ choice: BRAIN_AUTO, brains: [claude(), codex()] })).toBe(idle);
    });
    it('not chosen: what choosing it would mean', () => {
      expect(autoChoiceLine({ choice: 'codex', active: 'codex', brains: [claude(), codex()] })).toBe('your default agent when it is ready, the demo brain when it is not — never another agent.');
    });
    it('never names an UNVERIFIED brain as what auto answers on', () => {
      expect(autoChoiceLine({ choice: BRAIN_AUTO, active: 'codex', brains: [claude(), codex()] })).not.toContain('Codex');
    });
  });
});
