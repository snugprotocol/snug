// TASK-20260816-whatsapp-twin Phase D (ADR-0032): the sidecar seam's IDENTITY, asserted from
// the integrating side.
//
// WHY THIS FILE EXISTS. lessons.md (2026-08-13): "When a lane spans two packages, assert the
// seam's IDENTITY from the integrating side (`platform.lanFetch toBe lanFetch`) and mutate
// the seam — deleting the wiring left both packages' suites green, TWICE, by construction:
// one owns the implementation, the other owns a stub, nothing owns the wire."
//
// That is exactly this seam's shape. `apps/desktop` owns `sidecarCtl`/`sidecarFetch`; the
// playground owns `canLinkDevice` and the device-link flow, and its tests inject their own
// fake platform. So both suites can pass with the wire cut — the playground never sees the
// real implementation, and the desktop package never exercises the consumer. The only thing
// that can catch a deleted `sidecarCtl,` line in `platform-desktop.ts` is an assertion here
// that the object the shell publishes carries the very functions this package exports.
//
// The COMMAND-NAME half of this wire (do the wrappers invoke names lib.rs registers?) lives
// in `sidecarContract.test.ts`, which already runs under the node environment it needs to
// read source files — jsdom rewrites `import.meta.url` so `fileURLToPath` refuses.

import { describe, expect, it, vi } from 'vitest';

// The Tauri core module is not loadable outside a shell; the seam under test is the wiring,
// not the IPC call, so the transport is stubbed and the identity is what gets asserted.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({})) }));

describe('the desktop platform publishes the sidecar seats', () => {
  it('threads the SAME sidecarCtl and sidecarFetch this package exports', async () => {
    // Reference identity, deliberately: a structural check ("is a function") would pass
    // against a stub, a stale copy, or a lambda that swallows its arguments — all three of
    // which are what a broken wire actually looks like.
    const { sidecarCtl, sidecarFetch } = await import('../sidecar.js');
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.sidecarCtl, 'platform.sidecarCtl must BE this package’s sidecarCtl').toBe(sidecarCtl);
    expect(platform.sidecarFetch, 'platform.sidecarFetch must BE this package’s sidecarFetch').toBe(sidecarFetch);
  });

  it('threads BOTH seats, because the consumer requires both before offering the flow', async () => {
    // `canLinkDevice` is an AND over the two seats. A platform carrying one would report
    // "cannot link" and disclose a desktop-only wall on the desktop — a failure mode that
    // looks like a product decision rather than a missing wire.
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.sidecarCtl).toBeDefined();
    expect(platform.sidecarFetch).toBeDefined();
  });

});
