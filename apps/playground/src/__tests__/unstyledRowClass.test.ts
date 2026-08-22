// TASK-20260821-site-playground-polish AC6 — the `.row` class is banned.
//
// A className of "row" was used in 8 places (vault setup/unlock, wizard) while NO
// stylesheet defined `.row` — the divs rendered unstyled, so the password inputs and
// their "show" buttons collided. The intended layout existed the whole time as
// `.field-row`. This scan keeps the dead class from creeping back: a new `.row`
// would silently reproduce the same overlap.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('no unstyled row class', () => {
  it('the bare "row" className appears nowhere in playground source', () => {
    const src = join(process.cwd(), 'src');
    // Split literal so this file does not flag itself.
    const banned = `className="${'row'}"`;
    const offenders = walk(src).filter((file) => readFileSync(file, 'utf8').includes(banned));
    expect(offenders, 'use className="field-row" — .row has no CSS rule').toEqual([]);
  });
});
