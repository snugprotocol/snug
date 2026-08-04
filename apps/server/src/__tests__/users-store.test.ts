// TASK-20260804-hub-polish AC5 (as amended by owner decision D3 — NO migration):
// the `users` table declares `picture` directly in CREATE TABLE, so a FRESH store opens
// with the column present and a first login populates it. Because the schema is now
// create-only, this also asserts the store opens cleanly against an EMPTY directory.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createUserStore, type UserStore } from '../stores/users.js';

const dirs: string[] = [];
const stores: UserStore[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-users-'));
  dirs.push(dir);
  return dir;
}

function open(dbPath: string): UserStore {
  const store = createUserStore(dbPath);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('user store schema (AC5 — picture declared in CREATE TABLE, no migration)', () => {
  it('opens cleanly against an empty directory and creates the users table', () => {
    const dbPath = path.join(freshDir(), 'users.sqlite');
    const store = open(dbPath);
    // A store over a directory with no pre-existing DB file must be immediately usable.
    expect(store.get('nobody')).toBeUndefined();
  });

  it('declares picture in the schema of a fresh store', () => {
    const dbPath = path.join(freshDir(), 'users.sqlite');
    open(dbPath);

    // Inspect the real schema, not the TS types — this is the create-only guarantee.
    const inspector = new Database(dbPath);
    try {
      const columns = inspector.prepare('PRAGMA table_info(users)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const picture = columns.find((c) => c.name === 'picture');
      expect(picture).toBeDefined();
      // Nullable: Google does not always send a picture claim.
      expect(picture!.notnull).toBe(0);
    } finally {
      inspector.close();
    }
  });

  it('populates picture on a first login and round-trips it through get()', () => {
    const store = open(path.join(freshDir(), 'users.sqlite'));
    const created = store.upsertByGoogleSub({
      googleSub: 'sub-with-pic',
      email: 'pic@example.com',
      name: 'Pic',
      picture: 'https://lh3.googleusercontent.com/a/first-login=s96-c',
    });
    expect(created.picture).toBe('https://lh3.googleusercontent.com/a/first-login=s96-c');
    expect(store.get(created.id)?.picture).toBe('https://lh3.googleusercontent.com/a/first-login=s96-c');
  });

  it('leaves picture undefined when the login carried none', () => {
    const store = open(path.join(freshDir(), 'users.sqlite'));
    const created = store.upsertByGoogleSub({ googleSub: 'sub-no-pic', email: 'n@example.com', name: 'N' });
    expect(created.picture).toBeUndefined();
    expect(store.get(created.id)?.picture).toBeUndefined();
  });

  it('refreshes picture on a later login, keeping the same user id', () => {
    const store = open(path.join(freshDir(), 'users.sqlite'));
    const first = store.upsertByGoogleSub({
      googleSub: 'sub-stable',
      email: 'a@example.com',
      name: 'A',
      picture: 'https://lh3.googleusercontent.com/a/old=s96-c',
    });
    const second = store.upsertByGoogleSub({
      googleSub: 'sub-stable',
      email: 'a@example.com',
      name: 'A',
      picture: 'https://lh3.googleusercontent.com/a/new=s96-c',
    });
    expect(second.id).toBe(first.id);
    expect(second.picture).toBe('https://lh3.googleusercontent.com/a/new=s96-c');
    expect(store.get(first.id)?.picture).toBe('https://lh3.googleusercontent.com/a/new=s96-c');
  });

  it('persists picture across a close and reopen of the same file', () => {
    const dbPath = path.join(freshDir(), 'users.sqlite');
    const first = open(dbPath);
    const created = first.upsertByGoogleSub({
      googleSub: 'sub-persist',
      email: 'p@example.com',
      name: 'P',
      picture: 'https://lh3.googleusercontent.com/a/persisted=s96-c',
    });
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open(dbPath);
    expect(reopened.get(created.id)?.picture).toBe('https://lh3.googleusercontent.com/a/persisted=s96-c');
  });
});
