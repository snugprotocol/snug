// localRefusal.test.tsx — the three pages the runner's page shows instead of the hub say only
// things a person can act on. The `no-token` page once told the user to "run `snug-mcp open`
// in a terminal": no such command exists (the human CLI is the plugin's `scripts/snug`, at a
// path this page cannot know), and the backticks rendered as literal characters
// (TASK-20261003 Phase 4 verifier).

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocalRefusal, type LocalRefusalProps } from '../local/LocalRefusal.js';

const KINDS: LocalRefusalProps['kind'][] = ['no-token', 'held', 'stopped', 'not-answering'];

const textOf = (kind: LocalRefusalProps['kind']): string => renderToStaticMarkup(<LocalRefusal kind={kind} />).replace(/<[^>]+>/g, ' ');

describe('LocalRefusal — every refusal names a step that exists', () => {
  it.each(KINDS)('%s: no command this page cannot vouch for, and no markdown rendered as text', (kind) => {
    const text = textOf(kind);
    expect(text).not.toMatch(/snug-mcp/);
    expect(text).not.toContain('`');
  });

  it('no-token: the way back is the agent — the runner hands the page a fresh key', () => {
    const text = textOf('no-token');
    expect(text).toContain('Open Snug from your agent');
    expect(text).toMatch(/ask your agent to open Snug/i);
  });

  it('not-answering: says the runner did not answer, that reloading is the step — and that nothing was written meanwhile', () => {
    // Gate 5 security/F5: a page that holds a launch key and gets no answer from /status
    // stops HERE instead of opening on browser storage. Reloading re-asks with the same key.
    const text = textOf('not-answering');
    expect(text).toContain('The Snug runner is not answering');
    expect(text).toMatch(/reload this page/i);
    expect(text).toMatch(/nothing has been opened or saved/i);
  });
});
