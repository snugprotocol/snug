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
  createdAt: string;
}

export interface UserStore {
  /** Insert on first login; refresh email/name on later logins. Id is stable per google sub. */
  upsertByGoogleSub(input: { googleSub: string; email: string; name: string }): UserRecord;
  get(id: string): UserRecord | undefined;
  close(): void;
}

interface Row {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  created_at: string;
}

function toRecord(row: Row): UserRecord {
  return { id: row.id, googleSub: row.google_sub, email: row.email, name: row.name, createdAt: row.created_at };
}

/** `dbPath` is a file path or ':memory:' (tests). */
export function createUserStore(dbPath: string): UserStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  const insert = db.prepare('INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE users SET email = ?, name = ? WHERE google_sub = ?');
  const selectBySub = db.prepare('SELECT id, google_sub, email, name, created_at FROM users WHERE google_sub = ?');
  const selectById = db.prepare('SELECT id, google_sub, email, name, created_at FROM users WHERE id = ?');

  return {
    upsertByGoogleSub({ googleSub, email, name }) {
      const existing = selectBySub.get(googleSub) as Row | undefined;
      if (existing !== undefined) {
        update.run(email, name, googleSub);
        return toRecord({ ...existing, email, name });
      }
      const record: UserRecord = {
        id: randomUUID(),
        googleSub,
        email,
        name,
        createdAt: new Date().toISOString(),
      };
      insert.run(record.id, record.googleSub, record.email, record.name, record.createdAt);
      return record;
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
