// fixtures/hostPlatform.ts — the ONE host-platform fixture the playground's host-posture
// tests share (Gate-5 maintainability review, T4): the kit's capability table, the artifact
// binding, the demo brain, no backend. Pass overrides for the seat, brain or backend under test.
// Pure data — safe under `vi.resetModules()` (nothing here is module state).
import { hostCapabilities } from '../../platform/hostCapabilities.js';
import type { SnugPlatform } from '../../platform/platform.js';

/**
 * The kit's posture (T2 AC9) — the SAME table the kit and the runner compose from (K4), so a
 * test here can never run against a host shape no host has. Built once: tests read it and
 * spread it, none may mutate it.
 */
export const HOST_OFF_CAPABILITIES: NonNullable<SnugPlatform['capabilities']> = Object.freeze(hostCapabilities());

export function hostPlatform(overrides: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain: { kind: 'demo' },
    capabilities: HOST_OFF_CAPABILITIES,
    ...overrides,
  };
}
