// @vitest-environment node
//
// The .sqlite export moment (task AC-7): a REAL db driver (sql.js, memory backend,
// wasm from node_modules via the injectable locator) produces a Blob whose first
// bytes are the SQLite magic header.

import { createRequire } from 'node:module';

import { createDbDriver, createMemoryBackend } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, type DbRequestFrame } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { exportDatabase } from '../run/exportDb.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

let seq = 0;
const execFrame = (sql: string): DbRequestFrame => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.dbRequest,
  requestId: `req-${++seq}`,
  instanceId: 'ins-test',
  op: 'exec',
  sql,
});

const SQLITE_MAGIC = 'SQLite format 3';

describe('exportDatabase', () => {
  it('produces a Blob download with the SQLite magic bytes', async () => {
    const driver = createDbDriver({ backend: createMemoryBackend(), locateWasm });
    const create = await driver.handle('art-42', execFrame('CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT)'));
    expect(create.ok).toBe(true);
    await driver.handle('art-42', execFrame("INSERT INTO habits (name) VALUES ('swim')"));

    const result = await exportDatabase(driver, 'art-42');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blob.type).toBe('application/x-sqlite3');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(SQLITE_MAGIC.length);
    for (let i = 0; i < SQLITE_MAGIC.length; i++) {
      expect(bytes[i]).toBe(SQLITE_MAGIC.charCodeAt(i));
    }
    expect(bytes[15]).toBe(0); // NUL terminator of the header string
    await driver.close();
  });

  it('returns errors as data when the driver fails', async () => {
    const result = await exportDatabase(
      { handle: async () => ({ ok: false, code: 'HOST_ERROR', message: 'nope', retryable: false }) },
      'art-1',
    );
    expect(result).toEqual({ ok: false, message: 'nope' });
  });
});
