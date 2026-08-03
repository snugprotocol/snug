// stores/userdbs.ts — per-user user-DB blob store (better-sqlite3, synchronous API).
// One row per user: the whole portable SQLite image plus an opaque revision token
// `r<count>-<random>` (count strictly increases per user — optimistic concurrency for
// the sync loop's If-Match). Quota = USERDB_LIMITS.MAX_USERDB_BYTES per user (F8),
// enforced at the write boundary like the artifact store.

import { randomBytes } from 'node:crypto';

import { USERDB_LIMITS } from '@snugprotocol/protocol';
import Database from 'better-sqlite3';

export interface UserDbRecord {
  bytes: Buffer;
  revision: string;
  updatedAt: string;
}

export type UserDbPutResult =
  | { ok: true; revision: string }
  | { ok: false; code: 'USERDB_TOO_LARGE'; message: string }
  | { ok: false; code: 'REVISION_MISMATCH'; current: string | undefined; message: string };

export interface UserDbStore {
  /** Per-user quota in bytes (observability/test seam). */
  readonly maxBytes: number;
  get(userId: string): UserDbRecord | undefined;
  /**
   * Compare-and-swap write: `expectedRevision` undefined = "expect no existing DB"
   * (the If-None-Match:* first write); otherwise it must equal the stored revision.
   */
  put(userId: string, bytes: Buffer, expectedRevision: string | undefined): UserDbPutResult;
  close(): void;
}

interface Row {
  bytes: Buffer;
  revision: string;
  rev_count: number;
  updated_at: string;
}

/** `dbPath` is a file path or ':memory:' (tests); `maxBytes` is a test seam. */
export function createUserDbStore(dbPath: string, options?: { maxBytes?: number }): UserDbStore {
  const maxBytes = options?.maxBytes ?? USERDB_LIMITS.MAX_USERDB_BYTES;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS userdbs (
      user_id TEXT PRIMARY KEY,
      bytes BLOB NOT NULL,
      revision TEXT NOT NULL,
      rev_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  const selectOne = db.prepare('SELECT bytes, revision, rev_count, updated_at FROM userdbs WHERE user_id = ?');
  const insert = db.prepare('INSERT INTO userdbs (user_id, bytes, revision, rev_count, updated_at) VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE userdbs SET bytes = ?, revision = ?, rev_count = ?, updated_at = ? WHERE user_id = ?');

  // better-sqlite3 transactions are synchronous — the read-compare-write below is atomic
  // with respect to other statements on this connection.
  const putTx = db.transaction((userId: string, bytes: Buffer, expectedRevision: string | undefined): UserDbPutResult => {
    const existing = selectOne.get(userId) as Row | undefined;
    if (existing === undefined) {
      if (expectedRevision !== undefined) {
        return {
          ok: false,
          code: 'REVISION_MISMATCH',
          current: undefined,
          message: 'no user DB exists yet — first write must use If-None-Match: *',
        };
      }
      const revision = mintRevision(1);
      insert.run(userId, bytes, revision, 1, new Date().toISOString());
      return { ok: true, revision };
    }
    if (expectedRevision !== existing.revision) {
      return {
        ok: false,
        code: 'REVISION_MISMATCH',
        current: existing.revision,
        message:
          expectedRevision === undefined
            ? 'a user DB already exists — If-None-Match: * only applies to the first write'
            : 'stale revision — pull the current DB and retry',
      };
    }
    const count = existing.rev_count + 1;
    const revision = mintRevision(count);
    update.run(bytes, revision, count, new Date().toISOString(), userId);
    return { ok: true, revision };
  });

  return {
    maxBytes,
    get(userId) {
      const row = selectOne.get(userId) as Row | undefined;
      if (row === undefined) return undefined;
      return { bytes: row.bytes, revision: row.revision, updatedAt: row.updated_at };
    },
    put(userId, bytes, expectedRevision) {
      if (bytes.byteLength > maxBytes) {
        return {
          ok: false,
          code: 'USERDB_TOO_LARGE',
          message: `user DB is ${bytes.byteLength} bytes; the per-user quota is ${maxBytes}`,
        };
      }
      return putTx(userId, bytes, expectedRevision);
    },
    close() {
      db.close();
    },
  };
}

function mintRevision(count: number): string {
  return `r${count}-${randomBytes(8).toString('hex')}`;
}
