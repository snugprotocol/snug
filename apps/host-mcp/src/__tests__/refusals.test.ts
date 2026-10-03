// L2 — the refusal table: one module, one table, code → message → remedy.
//
// A runner that can neither lead nor attach used to die before the MCP handshake, and the
// host showed "Connection closed" — a sentence about a pipe, with nothing to act on. Every
// way a start can fail now has a row here, and the row is what `snug_status` returns and
// what every other tool says. This file pins the table's SHAPE (every code has both halves,
// each remedy is an act a person can perform); each row's journey through the built bundle
// is `lifecycle-interop.test.ts`.

import { describe, expect, it } from 'vitest';

import { REFUSAL_CODES, refusalFor, refusalSentence, type RefusalFacts } from '../refusals.js';

const FACTS: RefusalFacts = {
  cli: 'sh /plugin/scripts/snug',
  home: '/Users/someone/Snug',
  pid: 4242,
  detail: 'EACCES',
};

describe('the table', () => {
  it('has exactly the rows the throw sites need', () => {
    expect([...REFUSAL_CODES]).toEqual([
      'home-unresolved',
      'home-unwritable',
      'lock-held-by-stranger',
      'lock-contended',
      'older-build',
      'socket-path-too-long',
      'socket-in-use',
      'listen-failed',
      'page-damaged',
    ]);
  });

  it.each(REFUSAL_CODES.map((code) => [code]))('%s has a message and a remedy, both sentences', (code) => {
    const refusal = refusalFor(code, FACTS);
    expect(refusal.code).toBe(code);
    for (const part of [refusal.message, refusal.remedy]) {
      expect(part.length).toBeGreaterThan(20);
      expect(part).toMatch(/[.!]$/);
      // A template that lost its value prints the word, and nobody notices until a user does.
      expect(part).not.toMatch(/undefined|\[object|NaN/);
    }
  });

  it.each(REFUSAL_CODES.map((code) => [code]))('%s still reads as a sentence when NOTHING is known', (code) => {
    const refusal = refusalFor(code, { cli: 'sh /plugin/scripts/snug' });
    expect(`${refusal.message} ${refusal.remedy}`).not.toMatch(/undefined|\[object|NaN/);
  });

  it('never calls itself an MCP server in copy a person reads (ADR-0061)', () => {
    for (const code of REFUSAL_CODES) {
      expect(refusalSentence(refusalFor(code, FACTS))).not.toMatch(/\bMCP\b/);
    }
  });
});

describe('what each row tells the person to do', () => {
  it('home-unresolved names both variables', () => {
    const { message, remedy } = refusalFor('home-unresolved', FACTS);
    expect(`${message} ${remedy}`).toMatch(/HOME/);
    expect(`${message} ${remedy}`).toMatch(/SNUG_HOME/);
  });

  it('home-unwritable names the folder and the system’s own reason', () => {
    const { message } = refusalFor('home-unwritable', FACTS);
    expect(message).toContain('/Users/someone/Snug');
    expect(message).toContain('EACCES');
  });

  it('lock-held-by-stranger names the pid and the file, and promises no signal', () => {
    const { message, remedy } = refusalFor('lock-held-by-stranger', FACTS);
    expect(message).toMatch(/another process \(pid 4242\)/);
    expect(`${message} ${remedy}`).toContain('/Users/someone/Snug/host/lock.json');
  });

  it('lock-held-by-stranger says only what is KNOWN: the process could not be identified — never that it "is not" a Snug runner', () => {
    // The row is reached by a command line that could not be read, or did not read as ours.
    // Neither proves the process is not a Snug runner (a Node binary under a path `ps`
    // cannot split, a process table that would not answer) — and a sentence that said so sent
    // a person to delete the lock of a runner that might still hold their file.
    const { message, remedy } = refusalFor('lock-held-by-stranger', FACTS);
    expect(message).toMatch(/could not be identified as a Snug runner/);
    expect(`${message} ${remedy}`).not.toMatch(/is not a Snug runner/);
    // The remedy, in the order it must be done: quit the session that started it, THEN the lock.
    expect(remedy).toMatch(/quit the agent session that started it/i);
    expect(remedy).toMatch(/delete that lock file/);
    expect(remedy.search(/quit the agent session/i)).toBeLessThan(remedy.search(/delete that lock file/));
  });

  it.each([['lock-contended'], ['older-build'], ['socket-in-use']] as const)('%s gives the `stop` command with the launcher’s real path', (code) => {
    expect(refusalFor(code, FACTS).remedy).toContain('sh /plugin/scripts/snug stop');
  });

  it('older-build names the pid of the runner that has to go', () => {
    expect(refusalFor('older-build', FACTS).message).toContain('4242');
  });

  it('socket-path-too-long says how to shorten it', () => {
    expect(refusalFor('socket-path-too-long', FACTS).remedy).toMatch(/SNUG_HOME/);
  });

  it('page-damaged says reinstall', () => {
    expect(refusalFor('page-damaged', FACTS).remedy).toMatch(/reinstall the Snug plugin/i);
  });
});

describe('the sentence every other tool returns', () => {
  it('is the message and the remedy, in that order', () => {
    const refusal = refusalFor('page-damaged', FACTS);
    expect(refusalSentence(refusal)).toBe(`${refusal.message} ${refusal.remedy}`);
  });
});
