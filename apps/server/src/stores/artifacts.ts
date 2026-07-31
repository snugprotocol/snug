// stores/artifacts.ts — SQLite artifact store (better-sqlite3, synchronous API).
// Enforces MAX_ARTIFACT_BYTES at the write boundary; oversized writes are typed errors.

import { randomUUID } from 'node:crypto';

import { LIMITS } from '@snugprotocol/protocol';
import Database from 'better-sqlite3';

export interface ArtifactMeta {
  id: string;
  displayName: string;
  bytes: number;
  createdAt: string;
}

export interface ArtifactRecord extends ArtifactMeta {
  html: string;
}

export type ArtifactPutResult =
  | { ok: true; artifact: ArtifactMeta }
  | { ok: false; code: 'ARTIFACT_TOO_LARGE'; message: string };

export interface ArtifactStore {
  put(input: { html: string; displayName?: string }): ArtifactPutResult;
  get(id: string): ArtifactRecord | undefined;
  list(): ArtifactMeta[];
  close(): void;
}

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

function deriveDisplayName(html: string, displayName: string | undefined): string {
  const explicit = displayName?.trim() ?? '';
  const fromTitle = TITLE_RE.exec(html)?.[1]?.trim() ?? '';
  const name = explicit !== '' ? explicit : fromTitle !== '' ? fromTitle : 'Untitled app';
  return name.slice(0, LIMITS.DISPLAY_NAME_CHARS);
}

interface Row {
  id: string;
  display_name: string;
  bytes: number;
  created_at: string;
  html?: string;
}

/** `dbPath` is a file path or ':memory:' (tests). */
export function createArtifactStore(dbPath: string): ArtifactStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(
    `CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      html TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
  );
  const insert = db.prepare(
    'INSERT INTO artifacts (id, display_name, html, bytes, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare('SELECT id, display_name, html, bytes, created_at FROM artifacts WHERE id = ?');
  const selectAll = db.prepare('SELECT id, display_name, bytes, created_at FROM artifacts ORDER BY created_at DESC, id');

  return {
    put({ html, displayName }) {
      const bytes = Buffer.byteLength(html, 'utf8');
      if (bytes > LIMITS.MAX_ARTIFACT_BYTES) {
        return {
          ok: false,
          code: 'ARTIFACT_TOO_LARGE',
          message: `artifact is ${bytes} bytes; the limit is ${LIMITS.MAX_ARTIFACT_BYTES}`,
        };
      }
      const artifact: ArtifactMeta = {
        id: randomUUID(),
        displayName: deriveDisplayName(html, displayName),
        bytes,
        createdAt: new Date().toISOString(),
      };
      insert.run(artifact.id, artifact.displayName, html, artifact.bytes, artifact.createdAt);
      return { ok: true, artifact };
    },
    get(id) {
      const row = selectOne.get(id) as Row | undefined;
      if (row === undefined) return undefined;
      return {
        id: row.id,
        displayName: row.display_name,
        html: row.html ?? '',
        bytes: row.bytes,
        createdAt: row.created_at,
      };
    },
    list() {
      return (selectAll.all() as Row[]).map((row) => ({
        id: row.id,
        displayName: row.display_name,
        bytes: row.bytes,
        createdAt: row.created_at,
      }));
    },
    close() {
      db.close();
    },
  };
}
