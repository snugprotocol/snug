// The run view's either/or breakpoint lives in TWO files that cannot import each
// other — RunView's matchMedia query and app.css's media block — and a drift
// between them is a silent split-screen regression on exactly the devices the
// band exists for (phone landscape, tablet portrait). CSS cannot import TS, so
// the byte-compare IS the single-homing (the releaseChannel/tauri.conf precedent).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BREAKPOINT = '(max-width: 1000px)';

function src(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relative), 'utf8');
}

describe('run-view either/or breakpoint lockstep', () => {
  it("RunView's isMobile query is the shared breakpoint", () => {
    expect(src('run/RunView.tsx')).toContain(`useMediaQuery('${BREAKPOINT}')`);
  });

  it('app.css carries the swap rules under the SAME breakpoint', () => {
    const css = src('theme/app.css');
    const blockStart = css.indexOf(`@media ${BREAKPOINT}`);
    expect(blockStart, `app.css must have a @media ${BREAKPOINT} block`).toBeGreaterThan(-1);
    const block = css.slice(blockStart);
    expect(block).toContain('.run-layout.is-mobile-think .frame-wrap');
    expect(block).toContain('.mobile-think');
  });

  it('the swap rules do NOT also live in the 760px shell block (one home)', () => {
    const css = src('theme/app.css');
    const shellBlock = css.slice(css.indexOf('@media (max-width: 760px)'), css.indexOf(`@media ${BREAKPOINT}`));
    expect(shellBlock).not.toContain('.is-mobile-think .frame-wrap {');
    expect(shellBlock).not.toContain('.mobile-think {');
  });
});
