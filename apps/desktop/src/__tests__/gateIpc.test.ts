// The IPC enforcement verdict (whole-surface review finding 2).
//
// The old `ipc-invoke-refused` sensor lived in the sandboxed subframe — a frame
// Tauri's response path can never reach — so it could not fire whether or not the
// keyless invoke executed, and the check passed unconditionally. The verdict now
// comes from an effect observed at a boundary Tauri DOES touch: the main frame asks
// Rust whether the subframe's keyless `write_user_file` left its sentinel in ~/Snug.
//
// These tests pin the property that made the rework necessary: every "cannot tell"
// input must FAIL. An unanswerable sensor is the defect, not a pass.

import { describe, expect, it } from 'vitest';

import { decideInvokeRefused, SENTINEL_NAME } from '../gate/ipc.js';

const reachable = { transports: ['webkit.messageHandlers.ipc'], callbackFired: false };

describe('decideInvokeRefused — the sentinel is the sensor', () => {
  it('FAILS when the sentinel exists: the keyless invoke executed a write command', () => {
    const result = decideInvokeRefused(reachable, { exists: true });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('EXECUTED');
    expect(result.detail).toContain(SENTINEL_NAME);
    expect(result.detail, 'the Electron-fallback trigger must be named').toContain('STRUCTURAL BREAKAGE');
  });

  it('PASSES when a transport was reachable but left no sentinel — key-gated refusal', () => {
    const result = decideInvokeRefused(reachable, { exists: false });
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('webkit.messageHandlers.ipc');
    expect(result.detail).toContain('NO sentinel');
  });

  it('PASSES when no raw transport was reachable at all', () => {
    const result = decideInvokeRefused({ transports: [], callbackFired: false }, { exists: false });
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('no raw IPC transport reachable');
  });

  it('FAILS when the sentinel probe itself is unavailable — never vouches on a dead sensor', () => {
    const result = decideInvokeRefused(reachable, { error: 'command not found' });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('cannot vouch');
  });

  it('FAILS when the sandboxed probe never reported — no invoke was even attempted', () => {
    const result = decideInvokeRefused(undefined, { exists: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('never reported');
  });

  it('FAILS when a callback resolved into the subframe, even with no sentinel', () => {
    const result = decideInvokeRefused({ ...reachable, callbackFired: true }, { exists: false });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('resolved a callback into the subframe');
  });

  it('the sentinel name matches the one gate.rs answers for', () => {
    // A drift makes the Rust probe reject the name, which surfaces as the
    // "unavailable" FAIL above rather than a silent pass — but pin it anyway.
    expect(SENTINEL_NAME).toBe('ipc-probe-canary.sqlite');
  });
});
