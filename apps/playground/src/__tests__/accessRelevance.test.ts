// accessRelevance.test.ts — TASK-20261010-cross-app-access AC16 (ADR-0075 §5): the consent
// sheet ranks the user's apps by a DETERMINISTIC match of the reader's hints over table
// names, column names and the app's own name and description — no brain call. Matched apps
// come first (at most five), the rest sit behind *more apps…*, and every app that cannot be
// offered (the reader itself, no tables, over the copy cap, holding a WhatsApp fact) is
// collapsed into the excluded list with its reason, for the sheet's one footer sentence.
//
// `rankSources` is pure — those cases build their inputs inline. The LAST block drives its one
// caller, consent.ts `collectSources`, on a real memory user db: that is where the reader is put
// in the list, a WhatsApp fact is read (`appHasSidecarFact` — never `appHoldsLastSidecarFact`,
// which answers false for BOTH of two sidecar apps) and the copy cap is measured, so AC16's
// clauses about those exclusions are pinned where they are decided, not only passed through.
//
// Mutation checks (run by hand, each red then restored): restore the old table filter that
// ignored credential-only tables → the "nothing shareable" rows red; TIER = 3 → the tier rows
// red; swap collectSources to appHoldsLastSidecarFact → the two-sidecar-apps row reds.
import { ACCESS_SOURCE_MAX_BYTES, FRAME_TYPES, PROTOCOL_VERSION, SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectSources } from '../access/consent.js';
import { installTestUserDb } from './userdbTestHelper.js';

import {
  EXCLUDED_REASONS,
  MATCHED_MAX,
  preselectedTables,
  rankSources,
  type RankedSource,
  type SourceApp,
  type SourceInput,
} from '../access/relevance.js';

const col = (name: string, sensitive = false): { name: string; sensitive: boolean } => ({ name, sensitive });

const LEDGER: SourceApp = {
  appId: 'ledger',
  displayName: 'Ledger',
  description: 'money in and out',
  iconEmoji: '📒',
  tables: [
    { name: 'transactions', columns: [col('amount'), col('category'), col('date'), col('note')], rowCount: 412 },
    { name: 'accounts', columns: [col('name'), col('balance'), col('api_key', true)], rowCount: 3 },
  ],
};
const PANTRY: SourceApp = {
  appId: 'pantry',
  displayName: 'Pantry',
  description: 'what is in the cupboard',
  tables: [{ name: 'items', columns: [col('name'), col('quantity'), col('expires')], rowCount: 48 }],
};
const RECIPES: SourceApp = {
  appId: 'recipes',
  displayName: 'Recipes',
  tables: [{ name: 'dishes', columns: [col('title'), col('ingredients')], rowCount: 12 }],
};
const BUDGET: SourceApp = {
  appId: 'budget',
  displayName: 'Budget',
  description: 'spending by category',
  tables: [{ name: 'envelopes', columns: [col('category'), col('limit')], rowCount: 9 }],
};

const ids = (sources: readonly RankedSource[]): string[] => sources.map((source) => source.appId);

describe('rankSources — the score order (AC16)', () => {
  it('an exact hint-table match outranks any number of word matches', () => {
    // Pantry's `items` is named exactly; Ledger matches two words in its tables and columns.
    const ranked = rankSources({
      readerAppId: 'budget',
      apps: [LEDGER, PANTRY],
      hints: { tables: ['ITEMS'], words: ['transaction', 'category', 'amount'] },
    });
    expect(ids(ranked.matched)).toEqual(['pantry', 'ledger']);
    expect(ranked.matched[0]!.score).toBeGreaterThan(ranked.matched[1]!.score);
  });

  it('a word in a table name outranks a word in a column name', () => {
    const tableHit: SourceApp = { appId: 'a', displayName: 'Zed', tables: [{ name: 'expenses', columns: [col('x')], rowCount: 1 }] };
    const columnHit: SourceApp = { appId: 'b', displayName: 'Abe', tables: [{ name: 'rows', columns: [col('expenses_total')], rowCount: 1 }] };
    const ranked = rankSources({ readerAppId: 'r', apps: [columnHit, tableHit], hints: { words: ['expense'] } });
    expect(ids(ranked.matched)).toEqual(['a', 'b']);
  });

  it('a word in a column name outranks a word in the app’s name or description', () => {
    const columnHit: SourceApp = { appId: 'a', displayName: 'Zed', tables: [{ name: 'rows', columns: [col('meal')], rowCount: 1 }] };
    const nameHit: SourceApp = { appId: 'b', displayName: 'Meal planner', tables: [{ name: 'rows', columns: [col('x')], rowCount: 1 }] };
    const descriptionHit: SourceApp = {
      appId: 'c',
      displayName: 'Aaa',
      description: 'plans every meal',
      tables: [{ name: 'rows', columns: [col('x')], rowCount: 1 }],
    };
    const ranked = rankSources({ readerAppId: 'r', apps: [descriptionHit, nameHit, columnHit], hints: { words: ['meal'] } });
    expect(ids(ranked.matched)).toEqual(['a', 'c', 'b']);
    // name and description weigh the same, so the two tie and fall to displayName.
    expect(ranked.matched[1]!.score).toBe(ranked.matched[2]!.score);
  });

  it('matching is case-insensitive and a word may sit inside a longer name', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER], hints: { words: ['TRANSACTION'] } });
    expect(ids(ranked.matched)).toEqual(['ledger']);
    expect(ranked.matched[0]!.matchedTables).toEqual(['transactions']);
  });

  it('ties break by displayName, then appId — the order never depends on the input order', () => {
    const one: SourceApp = { appId: 'id-2', displayName: 'Same', tables: [{ name: 'notes', columns: [col('x')], rowCount: 1 }] };
    const two: SourceApp = { appId: 'id-1', displayName: 'Same', tables: [{ name: 'notes', columns: [col('x')], rowCount: 1 }] };
    const three: SourceApp = { appId: 'id-0', displayName: 'Alpha', tables: [{ name: 'notes', columns: [col('x')], rowCount: 1 }] };
    const forward = rankSources({ readerAppId: 'r', apps: [one, two, three], hints: { words: ['note'] } });
    const backward = rankSources({ readerAppId: 'r', apps: [three, two, one], hints: { words: ['note'] } });
    expect(ids(forward.matched)).toEqual(['id-0', 'id-1', 'id-2']);
    expect(ids(backward.matched)).toEqual(ids(forward.matched));
    expect(forward).toEqual(backward);
  });

  it('no hints: nothing is matched and every app sits in the rest, by name', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [RECIPES, PANTRY, LEDGER] });
    expect(ranked.matched).toEqual([]);
    expect(ids(ranked.rest)).toEqual(['ledger', 'pantry', 'recipes']);
    expect(ranked.rest.every((source) => source.score === 0)).toBe(true);
  });

  it('a sensitive column is never a reason to match — it is never shared', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER], hints: { words: ['api_key'] } });
    expect(ranked.matched).toEqual([]);
    expect(ids(ranked.rest)).toEqual(['ledger']);
  });

  it('sensitive columns stay in the table’s column list, flagged, for the sheet to mark *never shared*', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER] });
    const accounts = ranked.rest[0]!.tables.find((table) => table.name === 'accounts')!;
    expect(accounts.columns).toEqual([col('name'), col('balance'), col('api_key', true)]);
    expect(accounts.rowCount).toBe(3);
  });

  it('a ranked source carries the app’s name, description and tile through unchanged', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER], hints: { words: ['amount'] } });
    const { score: _score, matchedTables: _matched, ...rest } = ranked.matched[0]!;
    expect(rest).toEqual(LEDGER);
  });
});

describe('rankSources — the tiers never overlap, and the hint lists are read as the protocol bounds them', () => {
  // Sixteen distinct two-letter words — the protocol's cap — none of which sits inside "rows", "x" or the names below.
  const WORDS = ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh', 'qi', 'qj', 'qk', 'ql', 'qm', 'qn', 'qo', 'qp'];

  it('sixteen column-name hits rank BELOW one table-name hit', () => {
    const columns: SourceApp = { appId: 'cols', displayName: 'Alpha', tables: [{ name: 'rows', columns: WORDS.map((word) => col(`c_${word}`)), rowCount: 1 }] };
    const table: SourceApp = { appId: 'table', displayName: 'Zulu', tables: [{ name: 't_qa', columns: [col('x')], rowCount: 1 }] };
    expect(ids(rankSources({ readerAppId: 'r', apps: [columns, table], hints: { words: WORDS } }).matched)).toEqual(['table', 'cols']);
  });

  it('sixteen table-name hits rank BELOW one exact hint-table', () => {
    const tables: SourceApp = { appId: 'tables', displayName: 'Alpha', tables: WORDS.map((word) => ({ name: `t_${word}`, columns: [col('x')], rowCount: 1 })) };
    const exact: SourceApp = { appId: 'exact', displayName: 'Zulu', tables: [{ name: 'pantry', columns: [col('x')], rowCount: 1 }] };
    expect(ids(rankSources({ readerAppId: 'r', apps: [tables, exact], hints: { tables: ['pantry'], words: WORDS } }).matched)).toEqual(['exact', 'tables']);
  });

  it('sixteen name-or-description hits rank BELOW one column-name hit', () => {
    const about: SourceApp = { appId: 'about', displayName: 'Alpha', description: WORDS.join(' '), tables: [{ name: 'rows', columns: [col('x')], rowCount: 1 }] };
    const column: SourceApp = { appId: 'column', displayName: 'Zulu', tables: [{ name: 'rows', columns: [col('c_qa')], rowCount: 1 }] };
    expect(ids(rankSources({ readerAppId: 'r', apps: [about, column], hints: { words: WORDS } }).matched)).toEqual(['column', 'about']);
  });

  it('a one-letter word matches nothing (it sits inside every name); two letters do', () => {
    const app: SourceApp = { appId: 'ledger', displayName: 'Ledger', tables: [{ name: 'rows', columns: [col('amount')], rowCount: 1 }] };
    expect(rankSources({ readerAppId: 'r', apps: [app], hints: { words: ['a'] } }).matched).toEqual([]);
    expect(ids(rankSources({ readerAppId: 'r', apps: [app], hints: { words: ['am'] } }).matched)).toEqual(['ledger']);
  });

  it('only the first sixteen distinct words count — a seventeenth is past the protocol’s bound', () => {
    const app: SourceApp = { appId: 'late', displayName: 'Late', tables: [{ name: 'rows', columns: [col('zebra')], rowCount: 1 }] };
    expect(rankSources({ readerAppId: 'r', apps: [app], hints: { words: [...WORDS, 'zebra'] } }).matched).toEqual([]);
    // a duplicate does not use up a place
    expect(ids(rankSources({ readerAppId: 'r', apps: [app], hints: { words: ['qa', 'QA', ' qa ', 'zebra'] } }).matched)).toEqual(['late']);
  });

  it('only the first sixteen hint tables count', () => {
    const app: SourceApp = { appId: 'late', displayName: 'Late', tables: [{ name: 'zebra', columns: [col('x')], rowCount: 1 }] };
    const tables = WORDS.map((word) => `t_${word}`);
    expect(rankSources({ readerAppId: 'r', apps: [app], hints: { tables: [...tables, 'zebra'] } }).matched).toEqual([]);
    expect(ids(rankSources({ readerAppId: 'r', apps: [app], hints: { tables: ['zebra'] } }).matched)).toEqual(['late']);
  });
});

describe('rankSources — a table with NOTHING shareable (every column credential-named) is never offered for allowing (D23)', () => {
  const VAULT: SourceApp = {
    appId: 'vault',
    displayName: 'Vault',
    tables: [{ name: 'keys', columns: [col('api_key', true), col('access_token', true)], rowCount: 4 }],
  };
  const MIXED: SourceApp = {
    appId: 'mixed',
    displayName: 'Mixed',
    tables: [
      { name: 'keys', columns: [col('api_key', true), col('secret', true)], rowCount: 2 },
      { name: 'transactions', columns: [col('amount'), col('category')], rowCount: 9 },
    ],
  };

  it('an app whose every table is credential-only has no data to read — excluded as no-tables, matched by nothing', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [VAULT, LEDGER], hints: { tables: ['keys'], words: ['keys'] } });
    expect(ids(ranked.matched)).toEqual([]);
    expect(ids(ranked.rest)).toEqual(['ledger']);
    expect(ranked.excluded).toEqual([{ appId: 'vault', displayName: 'Vault', reason: 'no-tables' }]);
  });

  it('with no hint, a credential-only table is NOT pre-selected — the other tables are — and it stays listed with its flags for the sheet', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [MIXED] });
    const mixed = ranked.rest[0]!;
    expect(preselectedTables(mixed)).toEqual(['transactions']);
    expect(mixed.tables.map((table) => table.name)).toEqual(['keys', 'transactions']);
    expect(mixed.tables[0]!.columns).toEqual([col('api_key', true), col('secret', true)]);
  });

  it('an EXACT hint-table naming a credential-only table neither matches nor scores — and is never pre-selected', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [MIXED], hints: { tables: ['keys'] } });
    expect(ranked.matched).toEqual([]);
    expect(preselectedTables(ranked.rest[0]!)).toEqual(['transactions']);
  });

  it('a WORD in a credential-only table’s name does not match it either', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [MIXED], hints: { words: ['keys', 'amount'] } });
    expect(ranked.matched[0]!.matchedTables).toEqual(['transactions']);
    expect(preselectedTables(ranked.matched[0]!)).toEqual(['transactions']);
  });
});

describe('rankSources — matched first, at most MATCHED_MAX, the rest behind *more apps…*', () => {
  it('MATCHED_MAX is five', () => {
    expect(MATCHED_MAX).toBe(5);
  });

  it('the overflow beyond five goes to the head of the rest, highest first, before the unmatched apps', () => {
    const apps: SourceApp[] = [];
    // Seven matching apps with strictly falling scores (k word hits in table names) …
    const words = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'];
    for (let k = 7; k >= 1; k -= 1) {
      apps.push({
        appId: `m${k}`,
        displayName: `Match ${k}`,
        tables: words.slice(0, k).map((word) => ({ name: `t_${word}`, columns: [col('x')], rowCount: 1 })),
      });
    }
    // … and two that match nothing.
    apps.push({ appId: 'z', displayName: 'Zulu', tables: [{ name: 'plain', columns: [col('x')], rowCount: 1 }] });
    apps.push({ appId: 'y', displayName: 'Alpha', tables: [{ name: 'plain', columns: [col('x')], rowCount: 1 }] });
    const ranked = rankSources({ readerAppId: 'r', apps, hints: { words } });
    expect(ids(ranked.matched)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3']);
    expect(ids(ranked.rest)).toEqual(['m2', 'm1', 'y', 'z']);
    expect(ranked.rest[0]!.score).toBeGreaterThan(ranked.rest[1]!.score);
    expect(ranked.rest[1]!.score).toBeGreaterThan(0);
  });
});

describe('preselectedTables — matched tables pre-selected, all when none matched', () => {
  it('a source with matched tables pre-selects exactly those', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER], hints: { words: ['category'] } });
    expect(ranked.matched[0]!.matchedTables).toEqual(['transactions']);
    expect(preselectedTables(ranked.matched[0]!)).toEqual(['transactions']);
  });

  it('a hint-table match and a column-word match both pre-select their tables, in the app’s table order', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [LEDGER], hints: { tables: ['accounts'], words: ['amount'] } });
    expect(preselectedTables(ranked.matched[0]!)).toEqual(['transactions', 'accounts']);
  });

  it('a source matched only by its name or description pre-selects every table', () => {
    const ranked = rankSources({ readerAppId: 'r', apps: [LEDGER], hints: { words: ['money'] } });
    expect(ranked.matched[0]!.matchedTables).toEqual([]);
    expect(preselectedTables(ranked.matched[0]!)).toEqual(['transactions', 'accounts']);
  });

  it('an unmatched source pre-selects every table', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [PANTRY] });
    expect(preselectedTables(ranked.rest[0]!)).toEqual(['items']);
  });
});

describe('rankSources — the excluded apps collapse into one list with their reason', () => {
  it('EXCLUDED_REASONS is the four reasons the footer can name', () => {
    expect([...EXCLUDED_REASONS]).toEqual(['reader', 'no-tables', 'too-large', 'sidecar']);
  });

  it('the app that asks is never its own candidate, even when it would match best', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [BUDGET, LEDGER], hints: { tables: ['envelopes'], words: ['category'] } });
    expect(ids(ranked.matched)).toEqual(['ledger']);
    expect(ranked.excluded).toEqual([{ appId: 'budget', displayName: 'Budget', reason: 'reader' }]);
  });

  it('an app with no tables is excluded as no-tables', () => {
    const empty: SourceApp = { appId: 'notes', displayName: 'Notes', tables: [] };
    const ranked = rankSources({ readerAppId: 'budget', apps: [empty, PANTRY] });
    expect(ids(ranked.rest)).toEqual(['pantry']);
    expect(ranked.excluded).toEqual([{ appId: 'notes', displayName: 'Notes', reason: 'no-tables' }]);
  });

  it('an app over the copy cap and an app holding a WhatsApp fact arrive excluded and stay excluded — two sidecar apps both', () => {
    const apps: SourceInput[] = [
      { appId: 'photos', displayName: 'Photos', excluded: 'too-large' },
      { appId: 'telepath', displayName: 'Telepath', excluded: 'sidecar' },
      { appId: 'chat', displayName: 'Chat', excluded: 'sidecar' },
      LEDGER,
    ];
    const ranked = rankSources({ readerAppId: 'budget', apps, hints: { words: ['photo', 'telepath', 'chat'] } });
    expect(ids(ranked.matched)).toEqual([]);
    expect(ids(ranked.rest)).toEqual(['ledger']);
    expect(ranked.excluded).toEqual([
      { appId: 'chat', displayName: 'Chat', reason: 'sidecar' },
      { appId: 'photos', displayName: 'Photos', reason: 'too-large' },
      { appId: 'telepath', displayName: 'Telepath', reason: 'sidecar' },
    ]);
  });

  it('the reader is excluded as the reader even when it also arrived excluded for another reason', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [{ appId: 'budget', displayName: 'Budget', excluded: 'sidecar' }] });
    expect(ranked.excluded).toEqual([{ appId: 'budget', displayName: 'Budget', reason: 'reader' }]);
  });

  it('the excluded list is ordered by displayName then appId, whatever the input order', () => {
    const a: SourceInput = { appId: 'b', displayName: 'Same', excluded: 'too-large' };
    const b: SourceInput = { appId: 'a', displayName: 'Same', excluded: 'sidecar' };
    expect(rankSources({ readerAppId: 'r', apps: [a, b] }).excluded).toEqual(rankSources({ readerAppId: 'r', apps: [b, a] }).excluded);
    expect(rankSources({ readerAppId: 'r', apps: [a, b] }).excluded.map((entry) => entry.appId)).toEqual(['a', 'b']);
  });

  it('every input lands in exactly one of matched, rest or excluded', () => {
    const empty: SourceApp = { appId: 'notes', displayName: 'Notes', tables: [] };
    const apps: SourceInput[] = [LEDGER, PANTRY, RECIPES, BUDGET, empty, { appId: 'photos', displayName: 'Photos', excluded: 'too-large' }];
    const ranked = rankSources({ readerAppId: 'budget', apps, hints: { words: ['category'] } });
    const all = [...ids(ranked.matched), ...ids(ranked.rest), ...ranked.excluded.map((entry) => entry.appId)].sort();
    expect(all).toEqual(['budget', 'ledger', 'notes', 'pantry', 'photos', 'recipes']);
  });
});

// ---------------------------------------------------------------------------------------------
// collectSources — the ONE caller, on a real memory user db: where the reader, the WhatsApp fact
// and the copy cap are decided
// ---------------------------------------------------------------------------------------------

describe('collectSources — the exclusions are decided from the file, not trusted from a caller', () => {
  let db: UserDb;
  let seq = 0;

  async function app(name: string, ddl: string[] = [], inserts: string[] = []): Promise<string> {
    const appId = db.installApp({ displayName: name, html: `<!doctype html><title>${name}</title>` }).appId;
    if (ddl.length > 0) await db.applyAppDdl(appId, ddl);
    for (const sql of inserts) {
      await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${++seq}`, instanceId: 'seed', op: 'exec', sql });
    }
    return appId;
  }

  /** A declared WhatsApp connection: the sidecar's symbolic host — the fact, whatever the row's status. */
  function holdWhatsApp(appId: string): void {
    db.putDeclaredConnection(
      appId,
      'whatsapp',
      { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2],
      'starter',
    );
  }

  const offered = (ranked: Awaited<ReturnType<typeof collectSources>>): string[] => [...ranked.matched, ...ranked.rest].map((source) => source.appId).sort();

  beforeEach(async () => {
    db = await installTestUserDb();
  });

  it('TWO apps holding a WhatsApp fact are BOTH excluded as sidecar — neither is "the last" one, and neither is offered', async () => {
    const budget = await app('Budget');
    const telepath = await app('Telepath', ['CREATE TABLE messages (body TEXT)'], ["INSERT INTO messages VALUES ('hi')"]);
    const chat = await app('Chat', ['CREATE TABLE messages (body TEXT)'], ["INSERT INTO messages VALUES ('yo')"]);
    const ledger = await app('Ledger', ['CREATE TABLE transactions (amount INTEGER)'], ['INSERT INTO transactions VALUES (1)']);
    holdWhatsApp(telepath);
    holdWhatsApp(chat);
    const ranked = await collectSources(db, budget, { words: ['messages'] });
    expect(offered(ranked)).toEqual([ledger]);
    expect(ranked.excluded).toEqual([
      { appId: budget, displayName: 'Budget', reason: 'reader' },
      { appId: chat, displayName: 'Chat', reason: 'sidecar' },
      { appId: telepath, displayName: 'Telepath', reason: 'sidecar' },
    ]);
  });

  it('ONE app holding a WhatsApp fact is excluded as sidecar too', async () => {
    const budget = await app('Budget');
    const telepath = await app('Telepath', ['CREATE TABLE messages (body TEXT)'], ["INSERT INTO messages VALUES ('hi')"]);
    holdWhatsApp(telepath);
    const ranked = await collectSources(db, budget);
    expect(offered(ranked)).toEqual([]);
    expect(ranked.excluded).toContainEqual({ appId: telepath, displayName: 'Telepath', reason: 'sidecar' });
  });

  it('an app whose runtime is over the copy cap is excluded too-large — measured on the bytes a read would copy; one at the cap is offered', async () => {
    const budget = await app('Budget');
    const photos = await app('Photos', ['CREATE TABLE photos (name TEXT)'], ["INSERT INTO photos VALUES ('a')"]);
    const notes = await app('Notes', ['CREATE TABLE notes (body TEXT)'], ["INSERT INTO notes VALUES ('b')"]);
    const real = db.exportAppRuntime.bind(db);
    vi.spyOn(db, 'exportAppRuntime').mockImplementation(async (appId: string) =>
      appId === photos ? new Uint8Array(ACCESS_SOURCE_MAX_BYTES + 1) : appId === notes ? new Uint8Array(ACCESS_SOURCE_MAX_BYTES) : real(appId),
    );
    const ranked = await collectSources(db, budget);
    expect(offered(ranked)).toEqual([notes]);
    expect(ranked.excluded).toContainEqual({ appId: photos, displayName: 'Photos', reason: 'too-large' });
  });

  it('the asking app is ALWAYS in the list — excluded as the reader even when its own data would match best', async () => {
    const budget = await app('Budget', ['CREATE TABLE envelopes (category TEXT)'], ["INSERT INTO envelopes VALUES ('food')"]);
    const ledger = await app('Ledger', ['CREATE TABLE transactions (category TEXT)'], ["INSERT INTO transactions VALUES ('food')"]);
    const ranked = await collectSources(db, budget, { tables: ['envelopes'], words: ['category'] });
    expect(offered(ranked)).toEqual([ledger]);
    expect(ranked.excluded).toEqual([{ appId: budget, displayName: 'Budget', reason: 'reader' }]);
  });

  it('an app with no tables, and one whose only table is credential-named, both have no data to read', async () => {
    const budget = await app('Budget');
    const empty = await app('Empty');
    const vault = await app('Vault', ['CREATE TABLE keys (api_key TEXT, access_token TEXT)'], ["INSERT INTO keys VALUES ('k', 't')"]);
    const ranked = await collectSources(db, budget, { tables: ['keys'] });
    expect(offered(ranked)).toEqual([]);
    expect(ranked.excluded).toEqual([
      { appId: budget, displayName: 'Budget', reason: 'reader' },
      { appId: empty, displayName: 'Empty', reason: 'no-tables' },
      { appId: vault, displayName: 'Vault', reason: 'no-tables' },
    ]);
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — the pairs' pure core (contract v2 D-PR5-4; AC34; S10, F3, SC4).
//
// `registryTables(schema)` lifts `tableSummaries`' column rule (agent/intentContext.ts) into ONE
// shared pure helper over the app's REGISTERED schema — `type === 'table'` objects, column names
// parsed from the verbatim DDL, `sensitive: isCredentialKeyName(name)`, `rowCount: 0` — so a pair
// is found with NO export and NO `describeAppData`. `rankPairs` is the pure core
// `listPairSuggestions` (access/pairs.ts) runs: for every reader's want WITH hints, every source
// ranked by `rankSources`' own tiers, admitted ONLY on a TABLE-tier match (an exact hint table, or
// a hint word inside an offerable table's name), deterministic (score desc, reader name, source
// name, ids). The exclusions that need the file (live access, declines, muted readers, share /
// imported readers, sidecar sources, the session's not-offered memory) are accessPairs.test.ts's.
//
// Q (lane T-B — the contract names the two functions and `PairSuggestion`, not their inputs):
// `registryTables` lives in relevance.ts beside `isOfferable` and takes the `getAppSchema` value
// (or undefined); `rankPairs({ readers: [{ appId, displayName, wants }], sources: SourceApp[] })`
// answers EVERY admitted pair sorted (the ≤ 5 cut is Settings'); `matchedTables` names only the
// TABLE-tier tables, in the source's own order.
// =========================================================================================

interface PairWant {
  purpose: string;
  hints?: { tables?: string[]; words?: string[] };
}
interface PairReader {
  appId: string;
  displayName: string;
  wants: PairWant[];
}
interface PairSuggestionV5 {
  readerAppId: string;
  readerName: string;
  sourceAppId: string;
  sourceName: string;
  want: PairWant;
  matchedTables: string[];
  score: number;
}
interface SchemaJson {
  objects: Array<{ type: string; name: string; ddl: string }>;
}
const relevanceV5 = async (): Promise<{
  registryTables: (schema: SchemaJson | undefined) => Array<{ name: string; columns: Array<{ name: string; sensitive: boolean }>; rowCount: number }>;
  rankPairs: (input: { readers: readonly PairReader[]; sources: readonly SourceApp[] }) => PairSuggestionV5[];
}> => (await import('../access/relevance.js')) as never;

const SPENDING: PairWant = { purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['category'] } };
const BUDGET_READER: PairReader = { appId: 'budget', displayName: 'Budget', wants: [SPENDING] };
const pairsOf = (pairs: readonly PairSuggestionV5[]): string[] => pairs.map((pair) => `${pair.readerAppId}→${pair.sourceAppId}`);

describe('D-PR5-4 registryTables — the registered schema as SourceTables, no export, no describe (F3)', () => {
  it('every `table` object, its columns parsed from the DDL, credential-named ones sensitive, rowCount 0', async () => {
    const { registryTables } = await relevanceV5();
    expect(typeof registryTables).toBe('function');
    const tables = registryTables({
      objects: [
        { type: 'table', name: 'transactions', ddl: 'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)' },
        { type: 'index', name: 'tx_by_category', ddl: 'CREATE INDEX tx_by_category ON transactions (category)' },
        { type: 'table', name: 'accounts', ddl: 'CREATE TABLE accounts (name TEXT, balance INTEGER)' },
        { type: 'trigger', name: 'tx_touch', ddl: 'CREATE TRIGGER tx_touch AFTER INSERT ON transactions BEGIN SELECT 1; END' },
        { type: 'view', name: 'big', ddl: 'CREATE VIEW big AS SELECT * FROM transactions WHERE amount > 100' },
      ],
    });
    expect(tables).toEqual([
      { name: 'transactions', columns: [col('id'), col('amount'), col('category'), col('api_key', true)], rowCount: 0 },
      { name: 'accounts', columns: [col('name'), col('balance')], rowCount: 0 },
    ]);
  });

  it('a constraint clause is not a column (the tableSummaries rule: PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT dropped)', async () => {
    const { registryTables } = await relevanceV5();
    const [table] = registryTables({ objects: [{ type: 'table', name: 'items', ddl: 'CREATE TABLE items (name TEXT, qty INTEGER, UNIQUE (name))' }] });
    expect(table?.columns.map((column) => column.name)).toEqual(['name', 'qty']);
  });

  it('an app with no registered schema has no tables', async () => {
    const { registryTables } = await relevanceV5();
    expect(registryTables(undefined)).toEqual([]);
    expect(registryTables({ objects: [] })).toEqual([]);
  });
});

describe('D-PR5-4 rankPairs — admitted ONLY on a table-tier match (S10)', () => {
  it('an exact hint table pairs', async () => {
    const { rankPairs } = await relevanceV5();
    const pairs = rankPairs({ readers: [BUDGET_READER], sources: [LEDGER] });
    expect(pairsOf(pairs)).toEqual(['budget→ledger']);
    expect(pairs[0]).toMatchObject({ readerAppId: 'budget', readerName: 'Budget', sourceAppId: 'ledger', sourceName: 'Ledger', want: SPENDING, matchedTables: ['transactions'] });
    expect(pairs[0]!.score).toBeGreaterThan(0);
  });

  // G5-15 (SA-5): the table tier takes a hint word EQUAL to a whole `_`-token (≥ 3 chars) — the word is now the
  // table's own token; was 'transaction', a substring the fold no longer admits for pairing.
  it('a hint WORD that is a whole token of an offerable table’s name pairs ("transactions" finds transactions) (G5-15)', async () => {
    const { rankPairs } = await relevanceV5();
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to add up spending', hints: { words: ['transactions'] } }] };
    expect(pairsOf(rankPairs({ readers: [reader], sources: [LEDGER] }))).toEqual(['budget→ledger']);
  });

  it('NEGATIVE: a hint matching only a COLUMN never pairs (the column tier ranks, it never admits)', async () => {
    const { rankPairs } = await relevanceV5();
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to compare amounts', hints: { words: ['amount', 'category'] } }] };
    expect(rankPairs({ readers: [reader], sources: [LEDGER, PANTRY] })).toEqual([]);
  });

  it('NEGATIVE: a hint matching only the app’s name or description never pairs', async () => {
    const { rankPairs } = await relevanceV5();
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to look in the cupboard', hints: { words: ['cupboard', 'pantry'] } }] };
    expect(rankPairs({ readers: [reader], sources: [PANTRY] })).toEqual([]);
  });

  it('NEGATIVE: a table whose every column is credential-named never pairs, even named exactly', async () => {
    const { rankPairs } = await relevanceV5();
    const vault: SourceApp = { appId: 'vault', displayName: 'Vault', tables: [{ name: 'tokens', columns: [col('api_key', true), col('access_token', true)], rowCount: 0 }] };
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to sign in', hints: { tables: ['tokens'], words: ['token'] } }] };
    expect(rankPairs({ readers: [reader], sources: [vault] })).toEqual([]);
  });

  it('NEGATIVE: a want without hints — or with empty hints — never pairs', async () => {
    const { rankPairs } = await relevanceV5();
    const bare: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to show spending' }, { purpose: 'to show more', hints: {} }, { purpose: 'and more', hints: { tables: [], words: [] } }] };
    expect(rankPairs({ readers: [bare], sources: [LEDGER, PANTRY] })).toEqual([]);
  });

  it('NEGATIVE: a reader never pairs with itself', async () => {
    const { rankPairs } = await relevanceV5();
    const self: SourceApp = { appId: 'budget', displayName: 'Budget', tables: [{ name: 'transactions', columns: [col('amount')], rowCount: 0 }] };
    expect(rankPairs({ readers: [BUDGET_READER], sources: [self] })).toEqual([]);
  });

  it('matchedTables names only the TABLE-tier tables — a column-only match beside it is not named', async () => {
    const { rankPairs } = await relevanceV5();
    // accounts carries a `category` column (a column-tier hit for the word) — it ranks, it is never named.
    const ledger: SourceApp = {
      ...LEDGER,
      tables: [
        { name: 'accounts', columns: [col('name'), col('category')], rowCount: 0 },
        { name: 'transactions', columns: [col('amount'), col('category')], rowCount: 0 },
      ],
    };
    const [pair] = rankPairs({ readers: [BUDGET_READER], sources: [ledger] });
    expect(pair?.matchedTables).toEqual(['transactions']);
  });
});

describe('D-PR5-4 rankPairs — ranked by rankSources’ tiers, deterministic', () => {
  const tableOf = (name: string, columns: string[]): SourceApp['tables'][number] => ({ name, columns: columns.map((c) => col(c)), rowCount: 0 });

  it('a hint matching a parsed COLUMN ranks in the column tier: of two table-tier sources the one with the column comes first, whatever the names say', async () => {
    const { rankPairs } = await relevanceV5();
    const bank: SourceApp = { appId: 'bank', displayName: 'Bank', tables: [tableOf('transactions', ['amount'])] };
    const ledger: SourceApp = { appId: 'ledger', displayName: 'Ledger', tables: [tableOf('transactions', ['amount', 'category'])] };
    const pairs = rankPairs({ readers: [BUDGET_READER], sources: [bank, ledger] });
    expect(pairsOf(pairs)).toEqual(['budget→ledger', 'budget→bank']);
    expect(pairs[0]!.score).toBeGreaterThan(pairs[1]!.score);
  });

  it('an exact hint table outranks any number of word hits', async () => {
    const { rankPairs } = await relevanceV5();
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to plan', hints: { tables: ['transactions'], words: ['plan', 'goal', 'budget'] } }] };
    const plans: SourceApp = { appId: 'plans', displayName: 'Plans', tables: [tableOf('plan_goals', ['budget'])] };
    const ledger: SourceApp = { appId: 'ledger', displayName: 'Ledger', tables: [tableOf('transactions', ['amount'])] };
    expect(pairsOf(rankPairs({ readers: [reader], sources: [plans, ledger] }))).toEqual(['budget→ledger', 'budget→plans']);
  });

  it('ties break by reader name, then source name, then ids — and the input order never matters', async () => {
    const { rankPairs } = await relevanceV5();
    const want: PairWant = { purpose: 'to count', hints: { tables: ['transactions'] } };
    const readers: PairReader[] = [
      { appId: 'r-zeta', displayName: 'Zeta', wants: [want] },
      { appId: 'r-alpha', displayName: 'Alpha', wants: [want] },
    ];
    const sources: SourceApp[] = [
      { appId: 's-2', displayName: 'Ledger', tables: [tableOf('transactions', ['amount'])] },
      { appId: 's-1', displayName: 'Ledger', tables: [tableOf('transactions', ['amount'])] },
      { appId: 's-0', displayName: 'Bank', tables: [tableOf('transactions', ['amount'])] },
    ];
    const expected = ['r-alpha→s-0', 'r-alpha→s-1', 'r-alpha→s-2', 'r-zeta→s-0', 'r-zeta→s-1', 'r-zeta→s-2'];
    expect(pairsOf(rankPairs({ readers, sources }))).toEqual(expected);
    expect(pairsOf(rankPairs({ readers: [...readers].reverse(), sources: [...sources].reverse() }))).toEqual(expected);
  });

  it('pure: the same input answers the same pairs twice, and the inputs are not changed', async () => {
    const { rankPairs } = await relevanceV5();
    const readers = [BUDGET_READER];
    const sources = [LEDGER, PANTRY, RECIPES];
    const frozen = JSON.stringify({ readers, sources });
    expect(rankPairs({ readers, sources })).toEqual(rankPairs({ readers, sources }));
    expect(JSON.stringify({ readers, sources })).toBe(frozen);
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-13 (IB-2, SA-2) and G5-15 (SA-5).
//
// G5-13 `registryTables` is TOTAL over a planted registry (`getAppSchema` is `JSON.parse(…) as
// AppSchemaJson`, unchecked, and no import cleans `snug_app_schemas`): `Array.isArray(objects)`,
// string `type`/`name`/`ddl`, names matching `APP_OBJECT_NAME_RULE`. The column list is split at
// paren depth 0 OUTSIDE string literals — the comma split made `DECIMAL(10,2)` a column `2)` and an
// all-credential table offerable through a fake `64))` column (AC34's negative broken); one level
// of `"…"`, `` `…` `` or `[…]` quoting is stripped before `isCredentialKeyName` (a quoted `token`
// read as NOT sensitive); `--` and `/* */` comments are skipped.
//
// G5-15 (SA-5) pair admission and the declared preselection (the TABLE tier, `tableTierTables`)
// take an exact hint table, or a hint word EQUAL to a whole `_`-separated token (≥ 3 chars) of the
// table name — never a substring: 16 bigrams ('es', 'at', …) would otherwise put most of a source's
// tables in the table tier. `rankSources`' looser tiers stay for RANKING.
// =========================================================================================

describe('G5-13 (IB-2) registryTables splits the column list at paren depth 0, outside string literals', () => {
  const columnsOf = async (ddl: string): Promise<string[]> => {
    const { registryTables } = await relevanceV5();
    return registryTables({ objects: [{ type: 'table', name: 't', ddl }] })[0]?.columns.map((column) => column.name) ?? [];
  };

  it('G5-13 DECIMAL(10,2) is one column, never a `2)`', async () => {
    expect(await columnsOf('CREATE TABLE t (id INTEGER PRIMARY KEY, amount DECIMAL(10,2), note TEXT)')).toEqual(['id', 'amount', 'note']);
  });

  it('G5-13 a two-column PRIMARY KEY (a, b) adds no column', async () => {
    expect(await columnsOf('CREATE TABLE t (a TEXT, b TEXT, PRIMARY KEY (a, b))')).toEqual(['a', 'b']);
  });

  it('G5-13 a CHECK (x IN (1, 2)) adds no column — nested parentheses', async () => {
    expect(await columnsOf('CREATE TABLE t (x INTEGER CHECK (x IN (1, 2)), y TEXT)')).toEqual(['x', 'y']);
  });

  it('G5-13 a comma inside a string literal is no split', async () => {
    expect(await columnsOf("CREATE TABLE t (kind TEXT DEFAULT 'a,b', n INTEGER CHECK (kind IN ('a', 'b, c')))")).toEqual(['kind', 'n']);
  });

  it('G5-13 `--` and `/* */` comments are skipped — a comma inside one is no split', async () => {
    expect(await columnsOf('CREATE TABLE t (a TEXT, -- the first, then\n b INTEGER /* x, y */, c TEXT)')).toEqual(['a', 'b', 'c']);
  });

  it('G5-13 one level of "…", `…` or […] quoting is stripped — and a quoted credential name is still sensitive', async () => {
    const { registryTables } = await relevanceV5();
    for (const quoted of ['"token"', '`token`', '[token]']) {
      const [table] = registryTables({ objects: [{ type: 'table', name: 't', ddl: `CREATE TABLE t (${quoted} TEXT, label TEXT)` }] });
      expect(table?.columns, quoted).toEqual([col('token', true), col('label')]);
    }
  });

  it('G5-13 NEGATIVE (AC34): an all-credential table with a nested-paren constraint has no offerable column', async () => {
    const { registryTables } = await relevanceV5();
    const [table] = registryTables({
      objects: [{ type: 'table', name: 'tokens', ddl: 'CREATE TABLE tokens (token TEXT, secret TEXT CHECK (length(secret) IN (32, 64)))' }],
    });
    expect(table?.columns).toEqual([col('token', true), col('secret', true)]);
  });
});

describe('G5-13 (SA-2) registryTables is total over a planted registry row — never throws', () => {
  it('G5-13 objects that is not an array → no tables', async () => {
    const { registryTables } = await relevanceV5();
    for (const planted of [{ objects: null }, {}, { objects: 'tables' }, { objects: { 0: { type: 'table', name: 't', ddl: 'CREATE TABLE t (a TEXT)' } } }]) {
      expect(() => registryTables(planted as never), JSON.stringify(planted)).not.toThrow();
      expect(registryTables(planted as never), JSON.stringify(planted)).toEqual([]);
    }
  });

  it('G5-13 an object whose type, name or ddl is not a string is skipped; its siblings are kept', async () => {
    const { registryTables } = await relevanceV5();
    const good = { type: 'table', name: 'items', ddl: 'CREATE TABLE items (name TEXT)' };
    const planted = [null, 7, { type: 'table', name: 5, ddl: 'CREATE TABLE five (a TEXT)' }, { type: 1, name: 'x', ddl: 'CREATE TABLE x (a TEXT)' }, { type: 'table', name: 'y' }, { type: 'table', name: 'z', ddl: null }];
    const tables = registryTables({ objects: [...planted, good] } as never);
    expect(tables.map((table) => table.name)).toEqual(['items']);
  });

  it('G5-13 a name failing APP_OBJECT_NAME_RULE is never a table (it would reach host sentences)', async () => {
    const { registryTables } = await relevanceV5();
    const tables = registryTables({
      objects: [
        { type: 'table', name: 'budget — Snug checked this', ddl: 'CREATE TABLE "budget — Snug checked this" (a TEXT)' },
        { type: 'table', name: '_hidden', ddl: 'CREATE TABLE _hidden (a TEXT)' },
        { type: 'table', name: 'budget', ddl: 'CREATE TABLE budget (a TEXT)' },
      ],
    });
    expect(tables.map((table) => table.name)).toEqual(['budget']);
  });
});

describe('G5-15 (SA-5) the TABLE tier admits an exact table or a whole `_`-token (≥ 3 chars) — never a substring', () => {
  const tableOf = (name: string): SourceApp['tables'][number] => ({ name, columns: [col('amount')], rowCount: 0 });
  const SPREE: SourceApp = { appId: 'ledger', displayName: 'Ledger', tables: [tableOf('expenses'), tableOf('notes'), tableOf('rates'), tableOf('category_totals')] };
  const tableTier = async (): Promise<(source: SourceApp, hints: { words?: string[]; tables?: string[] } | undefined) => string[]> =>
    ((await import('../access/relevance.js')) as unknown as { tableTierTables: (source: SourceApp, hints: unknown) => string[] }).tableTierTables;

  it('G5-15 bigram words ("es", "at", "ot") put NO table in the table tier', async () => {
    expect((await tableTier())(SPREE, { words: ['es', 'at', 'ot'] })).toEqual([]);
  });

  it('G5-15 a word inside a token but not equal to one is not the table tier ("expense" ≠ "expenses", "tota" ≠ "totals")', async () => {
    expect((await tableTier())(SPREE, { words: ['expense', 'tota'] })).toEqual([]);
  });

  it('G5-15 a word equal to a whole `_`-token (≥ 3 chars) is the table tier; an exact hint table is too', async () => {
    const tier = await tableTier();
    expect(tier(SPREE, { words: ['category'] })).toEqual(['category_totals']);
    expect(tier(SPREE, { words: ['totals'] })).toEqual(['category_totals']);
    expect(tier(SPREE, { tables: ['notes'] })).toEqual(['notes']);
  });

  it('G5-15 rankPairs admits no pair on bigram words', async () => {
    const { rankPairs } = await relevanceV5();
    const reader: PairReader = { appId: 'budget', displayName: 'Budget', wants: [{ purpose: 'to read it all', hints: { words: ['es', 'at', 'ot', 'te'] } }] };
    expect(rankPairs({ readers: [reader], sources: [SPREE] })).toEqual([]);
  });

  it('G5-15 guard: rankSources’ RANKING keeps its looser word tier (a substring still ranks the source)', () => {
    const ranked = rankSources({ readerAppId: 'budget', apps: [SPREE, PANTRY], hints: { words: ['expense'] } });
    expect(ids(ranked.matched)).toEqual(['ledger']);
  });
});
