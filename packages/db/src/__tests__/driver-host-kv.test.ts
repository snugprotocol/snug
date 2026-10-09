// driver-host-kv.test.ts — TASK-20261009-scheduling-framework A3 (ADR-0074 §3): the HOST-side
// kv on `SnugDbDriver`. The scheduler writes an app's `snug:schedule:<runId>` input into the
// app's OWN namespace, where the app reads it with its ordinary `kvGet` frame — so the two
// sides must agree on the table (`snug_kv`), `null` must clear (the hooks read a cleared key
// as ABSENT, never as a stored null), the value is capped at the handshake's 1 KiB, and the
// user db's facade must refuse a tombstoned (deleted) app exactly as it refuses its frames.
// Errors are DATA at this seat as everywhere on the driver: it never throws.
import { SCHEDULE_APP_INPUT_MAX_BYTES } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import {
  DB_ERROR_CODES,
  HOST_KV_VALUE_MAX_BYTES,
  USERDB_ERROR_CODES,
  createDbDriver,
  createMemoryBackend,
  openUserDb,
  type DbDriverResult,
  type SnugDbDriver,
} from '../index.js';
import { kvGetFrame, kvSetFrame, locateWasm } from './helpers.js';

const NS = 'app-1';
const KEY = 'snug:schedule:run-1';

function driver(): SnugDbDriver {
  return createDbDriver({ backend: createMemoryBackend(), locateWasm });
}

function expectOk(result: DbDriverResult): asserts result is Extract<DbDriverResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
}

function expectError(result: DbDriverResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(typeof result.message).toBe('string');
  expect(result.retryable).toBe(false);
}

/** A string whose JSON serialisation is exactly `bytes` UTF-8 bytes (the two quotes included). */
const stringOfJsonBytes = (bytes: number): string => 'x'.repeat(bytes - 2);

describe('SnugDbDriver.kvSet / kvGet — the host side of the kv handshake', () => {
  it('the cap is the handshake’s: HOST_KV_VALUE_MAX_BYTES is SCHEDULE_APP_INPUT_MAX_BYTES (1 KiB)', () => {
    expect(HOST_KV_VALUE_MAX_BYTES).toBe(SCHEDULE_APP_INPUT_MAX_BYTES);
    expect(HOST_KV_VALUE_MAX_BYTES).toBe(1024);
  });

  it('what the host writes, the app reads through its ordinary kvGet frame — and the host reads it back too', async () => {
    const d = driver();
    const input = { taskId: 't1', runId: 'run-1', input: { city: 'Oslo' } };
    expectOk(await d.kvSet(NS, KEY, input));
    const viaFrame = await d.handle(NS, kvGetFrame(KEY));
    expectOk(viaFrame);
    expect(viaFrame.value).toEqual(input);
    const viaHost = await d.kvGet(NS, KEY);
    expectOk(viaHost);
    expect(viaHost.value).toEqual(input);
  });

  it('what the app writes through its frame, the host reads', async () => {
    const d = driver();
    expectOk(await d.handle(NS, kvSetFrame('note', { done: true })));
    const read = await d.kvGet(NS, 'note');
    expectOk(read);
    expect(read.value).toEqual({ done: true });
  });

  it('`null` CLEARS: the app’s kvGet then answers no `value` field at all (absent, never a stored null)', async () => {
    const d = driver();
    expectOk(await d.kvSet(NS, KEY, { runId: 'run-1' }));
    expectOk(await d.kvSet(NS, KEY, null));
    const viaFrame = await d.handle(NS, kvGetFrame(KEY));
    expectOk(viaFrame);
    expect('value' in viaFrame).toBe(false);
    const viaHost = await d.kvGet(NS, KEY);
    expectOk(viaHost);
    expect('value' in viaHost).toBe(false);
  });

  it('clearing a key that was never written is fine — idempotent, like the sweep at boot', async () => {
    const d = driver();
    expectOk(await d.kvSet(NS, 'never-written', null));
  });

  it('a value over 1 KiB (serialised UTF-8) is refused DB_TOO_LARGE and the key keeps what it held; exactly 1 KiB lands', async () => {
    const d = driver();
    expectOk(await d.kvSet(NS, KEY, 'before'));
    expectError(await d.kvSet(NS, KEY, stringOfJsonBytes(HOST_KV_VALUE_MAX_BYTES + 1)), DB_ERROR_CODES.TOO_LARGE);
    const kept = await d.kvGet(NS, KEY);
    expectOk(kept);
    expect(kept.value).toBe('before');
    expectOk(await d.kvSet(NS, KEY, stringOfJsonBytes(HOST_KV_VALUE_MAX_BYTES)));
    // Multi-byte characters count as BYTES, not characters: 512 two-byte chars + quotes = 1026.
    expectError(await d.kvSet(NS, KEY, 'é'.repeat(512)), DB_ERROR_CODES.TOO_LARGE);
  });

  it('a key outside the frame schema’s bounds (empty, over 256 characters) is refused, never written', async () => {
    const d = driver();
    expect((await d.kvSet(NS, '', 1)).ok).toBe(false);
    expect((await d.kvSet(NS, 'k'.repeat(257), 1)).ok).toBe(false);
    expect((await d.kvGet(NS, '')).ok).toBe(false);
  });

  it('a value JSON cannot serialise is a refusal, not a throw', async () => {
    const d = driver();
    const result = await d.kvSet(NS, KEY, { big: BigInt(1) });
    expect(result.ok).toBe(false);
  });

  it('a closed driver answers DB_INTERNAL as data — the boundary never throws', async () => {
    const d = driver();
    await d.close();
    expectError(await d.kvSet(NS, KEY, 1), DB_ERROR_CODES.INTERNAL);
    expectError(await d.kvGet(NS, KEY), DB_ERROR_CODES.INTERNAL);
  });

  it('namespaces are isolated: a key written for one app is absent for another', async () => {
    const d = driver();
    expectOk(await d.kvSet('app-a', KEY, 'a'));
    const other = await d.kvGet('app-b', KEY);
    expectOk(other);
    expect('value' in other).toBe(false);
  });
});

describe('the user db’s driver face — the same seat, the tombstone honoured', () => {
  it('routes a live app through (the write lands in the file: it survives a flush and a re-open) and refuses a deleted app NOT_FOUND', async () => {
    const backend = createMemoryBackend();
    const opened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error('open failed');
    const db = opened.userDb;
    const app = db.installApp({ displayName: 'Weather', html: '<html>v1</html>' });
    expectOk(await db.driver.kvSet(app.appId, KEY, { taskId: 't1', runId: 'run-1' }));
    const viaFrame = await db.driver.handle(app.appId, kvGetFrame(KEY));
    expectOk(viaFrame);
    expect(viaFrame.value).toEqual({ taskId: 't1', runId: 'run-1' });

    await db.flush();
    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (reopened.status !== 'ok') throw new Error('re-open failed');
    const again = await reopened.userDb.driver.kvGet(app.appId, KEY);
    expectOk(again);
    expect(again.value).toEqual({ taskId: 't1', runId: 'run-1' });
    await reopened.userDb.close();

    await db.deleteApp(app.appId);
    const set = await db.driver.kvSet(app.appId, KEY, { runId: 'run-2' });
    expectError(set, USERDB_ERROR_CODES.NOT_FOUND);
    const get = await db.driver.kvGet(app.appId, KEY);
    expectError(get, USERDB_ERROR_CODES.NOT_FOUND);
    await db.close();
  });
});
