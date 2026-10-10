// access.test.ts — TASK-20261010-cross-app-access AC8: the typed accessors over the access
// rows in `snug_settings` (ADR-0075 §2, §4, §7).
//
// THE FILE IS THE RECORD, exactly as for the scheduler: `accessGrant:<id>`,
// `accessLog:<sourceAppId>`, `accessDeclined:<readerAppId>:<hash>` and
// `accessMuted:<readerAppId>` are namespaced settings rows, so a grant reaches a hub from a
// backup, a sync pull or a hand edit as readily as from the consent sheet. Two postures:
//
//  - WRITES FAIL CLOSED. Every accessor parses through the protocol's strict schemas BEFORE
//    touching a row; a refused write leaves the file BYTE-IDENTICAL. Every cap is proven by a
//    failing or pruning write, never by reading a constant back.
//  - READS FAIL OPEN. A row that does not parse reads as "no such grant", never a throw.
//
// Mutation checks (run by hand — remove the rule, see the named row red, restore):
//  - the live-grant cap → "admits 100 LIVE grants …" reds;
//  - the ended-row prune → "ended rows older than 30 days are pruned …" reds;
//  - coalescing on anything wider than identical (grantId, sql) → the coalescing rows red;
//  - pruning lifecycle entries in the same tier as reads → "reads are pruned before …" reds;
//  - not protecting the latest granted/revoked/suspended/released per grant → "NEVER prunes …" reds;
//  - protecting it for a grant the file no longer holds → "… NO LONGER HOLDS goes last …" reds;
//    taking it for a grant the file holds → "the latest granted of a grant the file HOLDS …" reds.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACCESS_ENDED_RETENTION_MS,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  ACCESS_MAX_GRANTS,
  accessGrantSchema,
  accessLogEntrySchema,
  accessRequestHash,
  type AccessGrant,
  type AccessLogEntry,
  type AccessLogKind,
} from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  ACCESS_DECLINED_SETTING_PREFIX,
  ACCESS_GRANT_SETTING_PREFIX,
  ACCESS_LOG_SETTING_PREFIX,
  ACCESS_MUTED_SETTING_PREFIX,
  accessDeclinedSettingKey,
  accessDeclinedSettingPrefixFor,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  grantIdFromAccessGrantSettingKey,
  readerAppIdFromAccessMutedSettingKey,
  sourceAppIdFromAccessLogSettingKey,
} from '../app-settings-keys.js';
import { USERDB_ERROR_CODES, UserDbError, openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

const LEDGER = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const BUDGET = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const PANTRY = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
  db.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger</html>' });
  db.installApp({ appId: BUDGET, displayName: 'Budget', html: '<html>budget</html>' });
  db.installApp({ appId: PANTRY, displayName: 'Pantry', html: '<html>pantry</html>' });
});

const AT = '2026-10-10T08:00:00.000Z';
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const daysAgo = (days: number): string => iso(Date.now() - days * DAY);
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
/** The i-th second after a fixed epoch — unique, increasing instants for log entries. */
const sec = (i: number): string => iso(Date.UTC(2026, 9, 1) + i * 1000);

function grant(overrides: Record<string, unknown> = {}): AccessGrant {
  return accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId: BUDGET,
    sourceAppId: LEDGER,
    scope: { tables: [{ name: 'transactions', columns: ['amount', 'category', 'note'] }] },
    access: 'read',
    purpose: 'to show spending by category',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

function entry(kind: AccessLogKind, grantId: string, at: string, overrides: Record<string, unknown> = {}): AccessLogEntry {
  return accessLogEntrySchema.parse({
    at,
    kind,
    grantId,
    readerAppId: BUDGET,
    readerName: 'Budget',
    ...(kind === 'read' ? { sql: 'SELECT category, SUM(amount) FROM transactions GROUP BY category', rows: 4, attended: true } : {}),
    ...overrides,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof UserDbError ? err.code : `not a UserDbError: ${String(err)}`;
  }
}

/** The whole file as bytes — the oracle for "a refused write leaves the file byte-identical". */
const fileBytes = (): Promise<Uint8Array> => db.exportUserDb({ includeSecrets: true });

function accessKeys(): string[] {
  return db.listSettingKeys().filter((key) => key.startsWith('access'));
}

/** Every access-log row's stored bytes, summed — the figure the 1 MiB ceiling is measured in. */
function storedLogBytes(): number {
  let total = 0;
  for (const key of db.listSettingKeys()) {
    if (sourceAppIdFromAccessLogSettingKey(key) === undefined) continue;
    total += utf8Bytes(JSON.stringify(db.getSetting(key)));
  }
  return total;
}

describe('the key shapes (single-homed in app-settings-keys.ts)', () => {
  it('builds and parses each namespace; the parsers test the FULL prefix and refuse a bare one', () => {
    const id = crypto.randomUUID();
    expect(accessGrantSettingKey(id)).toBe(`${ACCESS_GRANT_SETTING_PREFIX}${id}`);
    expect(ACCESS_GRANT_SETTING_PREFIX).toBe('accessGrant:');
    expect(accessLogSettingKey(LEDGER)).toBe(`accessLog:${LEDGER}`);
    expect(ACCESS_LOG_SETTING_PREFIX).toBe('accessLog:');
    expect(accessDeclinedSettingKey(BUDGET, 'abc')).toBe(`accessDeclined:${BUDGET}:abc`);
    expect(accessDeclinedSettingPrefixFor(BUDGET)).toBe(`${ACCESS_DECLINED_SETTING_PREFIX}${BUDGET}:`);
    expect(accessMutedSettingKey(BUDGET)).toBe(`${ACCESS_MUTED_SETTING_PREFIX}${BUDGET}`);
    expect(ACCESS_MUTED_SETTING_PREFIX).toBe('accessMuted:');

    expect(grantIdFromAccessGrantSettingKey(`accessGrant:${id}`)).toBe(id);
    expect(grantIdFromAccessGrantSettingKey('accessGrant:')).toBeUndefined();
    expect(grantIdFromAccessGrantSettingKey(`accessLog:${id}`)).toBeUndefined();
    expect(grantIdFromAccessGrantSettingKey(`accessGrantX:${id}`)).toBeUndefined();
    expect(sourceAppIdFromAccessLogSettingKey(`accessLog:${LEDGER}`)).toBe(LEDGER);
    expect(sourceAppIdFromAccessLogSettingKey('accessLog:')).toBeUndefined();
    expect(sourceAppIdFromAccessLogSettingKey(`accessGrant:${LEDGER}`)).toBeUndefined();
    expect(readerAppIdFromAccessMutedSettingKey(`accessMuted:${BUDGET}`)).toBe(BUDGET);
    expect(readerAppIdFromAccessMutedSettingKey('accessMuted:')).toBeUndefined();
    expect(readerAppIdFromAccessMutedSettingKey(`accessDeclined:${BUDGET}:h`)).toBeUndefined();

    for (const build of [
      () => accessGrantSettingKey(''),
      () => accessLogSettingKey(''),
      () => accessDeclinedSettingKey('', 'h'),
      () => accessDeclinedSettingKey(BUDGET, ''),
      () => accessDeclinedSettingPrefixFor(''),
      () => accessMutedSettingKey(''),
    ]) {
      expect(build).toThrow();
    }
  });
});

describe('grants — putAccessGrant / getAccessGrant / listAccessGrants / deleteAccessGrant', () => {
  it('round-trips a grant stored as the PARSED object under accessGrant:<id> (counters defaulted into the bytes)', () => {
    const g = grant();
    db.putAccessGrant(g);
    expect(db.getAccessGrant(g.id)).toEqual(g);
    expect(db.getAccessGrant(g.id)?.reads).toBe(0);
    expect(db.listAccessGrants()).toEqual([g]);
    expect(db.getSetting(accessGrantSettingKey(g.id))).toEqual(g);
  });

  it('replaces in place on the same id', () => {
    const g = grant();
    db.putAccessGrant(g);
    db.putAccessGrant({ ...g, reads: 3, lastReadAt: AT });
    expect(db.listAccessGrants()).toHaveLength(1);
    expect(db.getAccessGrant(g.id)?.reads).toBe(3);
  });

  it('a grant id is crypto.randomUUID()’s shape — a lowercase uuid v4; any other id is ACCESS_INVALID and nothing is written', () => {
    const minted = crypto.randomUUID();
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    db.putAccessGrant(grant({ id: minted }));
    expect(db.getAccessGrant(minted)).toBeDefined();

    for (const bad of [minted.toUpperCase(), '6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'grant-1']) {
      const candidate = { ...grant(), id: bad } as AccessGrant;
      expect(codeOf(() => db.putAccessGrant(candidate)), bad).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
      expect(db.listSettingKeys(), bad).not.toContain(accessGrantSettingKey(bad));
    }
  });

  it('parses BEFORE it writes: a credential-shaped purpose is ACCESS_INVALID and the file is byte-identical', async () => {
    db.putAccessGrant(grant());
    const before = await fileBytes();
    const smuggling = { ...grant(), purpose: 'use sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD please' } as AccessGrant;
    expect(codeOf(() => db.putAccessGrant(smuggling))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(await fileBytes()).toEqual(before);
  });

  it('the record invariants are refused at the write boundary (D25): suspended ⇔ reason, revoked ⇔ revokedAt, never itself, no credential column', () => {
    const base = grant();
    for (const [label, bad] of [
      ['suspended without a reason', { ...base, status: 'suspended' }],
      ['a reason while active', { ...base, suspendedReason: 'imported' }],
      ['revoked without revokedAt', { ...base, status: 'revoked' }],
      ['revokedAt while active', { ...base, revokedAt: AT }],
      ['an app reading itself', { ...base, sourceAppId: BUDGET }],
      ['a credential-named column in scope', { ...base, scope: { tables: [{ name: 'accounts', columns: ['name', 'api_key'] }] } }],
    ] as const) {
      expect(codeOf(() => db.putAccessGrant(bad as unknown as AccessGrant)), label).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    }
    expect(accessKeys()).toEqual([]);
    // The passing twins.
    db.putAccessGrant(grant({ status: 'suspended', suspendedReason: 'imported' }));
    db.putAccessGrant(grant({ status: 'revoked', revokedAt: AT }));
    expect(db.listAccessGrants()).toHaveLength(2);
  });

  it('a grant naming an app the file does not hold is NOT_FOUND — no orphan grant a reused id could inherit', () => {
    const ghost = 'f0f0f0f0-0000-4000-8000-000000000000';
    expect(codeOf(() => db.putAccessGrant(grant({ readerAppId: ghost })))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    expect(codeOf(() => db.putAccessGrant(grant({ sourceAppId: ghost })))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    expect(accessKeys()).toEqual([]);
  });

  it(`admits ${ACCESS_MAX_GRANTS} LIVE grants and refuses the next with ACCESS_LIMIT; a replace at the cap lands; ended and suspended grants never count`, async () => {
    const live: AccessGrant[] = [];
    for (let i = 0; i < ACCESS_MAX_GRANTS; i += 1) {
      const g = grant({ purpose: `purpose ${i}` });
      live.push(g);
      db.putAccessGrant(g);
    }
    // Ended (revoked; an `until` in the past) and suspended grants still land at the cap: they are not live.
    db.putAccessGrant(grant({ status: 'revoked', revokedAt: daysAgo(1) }));
    db.putAccessGrant(grant({ duration: { kind: 'until', at: daysAgo(1) } }));
    const suspended = grant({ status: 'suspended', suspendedReason: 'reader-updated' });
    db.putAccessGrant(suspended);
    expect(db.listAccessGrants()).toHaveLength(ACCESS_MAX_GRANTS + 3);

    const before = await fileBytes();
    const oneTooMany = grant({ purpose: 'one too many' });
    expect(codeOf(() => db.putAccessGrant(oneTooMany))).toBe(USERDB_ERROR_CODES.ACCESS_LIMIT);
    // Re-activating the suspended grant would be a 101st live grant too.
    expect(codeOf(() => db.putAccessGrant({ ...suspended, status: 'active', suspendedReason: undefined }))).toBe(USERDB_ERROR_CODES.ACCESS_LIMIT);
    expect(await fileBytes()).toEqual(before);

    // A replace of a live grant at the cap is not a 101st.
    db.putAccessGrant({ ...live[0]!, reads: 7 });
    expect(db.getAccessGrant(live[0]!.id)?.reads).toBe(7);

    // An `until` that has passed frees its seat — expiry is derived, never stored.
    db.putAccessGrant({ ...live[1]!, duration: { kind: 'until', at: daysAgo(1) } });
    db.putAccessGrant(oneTooMany);
    expect(db.getAccessGrant(oneTooMany.id)).toBeDefined();
  });

  it(`ended rows older than ${ACCESS_ENDED_RETENTION_MS / DAY} days are pruned on write; younger ended rows and every non-ended row stay`, () => {
    const oldRevoked = grant({ status: 'revoked', revokedAt: daysAgo(31) });
    const youngRevoked = grant({ status: 'revoked', revokedAt: daysAgo(29) });
    const oldExpired = grant({ duration: { kind: 'until', at: daysAgo(31) } });
    const youngExpired = grant({ duration: { kind: 'until', at: daysAgo(2) } });
    const oldSuspended = grant({ status: 'suspended', suspendedReason: 'imported', updatedAt: daysAgo(400) });
    const oldActive = grant({ grantedAt: daysAgo(400), updatedAt: daysAgo(400) });
    // Planted as raw rows so that no write has pruned them yet.
    for (const g of [oldRevoked, youngRevoked, oldExpired, youngExpired, oldSuspended, oldActive]) db.setSetting(accessGrantSettingKey(g.id), g);

    db.putAccessGrant(grant());

    const ids = new Set(db.listAccessGrants().map((g) => g.id));
    expect(ids.has(oldRevoked.id)).toBe(false);
    expect(ids.has(oldExpired.id)).toBe(false);
    expect(ids.has(youngRevoked.id)).toBe(true);
    expect(ids.has(youngExpired.id)).toBe(true);
    expect(ids.has(oldSuspended.id)).toBe(true);
    expect(ids.has(oldActive.id)).toBe(true);
  });

  it('a refused write prunes nothing', () => {
    const oldRevoked = grant({ status: 'revoked', revokedAt: daysAgo(31) });
    db.setSetting(accessGrantSettingKey(oldRevoked.id), oldRevoked);
    expect(codeOf(() => db.putAccessGrant({ ...grant(), purpose: '' } as AccessGrant))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(db.getAccessGrant(oldRevoked.id)).toBeDefined();
  });

  it('a row that does not parse, or whose body names another id, reads as no grant — never a throw', () => {
    const good = grant();
    db.putAccessGrant(good);
    const other = grant();
    db.setSetting(accessGrantSettingKey(crypto.randomUUID()), { junk: true });
    db.setSetting(accessGrantSettingKey(crypto.randomUUID()), other); // key/body disagreement
    db.setSetting('accessGrant:', good);
    expect(db.listAccessGrants()).toEqual([good]);
    expect(db.getAccessGrant(other.id)).toBeUndefined();
  });

  it('deleteAccessGrant removes the row; an unknown id is a no-op', () => {
    const g = grant();
    db.putAccessGrant(g);
    db.deleteAccessGrant(g.id);
    expect(db.getAccessGrant(g.id)).toBeUndefined();
    expect(accessKeys()).toEqual([]);
    expect(() => db.deleteAccessGrant(crypto.randomUUID())).not.toThrow();
  });
});

describe('the access log — appendAccessLog / listAccessLog (the source keeps the history)', () => {
  const G = '11111111-1111-4111-8111-111111111111';
  const H = '22222222-2222-4222-8222-222222222222';

  it('appends newest first under accessLog:<sourceAppId>, per source', () => {
    db.appendAccessLog(LEDGER, entry('granted', G, sec(0)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(100)));
    db.appendAccessLog(PANTRY, entry('granted', H, sec(5)));
    expect(db.listAccessLog(LEDGER).map((e) => e.kind)).toEqual(['read', 'granted']);
    expect(db.listAccessLog(PANTRY).map((e) => e.grantId)).toEqual([H]);
    expect(db.listAccessLog(BUDGET)).toEqual([]);
    expect(db.listSettingKeys()).toContain(accessLogSettingKey(LEDGER));
  });

  it('parses before it writes: a credential in the logged statement is ACCESS_INVALID and the file is byte-identical', async () => {
    db.appendAccessLog(LEDGER, entry('granted', G, sec(0)));
    const before = await fileBytes();
    const smuggling = { ...entry('read', G, sec(1)), sql: "SELECT * FROM t WHERE k = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD'" } as AccessLogEntry;
    expect(codeOf(() => db.appendAccessLog(LEDGER, smuggling))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(await fileBytes()).toEqual(before);
  });

  it('a history for an app the file does not hold is NOT_FOUND', () => {
    expect(codeOf(() => db.appendAccessLog('f0f0f0f0-0000-4000-8000-000000000000', entry('granted', G, sec(0))))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
  });

  it(`coalesces an identical (grantId, sql) read within ${ACCESS_LOG_COALESCE_MS / 1000} s into ONE entry with count`, () => {
    db.appendAccessLog(LEDGER, entry('read', G, sec(0)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(30)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(59), { rows: 9 }));
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'read', grantId: G, count: 3, rows: 9 });
  });

  it('does NOT coalesce outside the window, on another statement, another grant, without a statement, or across another entry', () => {
    db.appendAccessLog(LEDGER, entry('read', G, sec(0)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(61))); // outside the window
    db.appendAccessLog(LEDGER, entry('read', G, sec(62), { sql: 'SELECT amount FROM transactions' })); // another statement
    db.appendAccessLog(LEDGER, entry('read', H, sec(63), { sql: 'SELECT amount FROM transactions' })); // another grant
    db.appendAccessLog(LEDGER, entry('read', H, sec(64), { sql: undefined })); // statement withheld …
    db.appendAccessLog(LEDGER, entry('read', H, sec(65), { sql: undefined })); // … is never "identical"
    db.appendAccessLog(LEDGER, entry('refused', H, sec(66), { reason: 'while you were away' }));
    db.appendAccessLog(LEDGER, entry('read', H, sec(67), { sql: undefined })); // not consecutive with the read before the refusal
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(8);
    expect(log.every((e) => e.count === undefined)).toBe(true);
  });

  it('does not coalesce a read the user watched with one made while they were away', () => {
    db.appendAccessLog(LEDGER, entry('read', G, sec(0), { attended: true }));
    db.appendAccessLog(LEDGER, entry('read', G, sec(10), { attended: false }));
    expect(db.listAccessLog(LEDGER)).toHaveLength(2);
  });

  it(`keeps at most ${ACCESS_LOG_MAX_ENTRIES} entries per source: the OLDEST read goes first`, () => {
    db.appendAccessLog(LEDGER, entry('granted', G, sec(0)));
    for (let i = 1; i <= ACCESS_LOG_MAX_ENTRIES + 10; i += 1) {
      db.appendAccessLog(LEDGER, entry('read', G, sec(i * 100), { sql: `SELECT ${i}` }));
    }
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    expect(log.at(-1)?.kind).toBe('granted');
    const reads = log.filter((e) => e.kind === 'read').map((e) => e.sql);
    expect(reads.at(-1)).toBe('SELECT 12'); // reads 1..11 pruned, oldest first
    expect(reads[0]).toBe(`SELECT ${ACCESS_LOG_MAX_ENTRIES + 10}`);
  });

  it('reads are pruned before any lifecycle entry, however old the lifecycle entry is', () => {
    // 100 old `refused` entries, then reads until the row is full and past it.
    for (let i = 0; i < 100; i += 1) db.appendAccessLog(LEDGER, entry('refused', G, sec(i), { reason: 'while you were away' }));
    for (let i = 0; i < ACCESS_LOG_MAX_ENTRIES; i += 1) db.appendAccessLog(LEDGER, entry('read', G, sec(1000 + i * 100), { sql: `SELECT ${i}` }));
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    expect(log.filter((e) => e.kind === 'refused')).toHaveLength(100);
  });

  it('NEVER prunes the most recent granted / revoked / suspended / released entry of a grant; an older one of the same kind may go', () => {
    db.appendAccessLog(LEDGER, entry('granted', G, sec(0))); // superseded by the re-grant below — prunable
    db.appendAccessLog(LEDGER, entry('revoked', G, sec(1)));
    db.appendAccessLog(LEDGER, entry('granted', G, sec(2))); // the latest granted of G — protected
    db.appendAccessLog(LEDGER, entry('suspended', G, sec(3), { reason: 'reader-updated' }));
    db.appendAccessLog(LEDGER, entry('released', G, sec(4)));
    db.appendAccessLog(LEDGER, entry('granted', H, sec(5)));
    // Fill with lifecycle entries that are not protected (refused), younger than all of the above.
    for (let i = 0; i < ACCESS_LOG_MAX_ENTRIES; i += 1) db.appendAccessLog(LEDGER, entry('refused', G, sec(100 + i), { reason: 'while you were away' }));

    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    const kept = log.filter((e) => e.kind !== 'refused').map((e) => [e.kind, e.grantId, e.at]);
    expect(kept).toEqual([
      ['granted', H, sec(5)],
      ['released', G, sec(4)],
      ['suspended', G, sec(3)],
      ['granted', G, sec(2)],
      ['revoked', G, sec(1)],
    ]);
  });

  // The protection is bounded to grants the FILE HOLDS (review finding 1): a session grant
  // mints a fresh id per allow and is never stored, and an ended grant's row is pruned after
  // 30 days — protecting their latest entries forever would fill a source's history with
  // entries nothing can take, and every later `read` would be refused for good.
  it('a protected entry of a grant the file NO LONGER HOLDS goes last, oldest first — a full history of long-gone grants never refuses a read', () => {
    for (let i = 0; i < ACCESS_LOG_MAX_ENTRIES; i += 1) db.appendAccessLog(LEDGER, entry('granted', crypto.randomUUID(), sec(i)));
    const oldest = db.listAccessLog(LEDGER).at(-1);
    db.appendAccessLog(LEDGER, entry('read', G, sec(10_000)));
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    expect(log[0]).toMatchObject({ kind: 'read', grantId: G });
    expect(log.some((e) => e.grantId === oldest?.grantId)).toBe(false);
    expect(log.at(-1)?.at).toBe(sec(1));
  });

  it('…and clearAccessLog after such a fill leaves room for the next read', () => {
    for (let i = 0; i < ACCESS_LOG_MAX_ENTRIES; i += 1) db.appendAccessLog(LEDGER, entry('granted', crypto.randomUUID(), sec(i)));
    db.clearAccessLog(LEDGER);
    expect(codeOf(() => db.appendAccessLog(LEDGER, entry('read', G, sec(10_000))))).toBeUndefined();
  });

  it('the latest granted of a grant the file HOLDS survives the same fill, even as the oldest entry', () => {
    const held = grant();
    db.putAccessGrant(held);
    db.appendAccessLog(LEDGER, entry('granted', held.id, sec(0)));
    for (let i = 1; i < ACCESS_LOG_MAX_ENTRIES; i += 1) db.appendAccessLog(LEDGER, entry('granted', crypto.randomUUID(), sec(i)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(10_000)));
    const log = db.listAccessLog(LEDGER);
    expect(log).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    expect(log.at(-1)).toMatchObject({ kind: 'granted', grantId: held.id, at: sec(0) });
    expect(log.some((e) => e.at === sec(1))).toBe(false); // the oldest ABSENT grant's entry went instead
  });

  it('when nothing prunable is left — every entry the latest of its kind for a grant the file holds — the write is refused with ACCESS_LIMIT and nothing changes', async () => {
    // Half live, half revoked (recently, so not pruned): the revoked ones hold no live seat.
    for (let i = 0; i < ACCESS_LOG_MAX_ENTRIES; i += 1) {
      const revoked = i % 2 === 1;
      const held = grant(revoked ? { status: 'revoked', revokedAt: AT } : {});
      db.putAccessGrant(held);
      db.appendAccessLog(LEDGER, entry(revoked ? 'revoked' : 'granted', held.id, sec(i)));
    }
    const before = await fileBytes();
    expect(codeOf(() => db.appendAccessLog(LEDGER, entry('read', G, sec(10_000))))).toBe(USERDB_ERROR_CODES.ACCESS_LIMIT);
    expect(await fileBytes()).toEqual(before);
  });

  it(`keeps one source's row at or under ${ACCESS_LOG_MAX_BYTES} bytes — fewer entries when they are heavy`, () => {
    const tables = Array.from({ length: 32 }, (_, t) => `table_with_a_rather_long_name_${String(t).padStart(2, '0')}`);
    for (let i = 0; i < 60; i += 1) {
      db.appendAccessLog(LEDGER, entry('read', G, sec(i * 100), { sql: `SELECT ${i} ${'x'.repeat(180)}`, tables }));
    }
    const log = db.listAccessLog(LEDGER);
    expect(log.length).toBeLessThan(60);
    expect(utf8Bytes(JSON.stringify(db.getSetting(accessLogSettingKey(LEDGER))))).toBeLessThanOrEqual(ACCESS_LOG_MAX_BYTES);
    expect(log[0]?.sql?.startsWith('SELECT 59 ')).toBe(true);
  });

  it(`keeps every source's history together at or under ${ACCESS_LOG_TOTAL_MAX_BYTES} bytes, pruning the GLOBALLY oldest reads`, () => {
    const tables = Array.from({ length: 32 }, (_, t) => `table_with_a_rather_long_name_${String(t).padStart(2, '0')}`);
    const sources: string[] = [];
    for (let s = 0; s < 18; s += 1) {
      const appId = crypto.randomUUID();
      db.installApp({ appId, displayName: `Source ${s}`, html: '<html></html>' });
      sources.push(appId);
    }
    // Each source fills its own 64 KiB row; eighteen of them would hold more than 1 MiB.
    let tick = 0;
    for (const source of sources) {
      db.appendAccessLog(source, entry('granted', G, sec(tick++)));
      for (let i = 0; i < 45; i += 1) db.appendAccessLog(source, entry('read', G, sec(tick++), { sql: `SELECT ${tick} ${'y'.repeat(180)}`, tables }));
    }
    expect(storedLogBytes()).toBeLessThanOrEqual(ACCESS_LOG_TOTAL_MAX_BYTES);
    // The first source's oldest reads went to make room for the last source's; its `granted` stayed.
    const first = db.listAccessLog(sources[0]!);
    expect(first.some((e) => e.kind === 'granted')).toBe(true);
    const last = db.listAccessLog(sources.at(-1)!);
    expect(last.filter((e) => e.kind === 'read').length).toBeGreaterThan(first.filter((e) => e.kind === 'read').length);
  });

  it(`under the ${ACCESS_LOG_TOTAL_MAX_BYTES}-byte ceiling too, the latest entries of grants the file no longer holds give way rather than refuse`, () => {
    const tables = Array.from({ length: 32 }, (_, t) => `table_with_a_rather_long_name_${String(t).padStart(2, '0')}`);
    let tick = 0;
    for (let s = 0; s < 20; s += 1) {
      const appId = crypto.randomUUID();
      db.installApp({ appId, displayName: `Source ${s}`, html: '<html></html>' });
      for (let i = 0; i < 50; i += 1) {
        expect(codeOf(() => db.appendAccessLog(appId, entry('granted', crypto.randomUUID(), sec(tick++), { tables })))).toBeUndefined();
      }
    }
    expect(storedLogBytes()).toBeLessThanOrEqual(ACCESS_LOG_TOTAL_MAX_BYTES);
  });

  it('an entry that does not parse is skipped on read', () => {
    db.setSetting(accessLogSettingKey(LEDGER), [entry('granted', G, sec(0)), { kind: 'read', junk: true }, 'nonsense']);
    expect(db.listAccessLog(LEDGER).map((e) => e.kind)).toEqual(['granted']);
    db.setSetting(accessLogSettingKey(PANTRY), { not: 'an array' });
    expect(db.listAccessLog(PANTRY)).toEqual([]);
  });

  it('clearAccessLog drops the reads and KEEPS every lifecycle entry; a row with nothing to keep is deleted', () => {
    db.appendAccessLog(LEDGER, entry('granted', G, sec(0)));
    db.appendAccessLog(LEDGER, entry('read', G, sec(100)));
    db.appendAccessLog(LEDGER, entry('refused', G, sec(200), { reason: 'while you were away' }));
    db.appendAccessLog(LEDGER, entry('read', G, sec(300), { sql: 'SELECT 2' }));
    db.appendAccessLog(LEDGER, entry('revoked', G, sec(400)));
    db.appendAccessLog(PANTRY, entry('read', H, sec(0)));

    db.clearAccessLog(LEDGER);
    db.clearAccessLog(PANTRY);

    expect(db.listAccessLog(LEDGER).map((e) => e.kind)).toEqual(['revoked', 'refused', 'granted']);
    expect(db.listSettingKeys()).not.toContain(accessLogSettingKey(PANTRY));
  });
});

describe('declines and the per-reader mute', () => {
  const hash = accessRequestHash({ hints: { tables: ['transactions'], words: ['spending'] } });
  const decline = { purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['spending'] }, at: AT };

  it('records a decline as { purpose, hints, at } under accessDeclined:<reader>:<hash>, lists it per reader, and clears it', () => {
    db.addAccessDecline(BUDGET, hash, decline);
    expect(db.listSettingKeys()).toContain(accessDeclinedSettingKey(BUDGET, hash));
    expect(db.listAccessDeclines(BUDGET)).toEqual([{ hash, ...decline }]);
    expect(db.listAccessDeclines(PANTRY)).toEqual([]);

    db.clearAccessDecline(BUDGET, hash);
    expect(db.listAccessDeclines(BUDGET)).toEqual([]);
    expect(accessKeys()).toEqual([]);
  });

  it('refuses a decline that does not parse (a credential-shaped purpose, a hash that is not a request hash) with ACCESS_INVALID', () => {
    expect(codeOf(() => db.addAccessDecline(BUDGET, hash, { ...decline, purpose: 'Bearer abcdefghijklmnop1234567890ABCDEF' }))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(codeOf(() => db.addAccessDecline(BUDGET, 'not-a-hash', decline))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(codeOf(() => db.addAccessDecline(BUDGET, hash, { ...decline, at: 'yesterday' }))).toBe(USERDB_ERROR_CODES.ACCESS_INVALID);
    expect(accessKeys()).toEqual([]);
  });

  it('lists declines newest first and skips a row that does not parse', () => {
    const older = accessRequestHash({ hints: { words: ['pantry'] } });
    db.addAccessDecline(BUDGET, older, { purpose: 'to plan meals', hints: { words: ['pantry'] }, at: '2026-10-01T00:00:00.000Z' });
    db.addAccessDecline(BUDGET, hash, decline);
    db.setSetting(accessDeclinedSettingKey(BUDGET, 'ffffffffffffffff'), { purpose: 42 });
    expect(db.listAccessDeclines(BUDGET).map((d) => d.hash)).toEqual([hash, older]);
  });

  it('the mute is a boolean whose clearing DELETES the row', () => {
    expect(db.isAccessMuted(BUDGET)).toBe(false);
    db.setAccessMuted(BUDGET, true);
    expect(db.isAccessMuted(BUDGET)).toBe(true);
    expect(db.isAccessMuted(PANTRY)).toBe(false);
    expect(db.listSettingKeys()).toContain(accessMutedSettingKey(BUDGET));
    db.setAccessMuted(BUDGET, false);
    expect(db.isAccessMuted(BUDGET)).toBe(false);
    expect(db.listSettingKeys()).not.toContain(accessMutedSettingKey(BUDGET));
  });
});
