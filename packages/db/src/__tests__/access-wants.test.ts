/**
 * TASK-20261010-host-broker PR-5 (contract v2 D-PR5-2; AC33's db half, AC39's KB parse) — the
 * access declaration: a host-derived MIRROR of the app's CURRENT HTML, read by a SMALL grammar.
 *
 * `packages/db/src/access-wants.ts` — pure, DOM-free, total (never throws):
 *  - `ACCESS_WANTS_SCAN_MAX_UNITS = 65_536` — UTF-16 code units, applied by the function itself;
 *  - `findHeadMeta(html, name) → string | undefined` — the decoded `content` of the ONE head meta;
 *  - `extractAccessWants(html) → AccessWants | undefined`.
 * The grammar: scan from offset 0 up to the FIRST of `<script`, `<style`, `<body`, `</head`
 * (ASCII-case-insensitive, outside comments) or the unit cap; skip `<!-- … -->`; EXACTLY one
 * `<meta>` whose `name` is `snug:access-wants` (ASCII-case-insensitive) carrying exactly one
 * QUOTED `content`; decode ONLY `&quot; &apos; &amp; &lt; &gt;` (any other `&…;` → none; a bare
 * `&` stays literal); decoded > `ACCESS_WANTS_MAX_BYTES` UTF-8 → none (no truncation); `JSON.parse`
 * → `accessWantsSchema.safeParse` → `JSON.stringify(value).isWellFormed()` → the value. Any
 * ambiguity is NO declaration, never a refusal of the install.
 *
 * The db half: internal `writeAccessWantsFor(sql, appId)` reads the CURRENT version's first 65,536
 * characters and writes the `accessWants:<appId>` row (canonical JSON) or DELETES it; `insertVersion`
 * calls it, so every admission mirrors (install, save, revert, reset, bundle install/update — the
 * share and the hand-in). Every import, BOTH origins, deletes every `accessWants:` row and
 * re-derives one per app it holds. Accessors `getAccessWants(appId)` and `listAccessWants()`.
 *
 * Written BEFORE the module exists (Gate 3): it is loaded through a VARIABLE specifier, so a
 * missing module reds each row on its own and the guards stay green (docs/lessons.md 2026-10-11).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACCESS_WANTS_MAX_BYTES, USERDB_TABLES, accessWantsSchema, type AccessWants } from '@snugprotocol/protocol';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryBackend, type MemoryBackend } from '../persistence.js';
import { buildAppBundle, installAppFromBundle, updateAppFromBundle } from '../userdb/app-bundle.js';
import { accessWantsSettingKey } from '../userdb/app-settings-keys.js';
import { openUserDb, type UserDb } from '../userdb/userdb.js';
import { locateWasm } from './helpers.js';

// ------------------------------------------------------------------ the module, isolated

type AccessWantsModule = typeof import('../access-wants.js');
const MODULE = '../access-wants.js';
let loading: Promise<AccessWantsModule> | undefined;
function wantsModule(): Promise<AccessWantsModule> {
  loading ??= import(/* @vite-ignore */ MODULE) as Promise<AccessWantsModule>;
  return loading;
}
async function extract(html: string): Promise<AccessWants | undefined> {
  return (await wantsModule()).extractAccessWants(html);
}

// ------------------------------------------------------------------------------ fixtures

const WANTS: AccessWants = [{ purpose: 'to show your spending by category', hints: { tables: ['transactions', 'accounts'], words: ['spending'] } }];
const OTHER_WANTS: AccessWants = [{ purpose: 'to plan meals from your pantry', hints: { tables: ['pantry'] } }];
const json = (value: unknown): string => JSON.stringify(value);

/** One declaring meta: single-quoted by default (the KB's form), double-quoted on request. */
const metaTag = (content: string, quote: "'" | '"' = "'"): string => `<meta name="snug:access-wants" content=${quote}${content}${quote}>`;

/** A page shaped like the KB template: charset, viewport, THEN whatever `head` carries, then a script in the head. */
const page = (head: string, body = '<div id="root"></div>'): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    head,
    '<title>Budget</title>',
    '<script>window.budget = 1</script>',
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');

const DECLARING = page(metaTag(json(WANTS)));
const DECLARING_OTHER = page(metaTag(json(OTHER_WANTS)));
const PLAIN = page('');

/**
 * The KB 87 example this lane expects (AC39: the meta right after the viewport meta and BEFORE any
 * `<script>`/`<style>`, single-quoted attribute). The KB section does not exist yet — I-2b writes it;
 * the row below that reads the KB file pins that whatever example it carries parses here too.
 */
const KB_EXAMPLE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  `  <meta name="snug:access-wants" content='[{"purpose":"to show your spending by category","hints":{"tables":["transactions","accounts"],"words":["spending","budget"]}}]'>`,
  '  <title>Budget</title>',
  '  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>',
  '</head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n');

const KB_87 = fileURLToPath(new URL('../../../knowledge/prompts/knowledge-base/app-authoring/87-cross-app-access.md', import.meta.url));

// ============================================================== the pure grammar (D-PR5-2)

describe('access-wants.ts — the constant and the happy path (D-PR5-2)', () => {
  it('D-PR5-2 ACCESS_WANTS_SCAN_MAX_UNITS is 65,536 UTF-16 code units', async () => {
    expect((await wantsModule()).ACCESS_WANTS_SCAN_MAX_UNITS).toBe(65_536);
  });

  it('D-PR5-2 a single-quoted declaration right after the viewport meta is the declaration', async () => {
    expect(await extract(DECLARING)).toEqual(WANTS);
  });

  it('D-PR5-2 the value is the SCHEMA-parsed value (a want without hints keeps no hints key)', async () => {
    const value = await extract(page(metaTag(json([{ purpose: 'to read your notes' }]))));
    expect(value).toEqual([{ purpose: 'to read your notes' }]);
    expect(value).toEqual(accessWantsSchema.parse([{ purpose: 'to read your notes' }]));
  });

  it('D-PR5-2 a double-quoted content with &quot; entities decodes to the same declaration', async () => {
    expect(await extract(page(metaTag(json(WANTS).replace(/"/g, '&quot;'), '"')))).toEqual(WANTS);
  });

  it('D-PR5-2 the name is matched ASCII-case-insensitively', async () => {
    expect(await extract(page(`<meta name="SNUG:Access-Wants" content='${json(WANTS)}'>`))).toEqual(WANTS);
  });

  it('D-PR5-2 the attribute order does not matter (content before name)', async () => {
    expect(await extract(page(`<meta content='${json(WANTS)}' name="snug:access-wants">`))).toEqual(WANTS);
  });

  it('D-PR5-2 the pure reader is exported from the package index (the shared preview reads a bundle\'s html in memory)', async () => {
    const index = (await import('../index.js')) as Record<string, unknown>;
    expect(typeof index.extractAccessWants).toBe('function');
    expect(typeof index.findHeadMeta).toBe('function');
    expect(index.ACCESS_WANTS_SCAN_MAX_UNITS).toBe(65_536);
  });

  it('D-PR5-2 a page with no declaration has none', async () => {
    expect(await extract(PLAIN)).toBeUndefined();
    expect(await extract('<html><body>budget</body></html>')).toBeUndefined();
  });

  it('D-PR5-2 findHeadMeta answers the decoded content of the one named head meta — and nothing for an absent name', async () => {
    const { findHeadMeta } = await wantsModule();
    expect(findHeadMeta(DECLARING, 'snug:access-wants')).toBe(json(WANTS));
    expect(findHeadMeta(page(metaTag(json(WANTS).replace(/"/g, '&quot;'), '"')), 'snug:access-wants')).toBe(json(WANTS));
    expect(findHeadMeta(DECLARING, 'viewport')).toBe('width=device-width, initial-scale=1');
    expect(findHeadMeta(DECLARING, 'description')).toBeUndefined();
  });
});

describe('access-wants.ts — comments and where the scan stops (D-PR5-2)', () => {
  it('D-PR5-2 a meta inside <!-- … --> is skipped — no declaration', async () => {
    expect(await extract(page(`<!-- ${metaTag(json(WANTS))} -->`))).toBeUndefined();
  });

  it('D-PR5-2 a commented-out <script, <style, <body or </head does NOT stop the scan', async () => {
    for (const stop of ['<script>', '<style>', '<body>', '</head>']) {
      expect(await extract(page(`<!-- ${stop} -->\n${metaTag(json(WANTS))}`)), stop).toEqual(WANTS);
    }
  });

  it('D-PR5-2 an unterminated comment swallows the rest — no declaration', async () => {
    expect(await extract(page(`<!-- never closed\n${metaTag(json(WANTS))}`))).toBeUndefined();
  });

  it('D-PR5-2 a meta AFTER <script, <style, <body or </head is not read (any case)', async () => {
    const after = (stop: string): string => `<!doctype html><html><head><meta charset="utf-8">${stop}${metaTag(json(WANTS))}</head><body></body></html>`;
    expect(await extract(after('')), 'the passing twin').toEqual(WANTS);
    for (const stop of ['<script>x()</script>', '<style>p{}</style>', '<SCRIPT src="a.js"></SCRIPT>', '<Style>p{}</Style>', '</head><body>', '</HEAD>', '<body>', '<BODY class="x">']) {
      expect(await extract(after(stop)), stop).toBeUndefined();
    }
  });

  it('D-PR5-2 decoys that are not the meta: another name, a prefix-sharing name, a non-name attribute, <metadata>', async () => {
    for (const decoy of [
      `<meta name="snug:access-wants-v2" content='${json(WANTS)}'>`,
      `<meta name="snug:access" content='${json(WANTS)}'>`,
      `<meta itemprop="snug:access-wants" content='${json(WANTS)}'>`,
      `<meta property="snug:access-wants" content='${json(WANTS)}'>`,
      `<metadata name="snug:access-wants" content='${json(WANTS)}'>`,
      `<link name="snug:access-wants" content='${json(WANTS)}'>`,
    ]) {
      expect(await extract(page(decoy)), decoy).toBeUndefined();
    }
  });
});

describe('access-wants.ts — exactly one meta, exactly one quoted content (D-PR5-2)', () => {
  it('D-PR5-2 two declaring metas — identical or not — are no declaration', async () => {
    expect(await extract(page(`${metaTag(json(WANTS))}\n${metaTag(json(WANTS))}`))).toBeUndefined();
    expect(await extract(page(`${metaTag(json(WANTS))}\n${metaTag(json(OTHER_WANTS))}`))).toBeUndefined();
  });

  it('D-PR5-2 an unquoted, a missing or an empty content is no declaration', async () => {
    expect(await extract(page('<meta name="snug:access-wants" content=[{"purpose":"x"}]>'))).toBeUndefined();
    expect(await extract(page('<meta name="snug:access-wants">'))).toBeUndefined();
    expect(await extract(page(`<meta name="snug:access-wants" content=''>`))).toBeUndefined();
  });

  it('D-PR5-2 two content attributes on the one meta are no declaration', async () => {
    expect(await extract(page(`<meta name="snug:access-wants" content='${json(WANTS)}' content='${json(OTHER_WANTS)}'>`))).toBeUndefined();
  });
});

describe('access-wants.ts — the five entities, nothing else (D-PR5-2)', () => {
  const withPurpose = (encoded: string): string => page(metaTag(`[{"purpose":"${encoded}"}]`));

  it('D-PR5-2 &quot; &apos; &amp; &lt; &gt; decode', async () => {
    expect(await extract(withPurpose('to show Ledger&apos;s totals'))).toEqual([{ purpose: "to show Ledger's totals" }]);
    expect(await extract(withPurpose('to compare income &amp; spending'))).toEqual([{ purpose: 'to compare income & spending' }]);
    expect(await extract(withPurpose('to flag totals &gt; 100 and &lt; 0'))).toEqual([{ purpose: 'to flag totals > 100 and < 0' }]);
    // `&quot;` decodes to a raw `"` — inside a JSON string it must arrive escaped, so the source writes `\&quot;`.
    expect(await extract(withPurpose('to show your \\&quot;top\\&quot; shops'))).toEqual([{ purpose: 'to show your "top" shops' }]);
  });

  it('D-PR5-2 a bare & stays literal', async () => {
    expect(await extract(withPurpose('to compare income & spending'))).toEqual([{ purpose: 'to compare income & spending' }]);
  });

  it('D-PR5-2 any other entity — named or numeric — is no declaration', async () => {
    expect(await extract(withPurpose('to compare income &amp; spending')), 'the passing twin').toBeDefined();
    for (const entity of ['&nbsp;', '&#39;', '&#x27;', '&copy;', '&AMP;', '&apos']) {
      // `&apos` without its `;` is a bare `&` followed by text — literal — so it is the one that PARSES.
      const value = await extract(withPurpose(`to compare income ${entity} spending`));
      if (entity === '&apos') expect(value, entity).toEqual([{ purpose: 'to compare income &apos spending' }]);
      else expect(value, entity).toBeUndefined();
    }
  });
});

describe('access-wants.ts — the size rules (D-PR5-2)', () => {
  it('D-PR5-2 a decoded value over ACCESS_WANTS_MAX_BYTES UTF-8 is no declaration — never truncated', async () => {
    const small = json([{ purpose: 'to show totals' }]);
    // Padded with JSON whitespace: the PARSED value is tiny and schema-valid; only the decoded length is over.
    const padded = (total: number): string => `[${' '.repeat(total - small.length)}${small.slice(1)}`;
    expect(padded(ACCESS_WANTS_MAX_BYTES)).toHaveLength(ACCESS_WANTS_MAX_BYTES);
    expect(await extract(page(metaTag(padded(ACCESS_WANTS_MAX_BYTES)))), 'at the cap').toEqual([{ purpose: 'to show totals' }]);
    expect(await extract(page(metaTag(padded(ACCESS_WANTS_MAX_BYTES + 1)))), 'one byte over').toBeUndefined();
  });

  it('D-PR5-2 the byte cap counts UTF-8 bytes of the DECODED text (multi-byte characters count more than once)', async () => {
    const value = [{ purpose: `to read ${'é'.repeat(150)}` }];
    const text = json(value);
    expect(text.length).toBeLessThan(ACCESS_WANTS_MAX_BYTES);
    const pad = ACCESS_WANTS_MAX_BYTES - new TextEncoder().encode(text).length;
    expect(await extract(page(metaTag(`[${' '.repeat(pad)}${text.slice(1)}`))), 'exactly at the byte cap').toEqual(value);
    expect(await extract(page(metaTag(`[${' '.repeat(pad + 1)}${text.slice(1)}`))), 'one byte over').toBeUndefined();
  });

  it('D-PR5-2 the scan stops at 65,536 UTF-16 units: a meta wholly past the cap is not read; one inside it is', async () => {
    const at = (padUnits: number): string => `<!doctype html><html><head><title>${'x'.repeat(padUnits)}</title>${metaTag(json(WANTS))}</head><body></body></html>`;
    const prefix = '<!doctype html><html><head><title>'.length + '</title>'.length;
    const meta = metaTag(json(WANTS)).length;
    expect(await extract(at(65_536 - prefix - meta)), 'the meta ends exactly at the cap').toEqual(WANTS);
    expect(await extract(at(65_536))).toBeUndefined();
  });

  it('D-PR5-2 the cap is in UTF-16 UNITS, not code points: an astral prefix of 32,768 emoji pushes the meta past it', async () => {
    const astral = (count: number): string => `<!doctype html><html><head><title>${'\u{1F600}'.repeat(count)}</title>${metaTag(json(WANTS))}</head><body></body></html>`;
    // 32,768 emoji = 65,536 units but only 32,768 code points: a code-point cap would still see the meta.
    expect(await extract(astral(32_768))).toBeUndefined();
    expect(await extract(astral(30_000)), 'the twin inside the cap').toEqual(WANTS);
  });

  it('D-PR5-2 a large body after the head does not matter — the scan never reaches it', async () => {
    expect(await extract(page(metaTag(json(WANTS)), 'x'.repeat(500_000)))).toEqual(WANTS);
  });
});

describe('access-wants.ts — JSON, the schema and well-formedness (D-PR5-2)', () => {
  it('D-PR5-2 invalid JSON is no declaration', async () => {
    for (const content of ['[{purpose:"x"}]', '[{"purpose":"x"}', 'to read things', '{"purpose":"x"}}']) {
      expect(await extract(page(metaTag(content))), content).toBeUndefined();
    }
  });

  it('D-PR5-2 a schema miss is no declaration — empty, five entries, an extra seat, an object, an unsafe purpose, snug_kv', async () => {
    const want = { purpose: 'to read things' };
    for (const value of [
      [],
      [want, want, want, want, want],
      [{ ...want, access: 'write' }],
      [{ ...want, source: 'ledger' }],
      want,
      [{ purpose: 'two\nlines' }],
      [{ purpose: '' }],
      [{ purpose: 'to read things', hints: { tables: ['snug_kv'] } }],
      [{ purpose: 'to read things', hints: { columns: ['amount'] } }],
    ]) {
      expect(await extract(page(metaTag(json(value)))), json(value)).toBeUndefined();
    }
  });

  // NOTE for the implementation lane (reported as a question): the contract's literal check
  // `JSON.stringify(value).isWellFormed()` cannot see a lone surrogate — a well-formed JSON.stringify
  // ESCAPES it back to `\\ud800`, so the string is always well-formed. The rule this row pins is the
  // behaviour the contract states (a lone surrogate → none): every parsed string must be well-formed.
  it('D-PR5-2 a lone surrogate from a \\ud800 escape is no declaration (isWellFormed) — a well-formed escape is', async () => {
    expect(await extract(page(metaTag('[{"purpose":"to read \\u00e9 rows"}]'))), 'the passing twin').toEqual([{ purpose: 'to read é rows' }]);
    expect(await extract(page(metaTag('[{"purpose":"to read \\ud800 rows"}]')))).toBeUndefined();
    expect(await extract(page(metaTag('[{"purpose":"to read rows","hints":{"words":["\\udfff"]}}]')))).toBeUndefined();
  });

  it('D-PR5-2 total — never throws, whatever the text', async () => {
    const { extractAccessWants, findHeadMeta } = await wantsModule();
    for (const junk of ['', '<', '<!--', '<meta', '<meta name="snug:access-wants" content=\'', '&', '\ud800', '<head>'.repeat(10_000), `<meta name="snug:access-wants" content='${'['.repeat(5000)}'>`]) {
      expect(() => extractAccessWants(junk), junk.slice(0, 40)).not.toThrow();
      expect(() => findHeadMeta(junk, 'snug:access-wants'), junk.slice(0, 40)).not.toThrow();
      expect(extractAccessWants(junk)).toBeUndefined();
    }
  });
});

describe('access-wants.ts — the KB 87 example parses (AC39)', () => {
  it('AC39 the example this lane writes from the contract (meta after the viewport meta, single-quoted, before any script) parses', async () => {
    expect(await extract(KB_EXAMPLE)).toEqual([{ purpose: 'to show your spending by category', hints: { tables: ['transactions', 'accounts'], words: ['spending', 'budget'] } }]);
  });

  it('AC39 every html example in KB 87 that carries the meta parses through extractAccessWants', async () => {
    expect(existsSync(KB_87), KB_87).toBe(true);
    const kb = readFileSync(KB_87, 'utf8');
    const blocks = [...kb.matchAll(/```html\n([\s\S]*?)```/g)].map((match) => match[1] ?? '').filter((block) => block.includes('snug:access-wants'));
    expect(blocks.length, 'KB 87 carries no html example of the declaration yet (I-2b writes the section)').toBeGreaterThan(0);
    for (const block of blocks) {
      const value = await extract(block);
      expect(value, block.slice(0, 120)).toBeDefined();
      expect(accessWantsSchema.safeParse(value).success).toBe(true);
    }
  });
});

// ======================================================== the db mirror (D-PR5-2, AC33)

const open = async (backend: MemoryBackend = createMemoryBackend()): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

const READER = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const SOURCE = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';

/** Raw settings rows of exported bytes — the claim is about the FILE, so no accessor sits in between. */
async function rawSettings(bytes: Uint8Array, prefix: string): Promise<Map<string, string>> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const raw = new SQL.Database(bytes);
  try {
    const rows = raw.exec(`SELECT key, value FROM ${USERDB_TABLES.settings} WHERE substr(key, 1, ${prefix.length}) = ? ORDER BY key`, [prefix]);
    return new Map((rows[0]?.values ?? []).map((row) => [String(row[0]), String(row[1])]));
  } finally {
    raw.close();
  }
}

/** Run raw SQL over exported bytes — what a hostile or foreign donor would do. */
async function doctor(bytes: Uint8Array, statements: Array<[sql: string, params?: unknown[]]>): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const raw = new SQL.Database(bytes);
  try {
    for (const [sql, params] of statements) raw.run(sql, (params ?? []) as never);
    return raw.export();
  } finally {
    raw.close();
  }
}

async function exported(build: (db: UserDb) => void | Promise<void>): Promise<Uint8Array> {
  const donor = await open();
  await build(donor);
  const bytes = await donor.exportUserDb({ includeSecrets: true });
  await donor.close();
  return bytes;
}

/** A bundle lifted from a sharer's app, then given whatever html the case needs. */
async function bundleWith(html: string): Promise<Awaited<ReturnType<typeof buildAppBundle>>> {
  const sharer = await open();
  const app = sharer.installApp({ displayName: 'Budget', html: PLAIN });
  const bundle = await buildAppBundle(sharer, app.appId, { docs: [] });
  await sharer.close();
  return { ...bundle, html };
}

let db: UserDb;
beforeEach(async () => {
  db = await open();
});

describe('the row mirrors the CURRENT html after every admission (D-PR5-2, AC33)', () => {
  it('D-PR5-2 installApp: a declaring app gets its row and the accessors read it; a plain app gets none', async () => {
    const declaring = db.installApp({ appId: READER, displayName: 'Budget', html: DECLARING });
    const plain = db.installApp({ appId: SOURCE, displayName: 'Ledger', html: PLAIN });
    expect(db.getAccessWants(declaring.appId)).toEqual(WANTS);
    expect(db.getSetting(accessWantsSettingKey(declaring.appId))).toEqual(WANTS);
    expect(db.getAccessWants(plain.appId)).toBeUndefined();
    expect(db.listSettingKeys()).not.toContain(accessWantsSettingKey(plain.appId));
    const all = db.listAccessWants();
    expect([...all.keys()]).toEqual([declaring.appId]);
    expect(all.get(declaring.appId)).toEqual(WANTS);
  });

  it('D-PR5-2 saveAppVersion: a new declaring version writes the row; a version without the meta DELETES it; another declaration replaces it', async () => {
    const app = db.installApp({ displayName: 'Budget', html: PLAIN });
    expect(db.getAccessWants(app.appId)).toBeUndefined();
    db.saveAppVersion(app.appId, DECLARING, 'adds the meta');
    expect(db.getAccessWants(app.appId)).toEqual(WANTS);
    db.saveAppVersion(app.appId, DECLARING_OTHER, 'another declaration');
    expect(db.getAccessWants(app.appId)).toEqual(OTHER_WANTS);
    db.saveAppVersion(app.appId, PLAIN, 'drops the meta');
    expect(db.getAccessWants(app.appId)).toBeUndefined();
    expect(db.listSettingKeys()).not.toContain(accessWantsSettingKey(app.appId));
  });

  it('D-PR5-2 revertApp mirrors the reverted html — both ways', async () => {
    const app = db.installApp({ displayName: 'Budget', html: PLAIN });
    db.saveAppVersion(app.appId, DECLARING); // v2
    db.saveAppVersion(app.appId, PLAIN); // v3
    expect(db.getAccessWants(app.appId)).toBeUndefined();
    db.revertApp(app.appId, 2);
    expect(db.getAccessWants(app.appId)).toEqual(WANTS);
    db.revertApp(app.appId, 1);
    expect(db.getAccessWants(app.appId)).toBeUndefined();
  });

  it('D-PR5-2 resetToFactory mirrors the factory html', async () => {
    const app = db.installApp({ displayName: 'Budget', html: DECLARING }); // v1 = the pinned factory
    db.saveAppVersion(app.appId, PLAIN);
    expect(db.getAccessWants(app.appId)).toBeUndefined();
    db.resetToFactory(app.appId);
    expect(db.getAccessWants(app.appId)).toEqual(WANTS);
  });

  it('D-PR5-2 a shared bundle install and update mirror the bundle html (the update without the meta deletes the row)', async () => {
    const installed = await installAppFromBundle(db, await bundleWith(DECLARING), { bundleId: 'a'.repeat(64) });
    expect(db.getAccessWants(installed.appId)).toEqual(WANTS);
    const first = await bundleWith(DECLARING_OTHER);
    // The update must be of the SAME lineage: reuse the installed copy's lineage.
    const lineage = db.getApp(installed.appId)?.installSource?.slice('share:'.length) ?? '';
    await updateAppFromBundle(db, installed.appId, { ...first, lineage }, { bundleId: 'b'.repeat(64) });
    expect(db.getAccessWants(installed.appId)).toEqual(OTHER_WANTS);
    await updateAppFromBundle(db, installed.appId, { ...first, lineage, html: PLAIN }, { bundleId: 'c'.repeat(64) });
    expect(db.getAccessWants(installed.appId)).toBeUndefined();
  });

  it('D-PR5-2 the hand-in\'s bundle path (provenance agent) mirrors too — install and update', async () => {
    const bundle = await bundleWith(DECLARING);
    const installed = await installAppFromBundle(db, bundle, { bundleId: 'd'.repeat(64), provenance: 'agent' });
    expect(db.getAccessWants(installed.appId)).toEqual(WANTS);
    await updateAppFromBundle(db, installed.appId, { ...bundle, html: DECLARING_OTHER }, { bundleId: 'e'.repeat(64), provenance: 'agent' });
    expect(db.getAccessWants(installed.appId)).toEqual(OTHER_WANTS);
  });

  it('D-PR5-2 the row is deleted with the app', async () => {
    const app = db.installApp({ displayName: 'Budget', html: DECLARING });
    expect(db.getAccessWants(app.appId)).toEqual(WANTS);
    await db.deleteApp(app.appId);
    expect(db.listSettingKeys()).not.toContain(accessWantsSettingKey(app.appId));
    expect(db.listAccessWants().size).toBe(0);
  });

  it('D-PR5-2 the accessors are tolerant: an unknown app has none; a row that does not parse reads as none and is not listed', async () => {
    expect(db.getAccessWants('f0f0f0f0-0000-4000-8000-000000000000')).toBeUndefined();
    const app = db.installApp({ displayName: 'Budget', html: DECLARING });
    expect(db.getAccessWants(app.appId), 'the passing twin').toEqual(WANTS);
    db.setSetting(accessWantsSettingKey(app.appId), [{ purpose: 'to read', access: 'write' }]);
    expect(db.getAccessWants(app.appId)).toBeUndefined();
    expect(db.listAccessWants().has(app.appId)).toBe(false);
  });
});

describe('every import, BOTH origins, deletes every accessWants: row and re-derives (D-PR5-2, AC33)', () => {
  for (const origin of ['UNTRUSTED', 'TRUSTED'] as const) {
    const options = origin === 'TRUSTED' ? { trustedOrigin: true } : {};

    it(`D-PR5-2 ${origin}: a planted row that differs from the HTML loses — the row is the HTML's declaration`, async () => {
      const bytes = await doctor(
        await exported((donor) => {
          donor.installApp({ appId: READER, displayName: 'Budget', html: DECLARING });
        }),
        [[`INSERT OR REPLACE INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [accessWantsSettingKey(READER), json(OTHER_WANTS)]]],
      );
      expect((await rawSettings(bytes, 'accessWants:')).get(accessWantsSettingKey(READER))).toBe(json(OTHER_WANTS)); // the donor really carries it

      await db.importUserDb(bytes, options);

      expect(db.getAccessWants(READER)).toEqual(WANTS);
    });

    it(`D-PR5-2 ${origin}: a planted row for an app whose HTML declares NOTHING is gone`, async () => {
      const bytes = await doctor(
        await exported((donor) => {
          donor.installApp({ appId: READER, displayName: 'Budget', html: PLAIN });
        }),
        [[`INSERT OR REPLACE INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [accessWantsSettingKey(READER), json(WANTS)]]],
      );

      await db.importUserDb(bytes, options);

      expect(db.getAccessWants(READER)).toBeUndefined();
      expect(db.listSettingKeys()).not.toContain(accessWantsSettingKey(READER));
    });

    it(`D-PR5-2 ${origin}: an orphan row (no such app in the file) is gone`, async () => {
      const orphan = accessWantsSettingKey('c0ffee00-0000-4000-8000-000000000000');
      const bytes = await doctor(
        await exported((donor) => {
          donor.installApp({ appId: SOURCE, displayName: 'Ledger', html: PLAIN });
        }),
        [[`INSERT OR REPLACE INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [orphan, json(WANTS)]]],
      );

      await db.importUserDb(bytes, options);

      expect(db.listSettingKeys().filter((key) => key.startsWith('accessWants:'))).toEqual([]);
    });

    it(`D-PR5-2 ${origin}: a declaring app whose row the file lacks gets one (re-derived, never trusted from the file)`, async () => {
      const bytes = await doctor(
        await exported((donor) => {
          donor.installApp({ appId: READER, displayName: 'Budget', html: DECLARING });
        }),
        [[`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [accessWantsSettingKey(READER)]]],
      );

      await db.importUserDb(bytes, options);

      expect(db.getAccessWants(READER)).toEqual(WANTS);
    });

    it(`D-PR5-2 ${origin}: an html cell stored as a BLOB derives nothing; the TEXT twin does`, async () => {
      const donorBytes = await exported((donor) => {
        donor.installApp({ appId: READER, displayName: 'Budget', html: DECLARING });
        donor.installApp({ appId: SOURCE, displayName: 'Ledger', html: DECLARING_OTHER });
      });
      const bytes = await doctor(donorBytes, [[`UPDATE ${USERDB_TABLES.appVersions} SET html = CAST(html AS BLOB) WHERE app_id = ?`, [READER]]]);

      await db.importUserDb(bytes, options);

      expect(db.getAccessWants(READER)).toBeUndefined();
      expect(db.getAccessWants(SOURCE), 'the TEXT twin').toEqual(OTHER_WANTS);
    });
  }

  it('D-PR5-2 a trusted round trip is byte-identical — the derivation is deterministic', async () => {
    db.installApp({ appId: READER, displayName: 'Budget', html: DECLARING });
    db.installApp({ appId: SOURCE, displayName: 'Ledger', html: DECLARING_OTHER });
    const first = await db.exportUserDb({ includeSecrets: true });
    const before = await rawSettings(first, 'accessWants:');
    expect(before.size).toBe(2);

    const restored = await open();
    await restored.importUserDb(first, { trustedOrigin: true });
    const after = await rawSettings(await restored.exportUserDb({ includeSecrets: true }), 'accessWants:');
    await restored.close();

    expect(after).toEqual(before);
  });
});

describe('the astral prefix: admission and a round trip agree with the pure function (D-PR5-2, S12)', () => {
  // SQLite's substr() counts CHARACTERS; the function caps UTF-16 UNITS. Whatever the db reads, the
  // function's own cap decides — so the pure answer, the admission and a trusted round trip agree.
  const astral = (count: number): string => `<!doctype html><html><head><title>${'\u{1F600}'.repeat(count)}</title>${metaTag(json(WANTS))}</head><body></body></html>`;

  for (const [count, expected] of [
    [32_768, undefined],
    [30_000, WANTS],
  ] as const) {
    it(`D-PR5-2 ${count} emoji before the meta → ${expected === undefined ? 'none' : 'the declaration'} — pure, at admission and after a trusted round trip`, async () => {
      const html = astral(count);
      expect(await extract(html), 'pure').toEqual(expected);

      const app = db.installApp({ appId: READER, displayName: 'Budget', html });
      // The twin with no declaration gets no row; the declaring one gets its row — either way never a refusal of the install.
      expect(db.getAppHtml(app.appId)).toBe(html);
      expect(db.getAccessWants(app.appId), 'at admission').toEqual(expected);
      if (expected !== undefined) expect(db.listAccessWants().get(app.appId)).toEqual(expected);

      const restored = await open();
      await restored.importUserDb(await db.exportUserDb({ includeSecrets: true }), { trustedOrigin: true });
      expect(restored.getAccessWants(app.appId), 'after a trusted round trip').toEqual(expected);
      await restored.close();
    });
  }
});
