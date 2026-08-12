// downloadBlob platform routing (TASK-20260812 W2b item 6). When the platform offers
// a native save dialog (`saveFile`), the bytes go through it — no anchor, no object
// URL; the web default keeps the anchor download byte-for-byte (AC10).
//
// Platform is set-once, so each case takes a fresh module registry.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

async function fresh(platform?: SnugPlatform): Promise<typeof import('../run/exportDb.js')> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  return import('../run/exportDb.js');
}

// jsdom ships no object-URL implementation — install observable stubs.
const createObjectURL = vi.fn(() => 'blob:test');
const revokeObjectURL = vi.fn();
Object.assign(URL, { createObjectURL, revokeObjectURL });

afterEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.restoreAllMocks();
});

describe('downloadBlob — platform saveFile routing', () => {
  it('routes the bytes through platform.saveFile with the caller filename; no anchor path', async () => {
    const saved: Array<{ bytes: Uint8Array; name: string }> = [];
    const exportDb = await fresh({
      kind: 'desktop',
      saveFile: (bytes, suggestedName) => {
        saved.push({ bytes, name: suggestedName });
        return Promise.resolve();
      },
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    });

    exportDb.downloadBlob(new Blob([new TextEncoder().encode('hello-bytes')]), 'snug-user.snug');

    await vi.waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(new TextDecoder().decode(saved[0]!.bytes)).toBe('hello-bytes');
    expect(saved[0]!.name).toBe('snug-user.snug');
    expect(createObjectURL, 'the anchor path must not run when the platform saves').not.toHaveBeenCalled();
  });

  it('web default: anchor download with the given filename (AC10)', async () => {
    const exportDb = await fresh();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });

    exportDb.downloadBlob(new Blob(['x']), 'file.sqlite');

    expect(clicked).toEqual(['file.sqlite']);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
