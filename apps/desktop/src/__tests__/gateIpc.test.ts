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

import {
  decideInvokeRefused,
  decideLanFetchRefused,
  decideSidecarFetchRefused,
  IPC_CHECK_IDS,
  LAN_FETCH_COMMAND,
  SENTINEL_NAME,
  SIDECAR_FETCH_COMMAND,
} from '../gate/ipc.js';

const reachable = {
  transports: ['webkit.messageHandlers.ipc'],
  callbackFired: false,
  lanCallbackFired: false,
  sidecarCallbackFired: false,
};

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
    const result = decideInvokeRefused(
      { transports: [], callbackFired: false, lanCallbackFired: false, sidecarCallbackFired: false },
      { exists: false },
    );
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

// PER-COMMAND IPC unreachability for `lan_fetch` (P0 amendment 16).
//
// `ipc-invoke-refused` proves the BRIDGE is key-gated by driving one command.
// Registration is per-command, though — a command added to the wrong handler
// list is precisely the drift a family-level check cannot see — and `lan_fetch`
// is the command that most needs its own row: it is the shell's only outbound
// network capability carrying a relaxed trust decision, so an app iframe that
// reached it would get a transport that trusts a certificate on the user's own
// network.
//
// Same discipline as the sentinel rework: every "cannot tell" input FAILS.
describe('decideLanFetchRefused — lan_fetch specifically, not the command family', () => {
  it('FAILS when a keyless lan_fetch resolved a callback into the subframe', () => {
    const result = decideLanFetchRefused({ ...reachable, lanCallbackFired: true }, false);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain(LAN_FETCH_COMMAND);
    expect(result.detail, 'the Electron-fallback trigger must be named').toContain('STRUCTURAL BREAKAGE');
  });

  it('FAILS when the invoke key is reachable, even with no callback — it cannot vouch', () => {
    // The unanswerable-sensor rule: silence from a frame that HOLDS the key
    // proves nothing about dispatch.
    const result = decideLanFetchRefused(reachable, true);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('cannot vouch');
  });

  it('FAILS when the sandboxed probe never reported', () => {
    const result = decideLanFetchRefused(undefined, false);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('never reported');
  });

  it('PASSES only when no lan_fetch callback fired AND the key never reached the subframe', () => {
    const result = decideLanFetchRefused(reachable, false);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain(LAN_FETCH_COMMAND);
    expect(result.detail).toContain('key-gated per command');
  });

  it("a write_user_file refusal alone can never grant lan_fetch's verdict", () => {
    // THE POINT OF THE WHOLE CHECK. A report that would PASS
    // `decideInvokeRefused` (no sentinel, no write callback) must still FAIL
    // here when lan_fetch itself resolved — the two verdicts read different
    // callback slots and cannot borrow each other's evidence.
    const writeRefusedButLanReached = { ...reachable, callbackFired: false, lanCallbackFired: true };
    expect(decideInvokeRefused(writeRefusedButLanReached, { exists: false }).pass).toBe(true);
    expect(decideLanFetchRefused(writeRefusedButLanReached, false).pass).toBe(false);
  });

  it('the lan_fetch verdict is one of the REQUIRED check ids (a missing verdict is a fail)', () => {
    // runIpcChecks maps over IPC_CHECK_IDS and turns an absent verdict into a
    // no-verdict FAIL; being in this list is what makes the check mandatory
    // rather than advisory.
    expect(IPC_CHECK_IDS).toContain('ipc-lan-fetch-refused');
  });

  it('the command name matches the one lib.rs registers', () => {
    expect(LAN_FETCH_COMMAND).toBe('lan_fetch');
  });
});

describe('decideSidecarFetchRefused — sidecar_fetch specifically (ADR-0032)', () => {
  it('FAILS when a keyless sidecar_fetch resolved a callback into the subframe', () => {
    // Reaching this command from app code means reaching the process holding the
    // user's WhatsApp linked-device session — every thread readable, and sending
    // as them. Structural breakage, not a warning.
    const result = decideSidecarFetchRefused({ ...reachable, sidecarCallbackFired: true }, false);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/STRUCTURAL BREAKAGE/);
  });

  it('cannot vouch for refusal while the invoke key is reachable', () => {
    // The honest half: with the key present, "no callback" cannot distinguish a
    // refusal from a call whose answer went somewhere this frame cannot see.
    const result = decideSidecarFetchRefused(reachable, true);
    expect(result.pass).toBe(false);
  });

  it('FAILS when the probe never reported — an unanswerable sensor is not a pass', () => {
    expect(decideSidecarFetchRefused(undefined, false).pass).toBe(false);
  });

  it('passes only with no callback AND an unreachable key', () => {
    const result = decideSidecarFetchRefused(reachable, false);
    expect(result.pass).toBe(true);
  });

  it("a lan_fetch refusal alone can never grant sidecar_fetch's verdict", () => {
    // The amendment-16 discipline applied to the third command: registration is
    // per-command, so a command added to the wrong handler list is exactly the
    // drift a family-level check cannot see. Each verdict reads its OWN slot.
    const lanRefusedButSidecarReached = {
      ...reachable,
      lanCallbackFired: false,
      sidecarCallbackFired: true,
    };
    expect(decideLanFetchRefused(lanRefusedButSidecarReached, false).pass).toBe(true);
    expect(decideSidecarFetchRefused(lanRefusedButSidecarReached, false).pass).toBe(false);
  });

  it("a sidecar_fetch refusal alone can never grant lan_fetch's verdict", () => {
    const sidecarRefusedButLanReached = {
      ...reachable,
      lanCallbackFired: true,
      sidecarCallbackFired: false,
    };
    expect(decideSidecarFetchRefused(sidecarRefusedButLanReached, false).pass).toBe(true);
    expect(decideLanFetchRefused(sidecarRefusedButLanReached, false).pass).toBe(false);
  });

  it('the sidecar_fetch verdict is one of the REQUIRED check ids', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-sidecar-fetch-refused');
  });

  it('the command name matches the one lib.rs registers', () => {
    expect(SIDECAR_FETCH_COMMAND).toBe('sidecar_fetch');
  });
});
