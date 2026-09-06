// fixtures/hostPlatform.ts — the ONE host-platform fixture the playground's host-posture
// tests share (Gate-5 maintainability review, T4): every surface flag off, the artifact
// binding, the demo brain, no backend. Pass overrides for the seat, brain or backend under test.
// Pure data — safe under `vi.resetModules()` (nothing here is module state).
import type { SnugPlatform } from '../../platform/platform.js';

/** Every host surface flag off — the kit's posture (T2 AC9). */
export const HOST_OFF_CAPABILITIES: NonNullable<SnugPlatform['capabilities']> = {
  subscriptionMode: false,
  hubSyncOrigin: false,
  lanHttpPrivate: false,
  hubAuth: false,
  brainSettings: false,
  account: false,
  sync: false,
  connections: false,
  share: false,
};

export function hostPlatform(overrides: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain: { kind: 'demo' },
    capabilities: HOST_OFF_CAPABILITIES,
    ...overrides,
  };
}
