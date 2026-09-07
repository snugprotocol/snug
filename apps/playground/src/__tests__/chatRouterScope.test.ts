// chatRouterScope.test.ts — TASK-20260905-binding-a-artifacts AC1 (plan review F3): under
// a pinned HOST brain the builder's router classifier is skipped — the tool-free builder has
// no data lanes to route to, and every classifier call is a viewer-billed `sample` call. An
// app-attached message must cost exactly ONE call. The pure decision is pinned here; the
// hook reads it at the one call site.
import { describe, expect, it } from 'vitest';

import { classifierApplies } from '../agent/chatRouter.js';

describe('classifierApplies', () => {
  it('runs for every brain that is NOT the host’s, with an attached app on a direct turn — the rule is "skip under host", not "only settings"', () => {
    expect(classifierApplies({ brain: 'settings', contextTarget: 'app-1', serverTurn: false })).toBe(true);
    expect(classifierApplies({ brain: 'webllm', contextTarget: 'app-1', serverTurn: false })).toBe(true);
    expect(classifierApplies({ brain: 'demo', contextTarget: 'app-1', serverTurn: false })).toBe(true);
  });
  it('is skipped under the host brain (T4 AC1), and — as before — without a target or on a server turn', () => {
    expect(classifierApplies({ brain: 'host', contextTarget: 'app-1', serverTurn: false })).toBe(false);
    expect(classifierApplies({ brain: 'settings', contextTarget: undefined, serverTurn: false })).toBe(false);
    expect(classifierApplies({ brain: 'settings', contextTarget: 'app-1', serverTurn: true })).toBe(false);
  });
});
