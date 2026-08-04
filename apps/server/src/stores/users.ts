// stores/users.ts — SQLite user store (better-sqlite3, synchronous API).
// First login provisions the USER ROW ONLY — never a userdbs row: /userdb stays 404
// until the client's first PUT, so an empty provisioned DB can never clobber local
// state (ADR-0009, plan F6/F12 push-up rule).

import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

export interface UserRecord {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  /** Google avatar URL; absent when the id_token carried no `picture` claim. */
  picture?: string;
  createdAt: string;
}

export interface UserStore {
  /** Insert on first login; refresh email/name/picture on later logins. Id is stable per google sub. */
  upsertByGoogleSub(input: { googleSub: string; email: string; name: string; picture?: string }): UserRecord;
  get(id: string): UserRecord | undefined;
  close(): void;
}

interface Row {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string | null;
  created_at: string;
}

function toRecord(row: Row): UserRecord {
  return {
    id: row.id,
    googleSub: row.google_sub,
    email: row.email,
    name: row.name,
    // NULL in SQLite ⇢ key omitted, never `picture: null` — /auth/me's contract is omission.
    ...(row.picture !== null && row.picture !== '' ? { picture: row.picture } : {}),
    createdAt: row.created_at,
  };
}

/** `dbPath` is a file path or ':memory:' (tests). */
export function createUserStore(dbPath: string): UserStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    // `picture` is declared here rather than migrated in (owner decision D3, 2026-08-04):
    // the hub DB is disposable dev state and is deleted and rebuilt. Nullable — Google
    // does not send a picture claim for every account.
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  const insert = db.prepare(
    'INSERT INTO users (id, google_sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const update = db.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE google_sub = ?');
  const selectBySub = db.prepare(
    'SELECT id, google_sub, email, name, picture, created_at FROM users WHERE google_sub = ?',
  );
  const selectById = db.prepare('SELECT id, google_sub, email, name, picture, created_at FROM users WHERE id = ?');

  return {
    upsertByGoogleSub({ googleSub, email, name, picture }) {
      const stored = picture !== undefined && picture !== '' ? picture : null;
      const existing = selectBySub.get(googleSub) as Row | undefined;
      if (existing !== undefined) {
        update.run(email, name, stored, googleSub);
        return toRecord({ ...existing, email, name, picture: stored });
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      insert.run(id, googleSub, email, name, stored, createdAt);
      return toRecord({ id, google_sub: googleSub, email, name, picture: stored, created_at: createdAt });
    },
    get(id) {
      const row = selectById.get(id) as Row | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    close() {
      db.close();
    },
  };
}
