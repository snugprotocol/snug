// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package is browser-safe (AC-8)', () => {
  it('src/ modules (excluding tests and the schema generator entrypoint) import no node builtins', () => {
    const srcDir = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/from\s+['"]node:|require\(['"]node:/.test(text)) offenders.push(entry.name);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('index imports and runs under a DOM environment', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.parseFrame).toBe('function');
    expect(typeof mod.parseAgentReply).toBe('function');
    expect(mod.SNUG_APP_REQUEST_TAG).toBe('[SNUG_APP_REQUEST]');
  });

  it('runtime dependency surface is zod only', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
  });
});
