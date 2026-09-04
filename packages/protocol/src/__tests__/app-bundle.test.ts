/**
 * TASK-20260904-app-sharing, Phase 1.1 — `appBundleSchema` (ADR-0063 §2).
 *
 * A bundle is a THIRD PARTY'S file: it arrives by attachment or by link from someone
 * the recipient may not know, and it carries html that will run in the recipient's
 * hub, connection requirements the recipient will be asked to approve, and DDL that
 * will run against the app's own database. Every bound therefore lives HERE, at the
 * parse (C5): strict at every level, capped everywhere, and with the two seats a
 * bundle must never carry — a `userLayer` (registry-synthesized only) and a `bundleId`
 * (the receiver computes identity; a carried id would be spoofable) — rejected by
 * shape, not by convention.
 *
 * PUBLICATION LINE: internal draft, OUT of `json-schemas.ts` SOURCES — the
 * connection-requirement / runtime-contract / net-frames posture.
 */

import { describe, expect, it } from 'vitest';
import {
  APP_BUNDLE_DDL_STATEMENT_RULE,
  APP_BUNDLE_DOC_SLUG_RULE,
  APP_BUNDLE_FORMAT,
  APP_BUNDLE_LINEAGE_RULE,
  APP_BUNDLE_MAX_BYTES,
  APP_BUNDLE_MAX_DDL_STATEMENTS,
  APP_BUNDLE_MAX_DOCS,
  APP_BUNDLE_MAX_DOC_CONTENT_CHARS,
  APP_BUNDLE_MAX_HTML_CHARS,
  appBundleId,
  appBundleSchema,
  canonicalAppBundleJson,
  isStructureOnlyDdl,
  parseAppBundle,
} from '../app-bundle.js';
import { AUTH_MAX_SLOTS_PER_APP, CONNECTION_PROVENANCES } from '../connection-requirement.js';
import { buildJsonSchemas } from '../json-schemas.js';

const LINEAGE = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';

const requirement = {
  slot: 'weather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  declaredApiHosts: ['api.openweathermap.org'],
};

const minimal = {
  format: APP_BUNDLE_FORMAT,
  lineage: LINEAGE,
  sharedAt: '2026-09-04T01:00:00.000Z',
  app: { displayName: 'Weather Wall', usesDb: true },
  html: '<!doctype html><html><body>hi</body></html>',
  connections: [],
};

const full = {
  ...minimal,
  producer: { hubVersion: '0.1.2' },
  app: {
    displayName: 'Weather Wall',
    description: 'A wall of weather.',
    iconEmoji: '🌦',
    iconColor: '#3366ff',
    usesDb: true,
  },
  contract: { overview: 'A weather wall. You summarize the forecast in one sentence.' },
  schema: { ddl: ['CREATE TABLE readings (id INTEGER PRIMARY KEY, temp REAL)', 'CREATE INDEX ix ON readings(temp)'] },
  docs: [
    { slug: 'vision', title: 'Vision', content: '# Vision\n\nA wall.' },
    { slug: 'build-prompt', content: 'Build a weather wall.' },
  ],
  connections: [requirement],
};

const parses = (value: unknown): boolean => appBundleSchema.safeParse(value).success;

describe('appBundleSchema — shape', () => {
  it('accepts the minimal bundle and the full bundle', () => {
    expect(parses(minimal)).toBe(true);
    expect(parses(full)).toBe(true);
  });

  it('pins the format literal and the bounds as exported constants (never prose-only literals)', () => {
    expect(APP_BUNDLE_FORMAT).toBe('snug-app-bundle/1');
    expect(APP_BUNDLE_MAX_BYTES).toBe(1024 * 1024);
    expect(APP_BUNDLE_MAX_HTML_CHARS).toBe(768 * 1024);
    expect(APP_BUNDLE_MAX_DOCS).toBe(16);
    expect(APP_BUNDLE_MAX_DOC_CONTENT_CHARS).toBe(128 * 1024);
    expect(APP_BUNDLE_MAX_DDL_STATEMENTS).toBe(64);
    expect(APP_BUNDLE_DOC_SLUG_RULE.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
    expect(APP_BUNDLE_LINEAGE_RULE.source).toBe('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  });

  it('rejects a missing or foreign format', () => {
    const { format: _dropped, ...noFormat } = minimal;
    expect(parses(noFormat)).toBe(false);
    expect(parses({ ...minimal, format: 'snug-app-bundle/2' })).toBe(false);
    expect(parses({ ...minimal, format: 'SNUG-APP-BUNDLE/1' })).toBe(false);
  });

  it('is strict throughout — an unknown key anywhere is a rejection, not a passthrough', () => {
    expect(parses({ ...minimal, sneaky: true })).toBe(false);
    expect(parses({ ...minimal, app: { ...minimal.app, installSource: 'starter:ledger' } })).toBe(false);
    expect(parses({ ...full, docs: [{ slug: 'vision', content: 'x', html: '<b>' }] })).toBe(false);
    expect(parses({ ...full, schema: { ddl: [], rows: [] } })).toBe(false);
    expect(parses({ ...full, producer: { hubVersion: '1', userEmail: 'a@b' } })).toBe(false);
  });

  it('never carries an identity field — bundleId is computed by the receiver (finding 14)', () => {
    expect(parses({ ...minimal, bundleId: 'abc' })).toBe(false);
  });
});

describe('appBundleSchema — app identity bounds (the frames LIMITS, reused)', () => {
  it('bounds displayName/description/iconEmoji/iconColor', () => {
    expect(parses({ ...minimal, app: { ...minimal.app, displayName: '' } })).toBe(false);
    expect(parses({ ...minimal, app: { ...minimal.app, displayName: 'x'.repeat(81) } })).toBe(false);
    expect(parses({ ...minimal, app: { ...minimal.app, description: 'x'.repeat(401) } })).toBe(false);
    expect(parses({ ...minimal, app: { ...minimal.app, iconEmoji: 'x'.repeat(9) } })).toBe(false);
    expect(parses({ ...minimal, app: { ...minimal.app, iconColor: 'x'.repeat(33) } })).toBe(false);
    expect(parses({ ...minimal, app: { displayName: 'ok' } })).toBe(false); // usesDb is required
  });
});

describe('appBundleSchema — lineage (finding 9: a bundle can never spell a starter identity)', () => {
  it('accepts a lowercase UUID only', () => {
    expect(parses({ ...minimal, lineage: LINEAGE.toUpperCase() })).toBe(false);
    expect(parses({ ...minimal, lineage: 'starter:ledger' })).toBe(false);
    expect(parses({ ...minimal, lineage: 'share:x' })).toBe(false);
    expect(parses({ ...minimal, lineage: '' })).toBe(false);
    expect(parses({ ...minimal, lineage: `${LINEAGE}:x` })).toBe(false);
  });
});

describe('appBundleSchema — html, docs, schema bounds', () => {
  it('bounds the html', () => {
    expect(parses({ ...minimal, html: '' })).toBe(false);
    expect(parses({ ...minimal, html: 'x'.repeat(APP_BUNDLE_MAX_HTML_CHARS + 1) })).toBe(false);
  });

  it('bounds docs by count, slug charset, and content size', () => {
    const doc = (i: number) => ({ slug: `doc-${i}`, content: 'x' });
    expect(parses({ ...minimal, docs: Array.from({ length: APP_BUNDLE_MAX_DOCS }, (_, i) => doc(i)) })).toBe(true);
    expect(parses({ ...minimal, docs: Array.from({ length: APP_BUNDLE_MAX_DOCS + 1 }, (_, i) => doc(i)) })).toBe(false);
    expect(parses({ ...minimal, docs: [{ slug: 'Vision', content: 'x' }] })).toBe(false);
    expect(parses({ ...minimal, docs: [{ slug: '../etc', content: 'x' }] })).toBe(false);
    expect(parses({ ...minimal, docs: [{ slug: 'v', content: '' }] })).toBe(false);
    expect(parses({ ...minimal, docs: [{ slug: 'v', content: 'x'.repeat(APP_BUNDLE_MAX_DOC_CONTENT_CHARS + 1) }] })).toBe(
      false,
    );
    expect(parses({ ...minimal, docs: [{ slug: 'v', title: 'x'.repeat(201), content: 'x' }] })).toBe(false);
  });

  it('rejects duplicate doc slugs', () => {
    expect(
      parses({ ...minimal, docs: [{ slug: 'vision', content: 'a' }, { slug: 'vision', content: 'b' }] }),
    ).toBe(false);
  });

  it('admits ONLY CREATE statements as schema DDL — structure travels, rows never (finding 7)', () => {
    const ok = [
      'CREATE TABLE t (id INTEGER)',
      'create table if not exists t (id integer)',
      'CREATE UNIQUE INDEX ix ON t(id)',
      'CREATE VIEW v AS SELECT 1',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END',
      'CREATE VIRTUAL TABLE ft USING fts5(body)',
      '  CREATE TABLE padded (id INTEGER)',
    ];
    for (const ddl of ok) expect(parses({ ...minimal, schema: { ddl: [ddl] } }), ddl).toBe(true);
    const bad = [
      "INSERT INTO t VALUES (1)",
      'DROP TABLE t',
      'ATTACH DATABASE x AS y',
      'PRAGMA writable_schema = 1',
      'CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1)',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; INSERT INTO t VALUES (1); -- END',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; INSERT INTO t VALUES (1); /* END */',
      'CREATEX TABLE t (id INTEGER)',
      '',
    ];
    for (const ddl of bad) expect(parses({ ...minimal, schema: { ddl: [ddl] } }), ddl).toBe(false);
    expect(APP_BUNDLE_DDL_STATEMENT_RULE.flags).toContain('i');
    expect(isStructureOnlyDdl('CREATE TABLE t (id INTEGER);')).toBe(true);
  });

  it('bounds the DDL list', () => {
    const many = Array.from({ length: APP_BUNDLE_MAX_DDL_STATEMENTS + 1 }, (_, i) => `CREATE TABLE t${i} (id INTEGER)`);
    expect(parses({ ...minimal, schema: { ddl: many } })).toBe(false);
    expect(parses({ ...minimal, schema: { ddl: many.slice(0, APP_BUNDLE_MAX_DDL_STATEMENTS) } })).toBe(true);
  });

  it('validates the contract with the real runtimeContractSchema', () => {
    expect(parses({ ...minimal, contract: { overview: '' } })).toBe(false);
    expect(parses({ ...minimal, contract: { overview: 'ok', sneaky: 1 } })).toBe(false);
  });
});

describe('appBundleSchema — connections (the untrusted declaration channel, ADR-0016 clause 6)', () => {
  it('validates every requirement with connectionRequirementSchema', () => {
    expect(parses({ ...minimal, connections: [{ ...requirement, declaredApiHosts: [] }] })).toBe(false);
    expect(parses({ ...minimal, connections: [{ slot: 'x' }] })).toBe(false);
  });

  it('refuses a userLayer on any connection — that seat is registry-synthesized only', () => {
    const withUserLayer = {
      ...requirement,
      kind: 'oauth2_auth_code',
      fields: undefined,
      endpoints: { authorizeUrl: 'https://a.example/auth', tokenUrl: 'https://a.example/token' },
      userLayer: {
        kind: 'oauth2_auth_code',
        provider: { name: 'X' },
        endpoints: { authorizeUrl: 'https://a.example/auth', tokenUrl: 'https://a.example/token' },
        scopes: [],
        apiHosts: ['a.example'],
      },
    };
    const result = appBundleSchema.safeParse({ ...minimal, connections: [withUserLayer] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.').includes('userLayer'))).toBe(true);
    }
  });

  it('caps connections at AUTH_MAX_SLOTS_PER_APP and refuses duplicate slots', () => {
    const many = Array.from({ length: AUTH_MAX_SLOTS_PER_APP + 1 }, (_, i) => ({ ...requirement, slot: `s${i}` }));
    expect(parses({ ...minimal, connections: many })).toBe(false);
    expect(parses({ ...minimal, connections: many.slice(0, AUTH_MAX_SLOTS_PER_APP) })).toBe(true);
    expect(parses({ ...minimal, connections: [requirement, requirement] })).toBe(false);
  });
});

describe('appBundleSchema — the whole-bundle byte cap', () => {
  it('refuses a bundle whose serialized form exceeds APP_BUNDLE_MAX_BYTES', () => {
    const docs = Array.from({ length: 9 }, (_, i) => ({ slug: `d${i}`, content: 'x'.repeat(APP_BUNDLE_MAX_DOC_CONTENT_CHARS) }));
    expect(JSON.stringify({ ...minimal, docs }).length).toBeGreaterThan(APP_BUNDLE_MAX_BYTES);
    expect(parses({ ...minimal, docs })).toBe(false);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // 3 bytes per char: 400k chars ≈ 1.2 MB of bytes while only 400k code units.
    const html = '€'.repeat(400_000);
    expect(html.length).toBeLessThan(APP_BUNDLE_MAX_HTML_CHARS);
    expect(parses({ ...minimal, html })).toBe(false);
  });
});

describe('parseAppBundle — the boundary reader', () => {
  it('returns the parsed bundle for valid JSON text and a named failure otherwise', () => {
    expect(parseAppBundle(JSON.stringify(full)).ok).toBe(true);
    const notJson = parseAppBundle('not json');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toBe('not-json');
    const notBundle = parseAppBundle(JSON.stringify({ hello: 1 }));
    expect(notBundle.ok).toBe(false);
    if (!notBundle.ok) expect(notBundle.reason).toBe('not-a-bundle');
    const invalid = parseAppBundle(JSON.stringify({ ...full, html: '' }));
    expect(invalid.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok && invalid.reason === 'invalid') expect(invalid.issues.length).toBeGreaterThan(0);
    else expect.fail('expected an invalid-bundle result');
  });

  it('accepts a leading UTF-8 BOM and surrounding whitespace (a file that travelled through mail clients)', () => {
    expect(parseAppBundle(`﻿  ${JSON.stringify(minimal)}\n`).ok).toBe(true);
  });

  it('refuses text over the byte cap BEFORE parsing it', () => {
    const huge = `{"format":"${APP_BUNDLE_FORMAT}","pad":"${'x'.repeat(APP_BUNDLE_MAX_BYTES)}"}`;
    const result = parseAppBundle(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-large');
  });
});

describe('appBundleId — content identity, receiver-computed', () => {
  it('is a 64-hex sha-256 over the canonical (key-sorted) JSON, stable across key order', async () => {
    const a = await appBundleId(appBundleSchema.parse(full));
    const { connections, html, ...rest } = full;
    const reordered: unknown = JSON.parse(JSON.stringify({ connections, html, ...rest }));
    const b = await appBundleId(appBundleSchema.parse(reordered));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('changes when any content changes, including a doc-only change (lesson 2026-08-21)', async () => {
    const a = await appBundleId(appBundleSchema.parse(full));
    const docsOnly = { ...full, docs: [{ slug: 'vision', title: 'Vision', content: '# Vision\n\nA better wall.' }] };
    expect(await appBundleId(appBundleSchema.parse(docsOnly))).not.toBe(a);
  });

  it('canonical JSON preserves array order (docs and DDL are ordered content)', () => {
    const canon = canonicalAppBundleJson(appBundleSchema.parse(full));
    expect(canon.indexOf('"vision"')).toBeLessThan(canon.indexOf('"build-prompt"'));
    expect(canon.indexOf('CREATE TABLE')).toBeLessThan(canon.indexOf('CREATE INDEX'));
  });
});

describe('publication line', () => {
  it('the app-bundle schema is OUT of the published json-schemas SOURCES (internal draft)', () => {
    const names = Object.keys(buildJsonSchemas());
    expect(names.some((name) => /bundle/i.test(name))).toBe(false);
  });

  it('CONNECTION_PROVENANCES gained shared (no schema-version bump — a write-time enum widening)', () => {
    expect(CONNECTION_PROVENANCES).toContain('shared');
  });
});
