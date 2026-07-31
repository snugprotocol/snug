// stores/threads.ts — SQLite thread history (better-sqlite3, synchronous API).
// History is capped on READ: the chat path sends the model only the last N messages.

import Database from 'better-sqlite3';

import { HISTORY_CAP } from '../config.js';

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ThreadStore {
  /** Last `historyCap` messages for the thread, oldest first. */
  history(threadId: string): ThreadMessage[];
  append(threadId: string, message: ThreadMessage): void;
  close(): void;
}

interface Row {
  role: string;
  content: string;
}

/** `dbPath` is a file path or ':memory:' (tests). */
export function createThreadStore(dbPath: string, options?: { historyCap?: number }): ThreadStore {
  const historyCap = options?.historyCap ?? HISTORY_CAP;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages (thread_id, id)`,
  );
  const insert = db.prepare('INSERT INTO thread_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const selectLast = db.prepare(
    'SELECT role, content FROM thread_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?',
  );

  return {
    history(threadId) {
      const rows = selectLast.all(threadId, historyCap) as Row[];
      return rows
        .reverse()
        .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }) as ThreadMessage);
    },
    append(threadId, message) {
      insert.run(threadId, message.role, message.content, new Date().toISOString());
    },
    close() {
      db.close();
    },
  };
}
