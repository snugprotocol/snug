// hostEnvironment.test.ts — TASK-20260905-host-kit: a feedback report from the kit names the
// kit and its binding, never "web", and never the file's mode (the host pins the brain).
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

describe('reportEnvironment', () => {
  it('host: names the kit, its binding and the pinned brain', async () => {
    vi.resetModules();
    const platform = await import('../platform/platform.js');
    platform.setPlatform({
      kind: 'host',
      binding: 'artifact',
      brain: { kind: 'demo' },
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, hubAuth: false, brainSettings: false, account: false, sync: false, connections: false, share: false },
    });
    const { reportEnvironment } = await import('../feedback/environment.js');
    const line = reportEnvironment();
    expect(line.startsWith('host kit (artifact) / ')).toBe(true);
    expect(line.endsWith(' / brain pinned by the host')).toBe(true);
  });

  it('web (positive twin): "web / <ua> / <mode>" as before', async () => {
    vi.resetModules();
    const { reportEnvironment } = await import('../feedback/environment.js');
    expect(reportEnvironment().startsWith('web / ')).toBe(true);
  });
});
