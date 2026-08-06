// AL-03 amendment R4 — the runner value-blindness guard, as an EXECUTABLE lint (not
// prose): the runner ROUTES net-request frames to the injected NetHandler and never
// calls fetch nor imports the connected-fetch executor, exactly like the db seam routes
// to DbDriver and never opens sql.js. A credential value cannot pass through a package
// that never sees one. The whole package is scanned so a helper file can't slip a fetch
// in either. C2's iframe-cannot-fetch proof is separate (browser-csp.spec.template.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** Cheap comment/string stripper so the lint scans CODE, not doc prose or literals. */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}
