/**
 * THE SELF-HEALING AUTH STORE (TASK-20260822-wa-authstate-corruption).
 *
 * The live defect this guards against: `app-state-sync-key-AAAAAK7c.json` on the owner's
 * machine ended in an extra `"}` after valid JSON — an interrupted non-atomic write — and
 * Baileys' `useMultiFileAuthState.readData` SWALLOWS the parse error and returns null, so
 * app-state sync reported the key as *missing*, parked the `regular` collection, and
 * re-failed on every server resync forever. A library that swallows a parse error reports
 * corruption as absence, and the error message then names the wrong fault.
 *
 * The rules are the thread-cache's (ADR-0037 §1): temp+rename atomic writes at 0600,
 * salvage trailing garbage on read, quarantine (never delete) what cannot be salvaged.
 * The one rule that is NEW here is format fidelity: this store must read what Baileys
 * wrote and write what Baileys can read, or swapping it in would silently unlink every
 * existing session — so compatibility is proven BOTH directions against the real
 * `useMultiFileAuthState` from the pinned tarball, not against a re-description of it.
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto, useMultiFileAuthState } from 'baileys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileAuthState } from '../auth-state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-auth-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A realistic app-state key value — the exact shape the live corrupt file held. */
function sampleSyncKey(): ReturnType<typeof proto.Message.AppStateSyncKeyData.fromObject> {
  return proto.Message.AppStateSyncKeyData.fromObject({
    keyData: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
    fingerprint: { rawId: 2206394425, currentIndex: 7, deviceIndexes: [6, 7, 0] },
    timestamp: '1786957800284',
  });
}

function syncKeyBytes(value: unknown): Buffer {
  return Buffer.from((value as { keyData: Uint8Array }).keyData);
}

describe('createFileAuthState — format compatibility with useMultiFileAuthState', () => {
  it('reads a store Baileys wrote: creds, a pre-key, and an app-state-sync-key survive the swap', async () => {
    const theirs = await useMultiFileAuthState(dir);
    const preKey = { private: Buffer.from('private-bytes'), public: Buffer.from('public-bytes') };
    await theirs.saveCreds();
    await theirs.state.keys.set({
      'pre-key': { '1': preKey },
      // Base64 key ids can carry `/` and `:` — the id must round-trip through the SAME
      // file-name fixing Baileys applies, or this exact id would read as absent.
      'app-state-sync-key': { 'AA/AA:K7c': sampleSyncKey() },
    } as never);

    const ours = await createFileAuthState(dir);
    expect(ours.state.creds).toEqual(theirs.state.creds);
    const keys = await ours.state.keys.get('pre-key', ['1']);
    expect(keys['1']).toEqual(preKey);
    const sync = await ours.state.keys.get('app-state-sync-key', ['AA/AA:K7c']);
    expect(syncKeyBytes(sync['AA/AA:K7c'])).toEqual(syncKeyBytes(sampleSyncKey()));
  });

  it('writes a store Baileys can read: the reverse direction of the same swap', async () => {
    const ours = await createFileAuthState(dir);
    const preKey = { private: Buffer.from('private-bytes'), public: Buffer.from('public-bytes') };
    await ours.saveCreds();
    await ours.state.keys.set({
      'pre-key': { '1': preKey },
      'app-state-sync-key': { 'AA/AA:K7c': sampleSyncKey() },
    } as never);

    const theirs = await useMultiFileAuthState(dir);
    expect(theirs.state.creds).toEqual(ours.state.creds);
    const keys = await theirs.state.keys.get('pre-key', ['1']);
    expect(keys['1']).toEqual(preKey);
    const sync = await theirs.state.keys.get('app-state-sync-key', ['AA/AA:K7c']);
    expect(syncKeyBytes(sync['AA/AA:K7c'])).toEqual(syncKeyBytes(sampleSyncKey()));
  });

  it('answers null for an id that has no file, like the original', async () => {
    const ours = await createFileAuthState(dir);
    const keys = await ours.state.keys.get('pre-key', ['404']);
    expect(keys['404']).toBeNull();
  });

  it('a null value in set() deletes the file, like the original', async () => {
    const ours = await createFileAuthState(dir);
    await ours.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('x'), public: Buffer.from('y') } } } as never);
    expect(existsSync(join(dir, 'pre-key-1.json'))).toBe(true);
    await ours.state.keys.set({ 'pre-key': { '1': null } } as never);
    expect(existsSync(join(dir, 'pre-key-1.json'))).toBe(false);
  });

  it('a FALSY value in set() deletes too — the original tests truthiness, not null', async () => {
    // Baileys can hand `''` for an empty lidUser (lid-mapping.js:112 warns but not always
    // filters); the original removed the file. Writing it instead would leave scalar litter.
    const ours = await createFileAuthState(dir);
    await ours.state.keys.set({ 'lid-mapping': { x: 'kept@lid' } } as never);
    expect(existsSync(join(dir, 'lid-mapping-x.json'))).toBe(true);
    await ours.state.keys.set({ 'lid-mapping': { x: '' } } as never);
    expect(existsSync(join(dir, 'lid-mapping-x.json'))).toBe(false);
  });

  it('round-trips SCALAR values — lid-mapping entries are bare JSON strings, not objects', async () => {
    // THE REVIEW CATCH (2026-08-22): `SignalDataTypeMap['lid-mapping']: string` — the live
    // session dir holds 1,644 of these. A reader that only accepts objects would have
    // quarantined the entire LID↔phone directory on first read, with the suite green.
    const theirs = await useMultiFileAuthState(dir);
    await theirs.state.keys.set({ 'lid-mapping': { '100077100081166_reverse': '17148220178' } } as never);

    const ours = await createFileAuthState(dir);
    const read = await ours.state.keys.get('lid-mapping' as never, ['100077100081166_reverse']);
    expect(read['100077100081166_reverse']).toBe('17148220178');

    await ours.state.keys.set({ 'lid-mapping': { fresh: '236427898765432@lid' } } as never);
    const reread = await (await useMultiFileAuthState(dir)).state.keys.get('lid-mapping' as never, ['fresh']);
    expect(reread['fresh']).toBe('236427898765432@lid');
  });
});

describe('createFileAuthState — atomic writes', () => {
  it('leaves no temp residue and lands parseable 0600 files', async () => {
    const ours = await createFileAuthState(dir);
    await ours.saveCreds();
    await ours.state.keys.set({ 'app-state-sync-key': { AAAAAK7c: sampleSyncKey() } } as never);

    const names = readdirSync(dir);
    expect(names.some((name) => name.includes('.tmp'))).toBe(false);
    for (const name of names) {
      expect(() => JSON.parse(readFileSync(join(dir, name), 'utf8'))).not.toThrow();
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it('rewriting an existing longer file leaves clean JSON (rename replaces, never appends)', async () => {
    const ours = await createFileAuthState(dir);
    const long = { private: Buffer.from('a'.repeat(512)), public: Buffer.from('b'.repeat(512)) };
    const short = { private: Buffer.from('a'), public: Buffer.from('b') };
    await ours.state.keys.set({ 'pre-key': { '1': long } } as never);
    await ours.state.keys.set({ 'pre-key': { '1': short } } as never);
    const reread = await ours.state.keys.get('pre-key', ['1']);
    expect(reread['1']).toEqual(short);
  });
});

describe('createFileAuthState — salvage and quarantine', () => {
  it('salvages the LIVE corruption shape (valid JSON + trailing `"}`), returns the key, heals the file', async () => {
    // Write a good key with Baileys' own store, then corrupt it exactly the way the
    // owner's machine was corrupted on 2026-08-20: extra `"}` after the closing brace.
    const theirs = await useMultiFileAuthState(dir);
    await theirs.state.keys.set({ 'app-state-sync-key': { AAAAAK7c: sampleSyncKey() } } as never);
    const file = join(dir, 'app-state-sync-key-AAAAAK7c.json');
    writeFileSync(file, `${readFileSync(file, 'utf8')}"}`);

    const ours = await createFileAuthState(dir);
    const sync = await ours.state.keys.get('app-state-sync-key', ['AAAAAK7c']);
    expect(sync['AAAAAK7c']).not.toBeNull();
    expect(syncKeyBytes(sync['AAAAAK7c'])).toEqual(syncKeyBytes(sampleSyncKey()));
    // Healed on disk: the next reader — including stock Baileys — parses it cleanly.
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('quarantines an unsalvageable key file aside and reads it as absent — never deletes it', async () => {
    const file = join(dir, 'app-state-sync-key-BAD1.json');
    writeFileSync(file, 'garbage{{{');

    const ours = await createFileAuthState(dir);
    const sync = await ours.state.keys.get('app-state-sync-key', ['BAD1']);
    expect(sync['BAD1']).toBeNull();
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dir).find((name) => name.startsWith('app-state-sync-key-BAD1.json.corrupt'));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside as string), 'utf8')).toBe('garbage{{{');
  });

  it('a SECOND quarantine of the same file keeps the first — unique aside names, or rename clobbers', async () => {
    // POSIX rename REPLACES an existing target: a fixed `.corrupt` name would destroy the
    // first forensic copy the moment the same file corrupts twice (review, 2026-08-22).
    const file = join(dir, 'app-state-sync-key-TWICE.json');
    writeFileSync(file, 'first-garbage{{{');
    await (await createFileAuthState(dir)).state.keys.get('app-state-sync-key', ['TWICE']);
    writeFileSync(file, 'second-garbage{{{');
    await (await createFileAuthState(dir)).state.keys.get('app-state-sync-key', ['TWICE']);

    const asides = readdirSync(dir).filter((name) => name.startsWith('app-state-sync-key-TWICE.json.corrupt'));
    expect(asides).toHaveLength(2);
    const contents = asides.map((name) => readFileSync(join(dir, name), 'utf8')).sort();
    expect(contents).toEqual(['first-garbage{{{', 'second-garbage{{{']);
  });

  it('salvages a scalar file with trailing garbage — the torn-tail class is not object-only', async () => {
    const file = join(dir, 'lid-mapping-torn.json');
    writeFileSync(file, '"17148220178"xtra');
    const ours = await createFileAuthState(dir);
    const read = await ours.state.keys.get('lid-mapping' as never, ['torn']);
    expect(read['torn']).toBe('17148220178');
    expect(readFileSync(file, 'utf8')).toBe('"17148220178"');
  });

  it('a read error that is NOT absence throws instead of impersonating a fresh start', async () => {
    // THE REVIEW CATCH (2026-08-22): a transient EACCES at boot read as "no creds" would
    // hand back fresh creds, and the next creds.update would atomically OVERWRITE the
    // user's working session. Absence means ENOENT and nothing else.
    const theirs = await useMultiFileAuthState(dir);
    await theirs.saveCreds();
    chmodSync(join(dir, 'creds.json'), 0o000);
    try {
      await expect(createFileAuthState(dir)).rejects.toThrow();
      // And the unreadable file was not touched — no quarantine, no overwrite.
      expect(existsSync(join(dir, 'creds.json'))).toBe(true);
    } finally {
      chmodSync(join(dir, 'creds.json'), 0o600);
    }
  });

  it('an empty file is corruption, not a fresh start: quarantined, read as absent', async () => {
    const file = join(dir, 'pre-key-9.json');
    writeFileSync(file, '');

    const ours = await createFileAuthState(dir);
    const keys = await ours.state.keys.get('pre-key', ['9']);
    expect(keys['9']).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('salvages creds.json with trailing garbage — the session resumes instead of re-pairing', async () => {
    const theirs = await useMultiFileAuthState(dir);
    await theirs.saveCreds();
    const file = join(dir, 'creds.json');
    writeFileSync(file, `${readFileSync(file, 'utf8')}"}`);

    const ours = await createFileAuthState(dir);
    expect(ours.state.creds).toEqual(theirs.state.creds);
  });

  it('copies unsalvageable creds.json aside but PRESERVES the original, then falls back to fresh creds', async () => {
    // Keys quarantine by rename; creds.json quarantines by COPY. Two consumers read this
    // exact path by name — the desktop autostart predicate (`creds.json` exists ⇒ spawn
    // the helper) and the wedge predicate feeding `resetAuthStore` — and renaming it away
    // would silently disable autostart forever while full signal material lingered in the
    // `.corrupt` copy with no UI path to forget it (review, 2026-08-22). Leaving the
    // corrupt original in place keeps the existing wedge-clear machinery in charge.
    const file = join(dir, 'creds.json');
    writeFileSync(file, 'not json at all');

    const ours = await createFileAuthState(dir);
    // Fresh creds are a working (unpaired) identity, not a crash.
    expect(ours.state.creds.registered).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('not json at all');
    const aside = readdirSync(dir).find((name) => name.startsWith('creds.json.corrupt'));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside as string), 'utf8')).toBe('not json at all');
  });
});
