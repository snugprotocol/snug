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
  decideSidecarFetchDispatchable,
  decideSidecarFetchRefused,
  decideSidecarWizardFetchDispatchable,
  decideSidecarWizardFetchRefused,
  decideUpdateChannelCommandRefused,
  decideUpdaterCheckDispatchable,
  IPC_CHECK_IDS,
  LAN_FETCH_COMMAND,
  PROCESS_RELAUNCH_COMMAND,
  SENTINEL_NAME,
  SIDECAR_FETCH_COMMAND,
  SIDECAR_WIZARD_FETCH_COMMAND,
  UPDATER_CHECK_COMMAND,
  UPDATER_INSTALL_COMMAND,
  HELPER_INSTALL_COMMAND,
  HELPER_STATUS_COMMAND,
  decideHelperStatusDispatchable,
} from '../gate/ipc.js';

const reachable = {
  transports: ['webkit.messageHandlers.ipc'],
  callbackFired: false,
  lanCallbackFired: false,
  sidecarCallbackFired: false,
  sidecarWizardCallbackFired: false,
  updaterCheckCallbackFired: false,
  updaterInstallCallbackFired: false,
  relaunchCallbackFired: false,
  helperInstallCallbackFired: false,
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
      { ...reachable, transports: [] },
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

describe('decideSidecarFetchDispatchable — the POSITIVE twin (next-steps 2026-08-17 §1)', () => {
  // WHY THIS EXISTS: `ipc-sidecar-fetch-refused` PASSED while the command was
  // UNREGISTERED (eight-seam defect #1) — an unreachable-from-everywhere command
  // satisfies an unreachability check. So every negative IPC check wants a twin
  // proving the MAIN window can dispatch the command at all.

  it('passes when the invoke RESOLVES — the helper answered, so dispatch happened', () => {
    expect(decideSidecarFetchDispatchable({ resolved: true, detail: 'resolved' }).pass).toBe(true);
  });

  it('passes when the command BODY refuses (helper not running) — refusal proves dispatch', () => {
    const result = decideSidecarFetchDispatchable({
      resolved: false,
      detail: 'the WhatsApp helper is not running — open the connection settings to start it',
    });
    expect(result.pass).toBe(true);
  });

  it('FAILS on the unregistered-command shape — the exact defect this twin exists for', () => {
    for (const detail of [
      'Command sidecar_fetch not found',
      'sidecar_fetch not allowed. Command not found',
      'unknown command sidecar_fetch',
    ]) {
      expect(decideSidecarFetchDispatchable({ resolved: false, detail }).pass, detail).toBe(false);
    }
  });

  it('is one of the REQUIRED check ids — the derive-based driver expects it', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-sidecar-fetch-dispatchable');
  });
});

describe('decideSidecarWizardFetchRefused — sidecar_wizard_fetch (threat-model R-12)', () => {
  // WHY THIS ROW EXISTS: R-12 named this command as the standing exception — it
  // ships in BOTH handler lists (`lib.rs` debug and release) and fronts
  // `GET /pair/status`, the route that RELEASES the helper's access token, while
  // its LOWER-privilege sibling `sidecar_fetch` carried a per-command row and this
  // one did not. Reaching it from app code means minting the token that unlocks the
  // user's linked-device session — strictly worse than the sibling that was gated.
  // Amendment 16: registration is per-command, so only a per-command probe can see it.

  it('FAILS when a keyless sidecar_wizard_fetch resolved a callback into the subframe', () => {
    const result = decideSidecarWizardFetchRefused(
      { ...reachable, sidecarWizardCallbackFired: true },
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/STRUCTURAL BREAKAGE/);
  });

  it('cannot vouch for refusal while the invoke key is reachable', () => {
    expect(decideSidecarWizardFetchRefused(reachable, true).pass).toBe(false);
  });

  it('FAILS when the probe never reported — an unanswerable sensor is not a pass', () => {
    expect(decideSidecarWizardFetchRefused(undefined, false).pass).toBe(false);
  });

  it('passes only with no callback AND an unreachable key', () => {
    expect(decideSidecarWizardFetchRefused(reachable, false).pass).toBe(true);
  });

  it("a sidecar_fetch refusal can never grant the WIZARD command's verdict", () => {
    // The whole point of the row: the sibling being refused says nothing about
    // this command, which is registered separately and is the more dangerous one.
    const siblingRefusedButWizardReached = {
      ...reachable,
      sidecarCallbackFired: false,
      sidecarWizardCallbackFired: true,
    };
    expect(decideSidecarFetchRefused(siblingRefusedButWizardReached, false).pass).toBe(true);
    expect(decideSidecarWizardFetchRefused(siblingRefusedButWizardReached, false).pass).toBe(false);
  });

  it("the wizard command's refusal can never grant sidecar_fetch's verdict", () => {
    const wizardRefusedButSiblingReached = {
      ...reachable,
      sidecarCallbackFired: true,
      sidecarWizardCallbackFired: false,
    };
    expect(decideSidecarWizardFetchRefused(wizardRefusedButSiblingReached, false).pass).toBe(true);
    expect(decideSidecarFetchRefused(wizardRefusedButSiblingReached, false).pass).toBe(false);
  });

  it('the verdict is one of the REQUIRED check ids', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-sidecar-wizard-fetch-refused');
  });

  it('the command name matches the one lib.rs registers', () => {
    expect(SIDECAR_WIZARD_FETCH_COMMAND).toBe('sidecar_wizard_fetch');
  });
});

describe('decideSidecarWizardFetchDispatchable — the POSITIVE twin', () => {
  // A refusal check over an unregistered command vouches for nothing (the
  // eight-seam defect). This row earns its own twin for the same reason the
  // sibling did.

  it('passes when the invoke RESOLVES — the helper answered, so dispatch happened', () => {
    expect(decideSidecarWizardFetchDispatchable({ resolved: true, detail: 'resolved' }).pass).toBe(true);
  });

  it('passes when the command BODY refuses (helper not running) — refusal proves dispatch', () => {
    const result = decideSidecarWizardFetchDispatchable({
      resolved: false,
      detail: 'the WhatsApp helper is not running — open the connection settings to start it',
    });
    expect(result.pass).toBe(true);
  });

  it('FAILS on the unregistered-command shape — the exact defect this twin exists for', () => {
    for (const detail of [
      'Command sidecar_wizard_fetch not found',
      'sidecar_wizard_fetch not allowed. Command not found',
      'unknown command sidecar_wizard_fetch',
    ]) {
      expect(decideSidecarWizardFetchDispatchable({ resolved: false, detail }).pass, detail).toBe(false);
    }
  });

  it('is one of the REQUIRED check ids — the derive-based driver expects it', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-sidecar-wizard-fetch-dispatchable');
  });
});

describe('decideUpdateChannelCommandRefused — the updater/relaunch rows (ADR-0047 §3)', () => {
  // The three rows share one decision; what these tests pin is that each row reads
  // its OWN fired slot (amendment 16 — reach proven for one command must never be
  // credited to another) and that every cannot-tell input FAILS.
  const ROWS = [
    { id: 'ipc-updater-check-refused', command: UPDATER_CHECK_COMMAND, flag: 'updaterCheckCallbackFired' },
    { id: 'ipc-updater-install-refused', command: UPDATER_INSTALL_COMMAND, flag: 'updaterInstallCallbackFired' },
    { id: 'ipc-helper-install-refused', command: HELPER_INSTALL_COMMAND, flag: 'helperInstallCallbackFired' },
    { id: 'ipc-process-relaunch-refused', command: PROCESS_RELAUNCH_COMMAND, flag: 'relaunchCallbackFired' },
  ] as const;

  it('FAILS its own row when its own callback fired — and names the command', () => {
    for (const row of ROWS) {
      const result = decideUpdateChannelCommandRefused(
        row.id,
        row.command,
        'stakes sentence',
        { ...reachable, [row.flag]: true, fired: true },
        false,
      );
      expect(result.pass, row.id).toBe(false);
      expect(result.detail).toContain(row.command);
      expect(result.detail).toContain('STRUCTURAL BREAKAGE');
    }
  });

  it('FAILS when the invoke key is reachable — a silent dispatch cannot be ruled out', () => {
    for (const row of ROWS) {
      const result = decideUpdateChannelCommandRefused(row.id, row.command, 's', { ...reachable, fired: false }, true);
      expect(result.pass, row.id).toBe(false);
      expect(result.detail).toContain('cannot vouch');
    }
  });

  it('FAILS when the probe never reported — no invoke attempted is not a refusal', () => {
    for (const row of ROWS) {
      expect(decideUpdateChannelCommandRefused(row.id, row.command, 's', undefined, false).pass, row.id).toBe(false);
    }
  });

  it('PASSES only on: probe reported, own slot silent, key unreachable', () => {
    for (const row of ROWS) {
      const result = decideUpdateChannelCommandRefused(row.id, row.command, 's', { ...reachable, fired: false }, false);
      expect(result.pass, row.id).toBe(true);
      expect(result.detail).toContain('key-gated per command');
    }
  });

  it('the command names match the plugin registrations lib.rs makes', () => {
    expect(UPDATER_CHECK_COMMAND).toBe('plugin:updater|check');
    expect(UPDATER_INSTALL_COMMAND).toBe('plugin:updater|download_and_install');
    expect(PROCESS_RELAUNCH_COMMAND).toBe('plugin:process|restart');
  });

  it('all four new ids are REQUIRED — the derive-based driver expects them', () => {
    for (const id of [
      'ipc-updater-check-refused',
      'ipc-updater-install-refused',
      'ipc-process-relaunch-refused',
      'ipc-updater-check-dispatchable',
      'ipc-helper-install-refused',
      'ipc-helper-status-dispatchable',
    ]) {
      expect(IPC_CHECK_IDS).toContain(id);
    }
  });
});

describe('decideUpdaterCheckDispatchable — the updater positive twin', () => {
  it('passes when the invoke resolves, and when the BODY answers with a runtime failure', () => {
    expect(decideUpdaterCheckDispatchable({ resolved: true, detail: 'resolved' }).pass).toBe(true);
    // The pre-flip normal state: the private repo 404s / no network on a runner —
    // the body ran, which is the whole question.
    expect(
      decideUpdaterCheckDispatchable({ resolved: false, detail: 'error sending request for url' }).pass,
    ).toBe(true);
  });

  it('FAILS on the unregistered-command shapes', () => {
    for (const detail of [
      'Command plugin:updater|check not found',
      'plugin:updater|check not allowed. Command not found',
      'unknown command',
    ]) {
      expect(decideUpdaterCheckDispatchable({ resolved: false, detail }).pass, detail).toBe(false);
    }
  });
});

describe('helper seat rows (ADR-0060 §7)', () => {
  it('names the Rust commands lib.rs registers', () => {
    expect(HELPER_INSTALL_COMMAND).toBe('helper_install');
    expect(HELPER_STATUS_COMMAND).toBe('helper_status');
  });
  it('the status twin passes on any body answer and fails only on an unregistered command', () => {
    expect(decideHelperStatusDispatchable({ resolved: true, detail: 'resolved' }).pass).toBe(true);
    expect(decideHelperStatusDispatchable({ resolved: false, detail: "'x' is not a helper this build knows" }).pass).toBe(true);
    expect(decideHelperStatusDispatchable({ resolved: false, detail: 'Command helper_status not found' }).pass).toBe(false);
  });
});
