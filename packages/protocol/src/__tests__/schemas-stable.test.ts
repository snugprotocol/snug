import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildJsonSchemas } from '../json-schemas.js';

const schemasDir = join(__dirname, '..', '..', 'schemas');

describe('JSON Schema export (AC-7)', () => {
  it('is deterministic: two generations are byte-identical', () => {
    const a = buildJsonSchemas();
    const b = buildJsonSchemas();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const key of Object.keys(a)) expect(a[key]).toBe(b[key]);
  });

  it('covers every frame plus the chat envelope', () => {
    const names = Object.keys(buildJsonSchemas());
    for (const expected of [
      'app-announce.json', 'host-ready.json', 'app-message.json', 'app-cancel.json',
      'app-response.json', 'db-request.json', 'db-response.json', 'host-event.json',
      'app-event.json', 'app-request-envelope.json',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('committed schemas/ files are in sync with the source of truth', () => {
    const generated = buildJsonSchemas();
    const committed = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
    expect(committed.sort()).toEqual(Object.keys(generated).sort());
    for (const file of committed) {
      expect(readFileSync(join(schemasDir, file), 'utf8'), `${file} drifted — run pnpm gen:schemas`).toBe(generated[file]);
    }
  });

  it('every schema is valid JSON with sorted keys and trailing newline', () => {
    for (const [name, text] of Object.entries(buildJsonSchemas())) {
      expect(text.endsWith('\n'), `${name} trailing newline`).toBe(true);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(typeof parsed).toBe('object');
      const topKeys = Object.keys(parsed);
      expect([...topKeys].sort()).toEqual(topKeys);
    }
  });
});
