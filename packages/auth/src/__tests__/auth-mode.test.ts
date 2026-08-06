// AL-02 D7: IProject's pure auth-mode resolution helper, re-seated on opaque appId
// (branded tenant/user types dropped). two_layer runtime resolution stays DEFERRED —
// the typed code is the contract AL-03 branches on.
import { describe, expect, it } from 'vitest';
import { TWO_LAYER_RESOLUTION_DEFERRED, resolveAuthMode } from '../auth-mode.js';

describe('resolveAuthMode (pure decision matrix)', () => {
  it('per_user reads the caller-keyed user row', () => {
    expect(resolveAuthMode('per_user', { appId: 'app-1' })).toEqual({
      kind: 'read',
      layer: 'user',
      appId: 'app-1',
    });
  });

  it('global reads the shared org row', () => {
    expect(resolveAuthMode('global', { appId: 'app-1' })).toEqual({
      kind: 'read',
      layer: 'org',
      appId: 'app-1',
    });
  });

  it('two_layer defers with the typed code (no read happens)', () => {
    const resolution = resolveAuthMode('two_layer', { appId: 'app-1' });
    expect(resolution).toEqual({ kind: 'deferred', code: TWO_LAYER_RESOLUTION_DEFERRED });
    expect(TWO_LAYER_RESOLUTION_DEFERRED).toBe('TWO_LAYER_RESOLUTION_DEFERRED');
  });
});
