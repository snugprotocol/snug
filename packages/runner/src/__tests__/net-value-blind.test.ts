// AL-03 amendment R4 — the runner value-blindness guard, as an EXECUTABLE lint (not
// prose): the runner ROUTES net-request frames to the injected NetHandler and never
// calls fetch nor imports the connected-fetch executor, exactly like the db seam routes
// to DbDriver and never opens sql.js. A credential value cannot pass through a package
// that never sees one. The whole package is scanned so a helper file can't slip a fetch
// in either. C2's iframe-cannot-fetch proof is separate (browser-csp.spec.template.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCESS_MAX_PARAMS,
  ACCESS_PARAM_STRING_MAX_CHARS,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  accessRequestSchema,
  accessResponseSchema,
  frameWithinLimits,
  type AccessRequestFrame,
  type AccessResponseFrame,
} from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

const srcDir = join(__dirname, '..');

function shippedSources(dir = srcDir): Array<{ path: string; name: string; text: string }> {
  const out: Array<{ path: string; name: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...shippedSources(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) out.push({ path, name, text: readFileSync(path, 'utf8') });
  }
  return out;
}

describe('R4 — the runner is value-blind (it routes net frames, it does not fetch)', () => {
  const sources = shippedSources();

  it('collects the shipped runner sources (host.ts among them)', () => {
    expect(sources.some((s) => s.name === 'host.ts')).toBe(true);
    expect(sources.some((s) => s.name === 'transport.ts')).toBe(true);
  });

  // browser-csp.spec.template.ts is DATA, not runner code: a string of app-side JS
  // shipped to the Playwright CSP harness that deliberately TRIES to fetch/open a
  // WebSocket/sendBeacon from inside the sandbox to prove C2 blocks it. It never runs
  // in the host. Excluded from the network-channel scan (its whole point is those
  // channels); still covered by the executor-import and credential-value scans below.
  const runnerCode = (name: string): boolean => name !== 'browser-csp.spec.template.ts';

  it('no shipped runner source (excluding the CSP probe data) opens a network channel', () => {
    for (const { path, name, text } of sources) {
      if (!runnerCode(name)) continue;
      const stripped = stripCommentsAndStrings(text);
      expect(/\bfetch\s*\(/.test(stripped), `${path} calls fetch`).toBe(false);
      expect(/\bfetchImpl\b/.test(stripped), `${path} references a fetch impl`).toBe(false);
      expect(/\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b/.test(stripped), `${path} opens a network channel`).toBe(false);
    }
  });

  it('no shipped runner source imports the connected-fetch executor or the auth package', () => {
    for (const { path, text } of sources) {
      expect(/from\s+['"][^'"]*connected-fetch/.test(text), `${path} imports connected-fetch`).toBe(false);
      expect(/from\s+['"]@snugprotocol\/auth['"]/.test(text), `${path} imports @snugprotocol/auth`).toBe(false);
    }
  });

  it('no shipped runner source reads a credential-shaped identifier (host stays value-blind)', () => {
    const credentialShape = /\b(getCredential|credentialStore|accessToken|refreshToken|clientSecret|Authorization\s*:)\b/;
    for (const { path, text } of sources) {
      const stripped = stripCommentsAndStrings(text);
      const match = credentialShape.exec(stripped);
      expect(match, `${path} touches a credential value: ${match?.[0]}`).toBeNull();
    }
  });

  it("package.json declares no dependency on @snugprotocol/auth", () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@snugprotocol/auth');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@snugprotocol/auth');
  });
});

// TASK-20261010-cross-app-access AC4 (C1/C2 negative) — the runner ROUTES access-request
// frames to the injected AccessHandler and never runs a read itself: the scoped-read
// engine (sql.js in a dedicated Worker, ADR-0075 D10) lives in apps/playground. A runner
// that imported the storage package, sql.js, constructed a Worker or reached into the
// access engine could see another app's rows — so, like the fetch rule above, it is an
// executable lint over every shipped source, not prose.
describe('AC4 — the runner stays value-blind for access between apps (it routes, it never reads)', () => {
  const sources = shippedSources();

  it('no shipped runner source imports @snugprotocol/db or sql.js (static, dynamic or require)', () => {
    for (const { path, text } of sources) {
      for (const specifier of importSpecifiers(text)) {
        expect(/^@snugprotocol\/db(\/|$)/.test(specifier), `${path} imports ${specifier}`).toBe(false);
        expect(/^sql\.js(\/|$)/.test(specifier), `${path} imports ${specifier}`).toBe(false);
      }
    }
  });

  it('no shipped runner source constructs a Worker (the read engine owns the only one)', () => {
    for (const { path, text } of sources) {
      const stripped = stripCommentsAndStrings(text);
      expect(/\bnew\s+(?:Shared)?Worker\s*\(/.test(stripped), `${path} constructs a Worker`).toBe(false);
    }
  });

  it('no shipped runner source imports the access engine (scopedRead / accessHandler / an access/ module)', () => {
    for (const { path, text } of sources) {
      for (const specifier of importSpecifiers(text)) {
        expect(/scopedRead|accessHandler|(?:^|\/)access\//.test(specifier), `${path} imports ${specifier}`).toBe(false);
      }
    }
  });

  it('package.json declares no dependency on @snugprotocol/db or sql.js', () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    expect(declared).not.toContain('@snugprotocol/db');
    expect(declared).not.toContain('sql.js');
  });

  // The lint must be able to FAIL (a scan that matches nothing proves nothing): the same
  // predicates, run over planted lines, catch each forbidden shape.
  it('the import and Worker predicates catch planted violations (the lint can fail)', () => {
    const planted = [
      "import { openUserDb } from '@snugprotocol/db';",
      "const SQL = await import('sql.js');",
      "const m = require('sql.js/dist/sql-wasm.js');",
      "import { scopedScratchRead } from '../../apps/playground/src/access/scopedRead.js';",
      "import { createAccessHandlerFor } from './accessHandler.js';",
      "import './access/engine.js';",
    ];
    const specifiers = planted.flatMap((line) => importSpecifiers(line));
    expect(specifiers).toHaveLength(planted.length);
    expect(specifiers.filter((s) => /^@snugprotocol\/db(\/|$)|^sql\.js(\/|$)|scopedRead|accessHandler|(?:^|\/)access\//.test(s))).toHaveLength(planted.length);
    expect(/\bnew\s+(?:Shared)?Worker\s*\(/.test(stripCommentsAndStrings('const w = new Worker(url);'))).toBe(true);
    // ...and the protocol import every runner file legitimately makes is NOT caught.
    expect(importSpecifiers("import { accessRequestSchema } from '@snugprotocol/protocol';").filter((s) => /scopedRead|accessHandler|(?:^|\/)access\//.test(s))).toEqual([]);
  });
});

/**
 * From the runner side: the access pair rides the DEFAULT frame class (LIMITS.MAX_FRAME_BYTES,
 * 256 KiB) in BOTH directions — not the db class (8 MiB) nor the net class. A frame exactly at
 * the cap passes `frameWithinLimits`; one byte more fails. The frames built here are
 * schema-valid, so the pin is about real frames, not padding the parser would refuse.
 */
describe('AC4 — the access pair rides MAX_FRAME_BYTES in frameWithinLimits', () => {
  const bytes = (frame: unknown): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;

  /** A schema-valid query request of EXACTLY `target` UTF-8 bytes (ASCII params + sql tuning). */
  function accessRequestOfSize(target: number): AccessRequestFrame {
    const build = (sql: string, params: string[]): AccessRequestFrame => ({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessRequest,
      requestId: 'req-1',
      instanceId: 'ins-1',
      op: 'query',
      grantId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      sql,
      params,
    });
    const full = 'p'.repeat(ACCESS_PARAM_STRING_MAX_CHARS);
    const params: string[] = [];
    while (params.length < ACCESS_MAX_PARAMS && bytes(build('S', [...params, full])) <= target) params.push(full);
    let gap = target - bytes(build('S', params));
    let sql = 'S';
    if (gap >= 3 && params.length < ACCESS_MAX_PARAMS) {
      params.push('');
      gap = target - bytes(build(sql, params));
      params[params.length - 1] = 'p'.repeat(gap);
    } else {
      sql = 'S'.repeat(1 + gap);
    }
    return build(sql, params);
  }

  /** A query response of EXACTLY `target` UTF-8 bytes (one ASCII cell). */
  function accessResponseOfSize(target: number): AccessResponseFrame {
    const build = (cell: string): AccessResponseFrame => ({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'req-1',
      ok: true,
      op: 'query',
      columns: ['note'],
      rows: [[cell]],
    });
    return build('y'.repeat(target - bytes(build(''))));
  }

  it('an access-REQUEST at MAX_FRAME_BYTES passes; at MAX_FRAME_BYTES + 1 it fails', () => {
    const atCap = accessRequestOfSize(LIMITS.MAX_FRAME_BYTES);
    const over = accessRequestOfSize(LIMITS.MAX_FRAME_BYTES + 1);
    expect(bytes(atCap)).toBe(LIMITS.MAX_FRAME_BYTES);
    expect(bytes(over)).toBe(LIMITS.MAX_FRAME_BYTES + 1);
    expect(accessRequestSchema.safeParse(atCap).success).toBe(true);
    expect(accessRequestSchema.safeParse(over).success).toBe(true);
    expect(frameWithinLimits(atCap)).toBe(true);
    expect(frameWithinLimits(over)).toBe(false);
  });

  it('an access-RESPONSE at MAX_FRAME_BYTES passes; at MAX_FRAME_BYTES + 1 it fails', () => {
    const atCap = accessResponseOfSize(LIMITS.MAX_FRAME_BYTES);
    const over = accessResponseOfSize(LIMITS.MAX_FRAME_BYTES + 1);
    expect(bytes(atCap)).toBe(LIMITS.MAX_FRAME_BYTES);
    expect(bytes(over)).toBe(LIMITS.MAX_FRAME_BYTES + 1);
    expect(accessResponseSchema.safeParse(atCap).success).toBe(true);
    expect(accessResponseSchema.safeParse(over).success).toBe(true);
    expect(frameWithinLimits(atCap)).toBe(true);
    expect(frameWithinLimits(over)).toBe(false);
  });

  it('the access class is the DEFAULT class, smaller than the db and net classes it must never borrow', () => {
    expect(LIMITS.MAX_FRAME_BYTES).toBeLessThan(LIMITS.MAX_DB_FRAME_BYTES);
    expect(LIMITS.MAX_FRAME_BYTES).toBeLessThan(LIMITS.MAX_NET_FRAME_BYTES);
    // Twin: a db-response of the same over-cap size still passes in ITS class.
    const dbFrame = { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbResponse, requestId: 'req-1', ok: true as const, rows: [['y'.repeat(LIMITS.MAX_FRAME_BYTES)]] };
    expect(frameWithinLimits(dbFrame)).toBe(true);
  });
});

/** Every module specifier a source names: static `from`, side-effect `import '…'`, `import(…)`, `require(…)`. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Cheap comment/string stripper so the lint scans CODE, not doc prose or literals. */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}
