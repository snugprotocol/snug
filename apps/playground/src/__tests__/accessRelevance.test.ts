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
