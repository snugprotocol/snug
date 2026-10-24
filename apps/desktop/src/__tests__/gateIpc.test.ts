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

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// The Tauri core module is not loadable outside a shell. Every decide* test below is pure; only
// the ChatGPT-session effect-sensor test at the end drives `runIpcChecks` and programs this fake.
const core = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => {
    throw new Error('not in a shell');
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: core.invoke }));

import {
  CHATGPT_SESSION_CLEAR_COMMAND,
  CHATGPT_SESSION_READ_COMMAND,
  CHATGPT_SESSION_WRITE_COMMAND,
  GATE_CHATGPT_SESSION_STAT_COMMAND,
  GATE_CHATGPT_SESSION_MARKER_COMMAND,
  GATE_HOME_MARKER_NAME,
  decideChatgptSessionGateHome,
  decideChatgptSessionClearDispatchable,
  decideChatgptSessionReadDispatchable,
  decideChatgptSessionRefused,
  decideChatgptSessionWriteDispatchable,
  runIpcChecks,
  decideDispatchable,
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
  NOTIFICATION_NOTIFY_COMMAND,
  NOTIFICATION_PERMISSION_COMMAND,
  decideHelperStatusDispatchable,
  decideNotificationDispatchable,
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
  notificationCallbackFired: false,
  chatgptSessionReadCallbackFired: false,
  chatgptSessionWriteCallbackFired: false,
  chatgptSessionClearCallbackFired: false,
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

describe('decideDispatchable — ONE rule and ONE regex behind every positive twin (M13)', () => {
  const body = (detail: string) => ({ resolved: false, detail });

  it('a resolved invoke passes; a body-level answer passes; only the unregistered/uncapable shapes fail, naming what they vouch for', () => {
    expect(decideDispatchable('x', 'cmd', { resolved: true, detail: 'ok' }, 'ipc-x-refused')).toEqual({
      id: 'x',
      pass: true,
      detail: 'cmd dispatched from the main window and resolved (ok)',
    });
    for (const detail of ['the helper is not running', 'error sending request for url', "'x' is not a helper this build knows", 'notification permission state unavailable']) {
      expect(decideDispatchable('x', 'cmd', body(detail), 'ipc-x-refused'), detail).toEqual({ id: 'x', pass: true, detail: `cmd dispatched and the command body answered: ${detail}` });
    }
    for (const detail of ['Command cmd not found', 'cmd not allowed. Permissions associated with this command: x', 'unknown command cmd', 'unknown command']) {
      const result = decideDispatchable('x', 'cmd', body(detail), 'ipc-x-refused');
      expect(result.pass, detail).toBe(false);
      expect(result.detail).toContain('cmd is NOT DISPATCHABLE from the main window');
      expect(result.detail).toContain('ipc-x-refused is vouching for nothing');
    }
  });

  it('the five twins are the one rule applied to their id and command', () => {
    for (const outcome of [
      { resolved: true, detail: 'resolved' },
      { resolved: false, detail: 'Command x not found' },
      { resolved: false, detail: 'something the body said' },
    ]) {
      expect(decideSidecarFetchDispatchable(outcome)).toEqual(decideDispatchable('ipc-sidecar-fetch-dispatchable', SIDECAR_FETCH_COMMAND, outcome, 'ipc-sidecar-fetch-refused'));
      expect(decideSidecarWizardFetchDispatchable(outcome)).toEqual(
        decideDispatchable('ipc-sidecar-wizard-fetch-dispatchable', SIDECAR_WIZARD_FETCH_COMMAND, outcome, 'ipc-sidecar-wizard-fetch-refused'),
      );
      expect(decideUpdaterCheckDispatchable(outcome)).toEqual(
        decideDispatchable('ipc-updater-check-dispatchable', UPDATER_CHECK_COMMAND, outcome, 'ipc-updater-check-refused / ipc-updater-install-refused / ipc-process-relaunch-refused'),
      );
      expect(decideHelperStatusDispatchable(outcome)).toEqual(decideDispatchable('ipc-helper-status-dispatchable', HELPER_STATUS_COMMAND, outcome, 'ipc-helper-install-refused'));
      expect(decideNotificationDispatchable(outcome)).toEqual(decideDispatchable('ipc-notification-dispatchable', NOTIFICATION_PERMISSION_COMMAND, outcome, 'ipc-notification-refused'));
    }
  });

  it('the source spells the undispatchable shape ONCE — a sixth twin cannot retype it', () => {
    const source = readFileSync(path.resolve(__dirname, '../gate/ipc.ts'), 'utf8');
    expect(source.match(/\/not \(\?:found\|allowed\)\|unknown command\/i/g)).toHaveLength(1);
    expect(source).not.toMatch(/not found\|not allowed\|unknown command/);
    expect(source).not.toMatch(/Command \.\* not found/);
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

// PER-COMMAND IPC unreachability for the notification plugin (TASK-20261009-scheduling-framework
// H1; ADR-0074 §6–§7).
//
// WHY THIS ROW EXISTS: `plugin:notification|notify` raises an OS banner signed as Snug. An app
// iframe that reached it could put any sentence on the user's screen under the shell's own icon
// — the phishing surface §6 closes by making notifications host-decided (one seat, the engine's
// text, after a Settings opt-in). Amendment 16: registration is per-command, so only a
// per-command probe can see this plugin's command, and it reads its OWN callback slot.
describe('ipc-notification-refused — plugin:notification|notify specifically', () => {
  const row = (report: Parameters<typeof decideUpdateChannelCommandRefused>[3], keyReachable: boolean) =>
    decideUpdateChannelCommandRefused('ipc-notification-refused', NOTIFICATION_NOTIFY_COMMAND, 'app code can raise OS notifications signed as Snug', report, keyReachable);

  it('FAILS when a keyless notify resolved a callback into the subframe — and names the command and the trigger', () => {
    const result = row({ ...reachable, notificationCallbackFired: true, fired: true }, false);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain(NOTIFICATION_NOTIFY_COMMAND);
    expect(result.detail).toContain('STRUCTURAL BREAKAGE');
  });

  it('cannot vouch for refusal while the invoke key is reachable', () => {
    expect(row({ ...reachable, fired: false }, true).pass).toBe(false);
  });

  it('FAILS when the probe never reported — an unanswerable sensor is not a pass', () => {
    expect(row(undefined, false).pass).toBe(false);
  });

  it('passes only with its own slot silent AND an unreachable key', () => {
    const result = row({ ...reachable, fired: false }, false);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('key-gated per command');
  });

  it("a helper_install refusal alone can never grant the notification verdict — each row reads its own slot", () => {
    const helperRefusedButNotifyReached = { ...reachable, helperInstallCallbackFired: false, notificationCallbackFired: true };
    expect(
      decideUpdateChannelCommandRefused('ipc-helper-install-refused', HELPER_INSTALL_COMMAND, 's', { ...helperRefusedButNotifyReached, fired: helperRefusedButNotifyReached.helperInstallCallbackFired }, false).pass,
    ).toBe(true);
    expect(row({ ...helperRefusedButNotifyReached, fired: helperRefusedButNotifyReached.notificationCallbackFired }, false).pass).toBe(false);
  });

  it('the command names match the plugin’s registrations (its JS shim and init script post exactly these)', () => {
    expect(NOTIFICATION_NOTIFY_COMMAND).toBe('plugin:notification|notify');
    expect(NOTIFICATION_PERMISSION_COMMAND).toBe('plugin:notification|is_permission_granted');
  });

  it('both ids are REQUIRED — the derive-based driver expects them, and a missing verdict is a fail', () => {
    expect(IPC_CHECK_IDS).toContain('ipc-notification-refused');
    expect(IPC_CHECK_IDS).toContain('ipc-notification-dispatchable');
  });
});

describe('decideNotificationDispatchable — the POSITIVE twin, over is_permission_granted', () => {
  // A refusal check over an unregistered plugin vouches for nothing (the eight-seam defect), so
  // the main window must be shown to reach the plugin. The twin drives the permission read, not
  // `notify`: a dispatched notify would put a banner on the runner's screen and prove no more.

  it('passes when the invoke RESOLVES — the plugin answered from the main frame', () => {
    const result = decideNotificationDispatchable({ resolved: true, detail: 'answered true' });
    expect(result.pass).toBe(true);
    expect(result.detail).toContain(NOTIFICATION_PERMISSION_COMMAND);
  });

  it('passes when the command BODY answers with an error — the body ran, which is the question', () => {
    expect(decideNotificationDispatchable({ resolved: false, detail: 'notification permission state unavailable' }).pass).toBe(true);
  });

  it('FAILS on the unregistered/uncapable shapes — the exact defect this twin exists for', () => {
    for (const detail of [
      'Command plugin:notification|is_permission_granted not found',
      'plugin:notification|is_permission_granted not allowed. Permissions associated with this command: notification:allow-is-permission-granted',
      'unknown command plugin:notification|is_permission_granted',
    ]) {
      const result = decideNotificationDispatchable({ resolved: false, detail });
      expect(result.pass, detail).toBe(false);
      expect(result.detail).toContain('vouching for nothing');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The ChatGPT-plan custody commands (TASK-20261023-siwc-chatgpt-plan AC13, D2, folds F3/S6).
//
// `chatgpt_session_read` RETURNS the user's ChatGPT tokens; `_write` can plant a session (an
// attacker's account) and `_clear` signs the user out. Capabilities do not scope custom commands
// (no AppManifest), so the wall is the invoke key — exactly as for `read_user_file` — and these
// rows prove it per command (amendment 16): a keyless invoke of each from a sandboxed frame
// resolves no callback, each reading its OWN slot.
//
// The positive twins are EFFECT SENSORS, not reach probes, and they run in the gate's throwaway
// HOME (run-gate.mjs launches the shell with `HOME: fakeHome`, and `userfile::snug_dir()` reads
// HOME — so `~/Snug/.chatgpt-plan` is a temp dir, never the developer's real session): a write
// must leave a `0600` file in a `0700` directory (observed through the debug-only
// `gate_chatgpt_session_stat`, which answers modes and existence — never bytes), a read must
// resolve, a clear must leave no file. A body or payload NEVER lands in the results JSON.
// ---------------------------------------------------------------------------------------------

const SESSION_IDS = {
  read: { refused: 'ipc-chatgpt-session-read-refused', dispatchable: 'ipc-chatgpt-session-read-dispatchable' },
  write: { refused: 'ipc-chatgpt-session-write-refused', dispatchable: 'ipc-chatgpt-session-write-dispatchable' },
  clear: { refused: 'ipc-chatgpt-session-clear-refused', dispatchable: 'ipc-chatgpt-session-clear-dispatchable' },
} as const;

const SLOT = {
  read: 'chatgptSessionReadCallbackFired',
  write: 'chatgptSessionWriteCallbackFired',
  clear: 'chatgptSessionClearCallbackFired',
} as const;

const COMMAND = {
  read: CHATGPT_SESSION_READ_COMMAND,
  write: CHATGPT_SESSION_WRITE_COMMAND,
  clear: CHATGPT_SESSION_CLEAR_COMMAND,
} as const;

const WHICH = ['read', 'write', 'clear'] as const;

/** The G5-A10 row: the throwaway HOME must carry the driver's marker before any sensor acts. */
const GATE_HOME_ID = 'ipc-chatgpt-session-gate-home';

const UNREGISTERED = (cmd: string): string[] => [
  `Command ${cmd} not found`,
  `${cmd} not allowed. Permissions associated with this command: none`,
  `unknown command ${cmd}`,
];

describe('the ChatGPT-session commands: names, ids, declarations', () => {
  it('the command names are the ones lib.rs registers (chatgpt_session.rs pins the handler lists)', () => {
    expect(CHATGPT_SESSION_READ_COMMAND).toBe('chatgpt_session_read');
    expect(CHATGPT_SESSION_WRITE_COMMAND).toBe('chatgpt_session_write');
    expect(CHATGPT_SESSION_CLEAR_COMMAND).toBe('chatgpt_session_clear');
    expect(GATE_CHATGPT_SESSION_STAT_COMMAND).toBe('gate_chatgpt_session_stat');
    expect(GATE_CHATGPT_SESSION_MARKER_COMMAND).toBe('gate_chatgpt_session_marker_present');
    expect(GATE_HOME_MARKER_NAME).toBe('.snug-shell-gate-home');
  });

  it('the gate-home row is REQUIRED too (G5-A10) — the effect sensors never run without it', () => {
    expect(IPC_CHECK_IDS).toContain(GATE_HOME_ID);
  });

  it('all six ids are REQUIRED — the derive-based driver expects them, and a missing verdict is a fail', () => {
    for (const which of WHICH) {
      expect(IPC_CHECK_IDS).toContain(SESSION_IDS[which].refused);
      expect(IPC_CHECK_IDS).toContain(SESSION_IDS[which].dispatchable);
    }
  });

  it('the sandboxed probe POSTS a keyless invoke of each command, each with its own report slot', () => {
    // A refusal row whose command the probe never sends passes vacuously — the declaration is
    // the only place that can be seen from a test.
    const source = readFileSync(path.resolve(__dirname, '../gate/ipc.ts'), 'utf8');
    for (const name of ['CHATGPT_SESSION_READ_COMMAND', 'CHATGPT_SESSION_WRITE_COMMAND', 'CHATGPT_SESSION_CLEAR_COMMAND']) {
      expect(source, `the probe must post cmd: '\${${name}}'`).toContain(`cmd: '\${${name}}'`);
    }
    for (const slot of Object.values(SLOT)) {
      expect(source.match(new RegExp(`${slot}: ${slot}`, 'g')), `the probe reports ${slot}`).toHaveLength(1);
    }
  });
});

describe('decideChatgptSessionRefused — per command, each reading its OWN slot', () => {
  for (const which of WHICH) {
    describe(`chatgpt_session_${which}`, () => {
      it('FAILS when its own keyless invoke resolved a callback into the subframe — and names the command', () => {
        const result = decideChatgptSessionRefused(which, { ...reachable, [SLOT[which]]: true }, false);
        expect(result.id).toBe(SESSION_IDS[which].refused);
        expect(result.pass).toBe(false);
        expect(result.detail).toContain(COMMAND[which]);
        expect(result.detail).toContain('STRUCTURAL BREAKAGE');
      });

      it('cannot vouch for refusal while the invoke key is reachable', () => {
        const result = decideChatgptSessionRefused(which, reachable, true);
        expect(result.pass).toBe(false);
        expect(result.detail).toContain('cannot vouch');
      });

      it('FAILS when the probe never reported — an unanswerable sensor is not a pass', () => {
        expect(decideChatgptSessionRefused(which, undefined, false).pass).toBe(false);
      });

      it('passes only with its own slot silent AND an unreachable key', () => {
        const result = decideChatgptSessionRefused(which, reachable, false);
        expect(result.pass).toBe(true);
        expect(result.detail).toContain('key-gated per command');
      });

      it('a reach proven for a SIBLING is never credited to (or charged against) this row', () => {
        for (const other of WHICH.filter((w) => w !== which)) {
          expect(decideChatgptSessionRefused(which, { ...reachable, [SLOT[other]]: true }, false).pass, `${other} fired`).toBe(true);
        }
        // …nor any other command's slot (write_user_file's own `callbackFired` included).
        expect(decideChatgptSessionRefused(which, { ...reachable, callbackFired: true, lanCallbackFired: true }, false).pass).toBe(true);
      });
    });
  }
});

describe('decideChatgptSessionReadDispatchable — the read twin records ONLY that it resolved', () => {
  it('passes when the main-frame read resolves, naming the command', () => {
    const result = decideChatgptSessionReadDispatchable({ resolved: true, detail: 'resolved' });
    expect(result).toMatchObject({ id: SESSION_IDS.read.dispatchable, pass: true });
    expect(result.detail).toContain(CHATGPT_SESSION_READ_COMMAND);
  });

  it('NEVER echoes what the caller saw on success — a session body must not reach the results JSON', () => {
    const body = '{"v":1,"hostId":"urn:uuid:BODY-MARKER","tokens":{"accessToken":"eyJhbGciOi.BODY.MARKER"}}';
    const result = decideChatgptSessionReadDispatchable({ resolved: true, detail: body });
    expect(result.detail).not.toContain('BODY-MARKER');
    expect(result.detail).not.toContain('eyJ');
    expect(Object.keys(result).sort()).toEqual(['detail', 'id', 'pass']);
  });

  it('FAILS on the unregistered/uncapable shapes', () => {
    for (const detail of UNREGISTERED(CHATGPT_SESSION_READ_COMMAND)) {
      expect(decideChatgptSessionReadDispatchable({ resolved: false, detail }).pass, detail).toBe(false);
    }
  });

  it('FAILS when the body errors — in the throwaway HOME a read must resolve (it is an effect sensor, not a reach probe)', () => {
    expect(decideChatgptSessionReadDispatchable({ resolved: false, detail: 'read session.json: Permission denied' }).pass).toBe(false);
  });
});

describe('decideChatgptSessionWriteDispatchable — the write twin asserts the ON-DISK effect', () => {
  const ok = { resolved: true, detail: 'resolved' };
  const good = { exists: true, fileMode: 0o600, dirMode: 0o700 };

  it('passes on a resolved write that left a 0600 file in a 0700 directory', () => {
    const result = decideChatgptSessionWriteDispatchable(ok, good);
    expect(result).toMatchObject({ id: SESSION_IDS.write.dispatchable, pass: true });
    expect(result.detail).toContain(CHATGPT_SESSION_WRITE_COMMAND);
  });

  it('reads permission bits only — a full st_mode (type bits included) still passes', () => {
    expect(decideChatgptSessionWriteDispatchable(ok, { exists: true, fileMode: 0o100600, dirMode: 0o40700 }).pass).toBe(true);
  });

  it('FAILS on a 0644 file (the umask default) — and says what it found', () => {
    const result = decideChatgptSessionWriteDispatchable(ok, { ...good, fileMode: 0o644 });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/644/);
  });

  it('FAILS on a 0755 directory', () => {
    const result = decideChatgptSessionWriteDispatchable(ok, { ...good, dirMode: 0o755 });
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/755/);
  });

  it('FAILS when the write resolved but no file exists — a no-op body is not custody', () => {
    expect(decideChatgptSessionWriteDispatchable(ok, { exists: false, fileMode: null, dirMode: null }).pass).toBe(false);
  });

  it('FAILS when the stat probe is unavailable — never vouches on a dead sensor', () => {
    const result = decideChatgptSessionWriteDispatchable(ok, { error: 'Command gate_chatgpt_session_stat not found' });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('cannot vouch');
  });

  it('FAILS when the write did not resolve — body errors and unregistered shapes alike', () => {
    expect(decideChatgptSessionWriteDispatchable({ resolved: false, detail: 'payload exceeds 65536 bytes' }, good).pass).toBe(false);
    for (const detail of UNREGISTERED(CHATGPT_SESSION_WRITE_COMMAND)) {
      expect(decideChatgptSessionWriteDispatchable({ resolved: false, detail }, good).pass, detail).toBe(false);
    }
  });

  it('NEVER echoes what the caller passed on success — the payload must not reach the results JSON', () => {
    const result = decideChatgptSessionWriteDispatchable({ resolved: true, detail: 'PAYLOAD-MARKER eyJ.x.y' }, good);
    expect(result.detail).not.toContain('PAYLOAD-MARKER');
    expect(Object.keys(result).sort()).toEqual(['detail', 'id', 'pass']);
  });
});

describe('decideChatgptSessionClearDispatchable — the clear twin asserts the file is GONE', () => {
  const ok = { resolved: true, detail: 'resolved' };

  it('passes on a resolved clear that left no file', () => {
    const result = decideChatgptSessionClearDispatchable(ok, { exists: false, fileMode: null, dirMode: 0o700 });
    expect(result).toMatchObject({ id: SESSION_IDS.clear.dispatchable, pass: true });
    expect(result.detail).toContain(CHATGPT_SESSION_CLEAR_COMMAND);
  });

  it('FAILS when the file is still on disk — a sign-out that leaves the tokens behind', () => {
    expect(decideChatgptSessionClearDispatchable(ok, { exists: true, fileMode: 0o600, dirMode: 0o700 }).pass).toBe(false);
  });

  it('FAILS when the stat probe is unavailable', () => {
    expect(decideChatgptSessionClearDispatchable(ok, { error: 'boom' }).pass).toBe(false);
  });

  it('FAILS when the clear did not resolve — body errors and unregistered shapes alike', () => {
    const gone = { exists: false, fileMode: null, dirMode: null };
    expect(decideChatgptSessionClearDispatchable({ resolved: false, detail: 'remove session.json: busy' }, gone).pass).toBe(false);
    for (const detail of UNREGISTERED(CHATGPT_SESSION_CLEAR_COMMAND)) {
      expect(decideChatgptSessionClearDispatchable({ resolved: false, detail }, gone).pass, detail).toBe(false);
    }
  });
});

// G5-A10. The effect sensors WRITE over, then CLEAR, whatever `~/Snug/.chatgpt-plan/session.json`
// the shell's HOME resolves to. `run-gate.mjs` points HOME at a throwaway directory — but
// `SNUG_SHELL_GATE=1` + `SNUG_SHELL_GATE_OUT` on a plain `tauri dev` would run the same sensors
// over the developer's REAL home and delete their tokens and registration. So the driver drops a
// marker file into every HOME it creates, the debug-only `gate_chatgpt_session_marker_present`
// answers whether `<home>/.snug-shell-gate-home` exists, and the harness refuses to seed, read or
// clear anything without it — recording the three twins as skipped rows that FAIL the gate.
describe('decideChatgptSessionGateHome — the sensors require the driver’s marker in HOME (G5-A10)', () => {
  it('passes when the marker is present, naming the marker file', () => {
    const result = decideChatgptSessionGateHome(true);
    expect(result).toMatchObject({ id: GATE_HOME_ID, pass: true });
    expect(result.detail).toContain(GATE_HOME_MARKER_NAME);
  });

  it('FAILS when the marker is absent — and says the sensors were skipped, not run', () => {
    const result = decideChatgptSessionGateHome(false);
    expect(result).toMatchObject({ id: GATE_HOME_ID, pass: false });
    expect(result.detail).toContain('no gate-home marker');
    expect(result.detail).toContain(GATE_HOME_MARKER_NAME);
  });

  it('FAILS when the marker command is unavailable — a shell without it cannot vouch for its HOME', () => {
    const result = decideChatgptSessionGateHome({ error: `Command ${GATE_CHATGPT_SESSION_MARKER_COMMAND} not found` });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('cannot vouch');
  });
});

describe('runIpcChecks drives the ChatGPT-session effect sensors from the main frame', () => {
  /**
   * A fake shell over a fake throwaway HOME: the three commands act on one in-memory file and
   * `gate_chatgpt_session_stat` reports it. jsdom never runs the srcdoc probe, so the subframe
   * rows time out as "never reported" — irrelevant here; the subject is the main-frame twins.
   * The gate-home marker is PRESENT unless a test says otherwise (G5-A10).
   */
  async function runAgainstFakeShell(opts: { fileModeAfterWrite?: number; marker?: boolean | 'unregistered' } = {}) {
    const READ_BODY = '{"v":1,"hostId":"urn:uuid:GATE-READ-BODY-MARKER","tokens":{"accessToken":"eyJGATE.READ.BODY"}}';
    const disk = { exists: false };
    const log = { readWhileExists: false, statCalls: 0, writes: [] as string[], reads: 0, clears: 0 };
    core.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      switch (cmd) {
        case 'gate_ipc_sentinel_exists':
          return false;
        case GATE_CHATGPT_SESSION_MARKER_COMMAND:
          if (opts.marker === 'unregistered') throw new Error(`Command ${GATE_CHATGPT_SESSION_MARKER_COMMAND} not found`);
          return opts.marker ?? true;
        case CHATGPT_SESSION_WRITE_COMMAND: {
          const payload = (args as { payload?: unknown } | undefined)?.payload;
          if (typeof payload !== 'string') throw new Error('missing payload');
          log.writes.push(payload);
          disk.exists = true;
          return null;
        }
        case CHATGPT_SESSION_READ_COMMAND:
          log.reads += 1;
          if (disk.exists) log.readWhileExists = true;
          return disk.exists ? READ_BODY : null;
        case CHATGPT_SESSION_CLEAR_COMMAND:
          log.clears += 1;
          disk.exists = false;
          return null;
        case GATE_CHATGPT_SESSION_STAT_COMMAND:
          log.statCalls += 1;
          return disk.exists
            ? { exists: true, fileMode: opts.fileModeAfterWrite ?? 0o600, dirMode: 0o700 }
            : { exists: false, fileMode: null, dirMode: 0o700 };
        default:
          throw new Error('the helper is not running');
      }
    });
    vi.useFakeTimers();
    try {
      const running = runIpcChecks();
      await vi.advanceTimersByTimeAsync(15_000);
      const results = await running;
      return { results, disk, log, READ_BODY };
    } finally {
      vi.useRealTimers();
      core.invoke.mockImplementation(async () => {
        throw new Error('not in a shell');
      });
    }
  }

  it('all three twins PASS against a shell whose commands behave', async () => {
    const { results } = await runAgainstFakeShell();
    for (const which of WHICH) {
      const row = results.find((r) => r.id === SESSION_IDS[which].dispatchable);
      expect(row, SESSION_IDS[which].dispatchable).toBeDefined();
      expect(row!.pass, `${row!.id}: ${row!.detail}`).toBe(true);
    }
  });

  it('a read runs while a session file EXISTS (the fixture is seeded), and the gate leaves no session behind', async () => {
    const { log, disk } = await runAgainstFakeShell();
    expect(log.writes.length, 'the main frame writes a marker session').toBeGreaterThan(0);
    expect(log.readWhileExists, 'a read of an empty HOME proves nothing about the body path').toBe(true);
    expect(log.statCalls, 'the on-disk effect is observed after the write AND after the clear').toBeGreaterThanOrEqual(2);
    expect(disk.exists, 'the last act is the clear — the throwaway HOME ends signed out').toBe(false);
  });

  it('NO session body or written payload lands anywhere in the results', async () => {
    const { results, log, READ_BODY } = await runAgainstFakeShell();
    const json = JSON.stringify(results);
    expect(json).not.toContain('GATE-READ-BODY-MARKER');
    expect(json).not.toContain(READ_BODY);
    expect(json).not.toContain('eyJ');
    for (const payload of log.writes) expect(json).not.toContain(payload);
    for (const which of WHICH) {
      for (const id of [SESSION_IDS[which].refused, SESSION_IDS[which].dispatchable]) {
        const row = results.find((r) => r.id === id)!;
        expect(Object.keys(row).sort(), `${id} records no body/payload field`).toEqual(['detail', 'id', 'pass']);
      }
    }
  });

  it('a write that lands a 0644 file FAILS the write twin end to end', async () => {
    const { results } = await runAgainstFakeShell({ fileModeAfterWrite: 0o644 });
    expect(results.find((r) => r.id === SESSION_IDS.write.dispatchable)!.pass).toBe(false);
  });

  it('with the marker present, the gate-home row PASSES (G5-A10)', async () => {
    const { results } = await runAgainstFakeShell();
    const row = results.find((r) => r.id === GATE_HOME_ID);
    expect(row, GATE_HOME_ID).toBeDefined();
    expect(row!.pass, row!.detail).toBe(true);
  });

  it('WITHOUT the marker, no write, read or clear is sent — the three twins are recorded skipped and FAIL, and so does the gate-home row (G5-A10)', async () => {
    // The HOME is somebody's real one for all the harness knows: SNUG_SHELL_GATE=1 on a plain
    // `tauri dev` must never delete a real session.
    const { results, log, disk } = await runAgainstFakeShell({ marker: false });
    expect(log.writes, 'no seed written over the real file').toEqual([]);
    expect(log.reads, 'no read of the real file').toBe(0);
    expect(log.clears, 'no clear of the real file').toBe(0);
    expect(disk.exists).toBe(false);
    expect(results.find((r) => r.id === GATE_HOME_ID)!.pass).toBe(false);
    for (const which of WHICH) {
      const row = results.find((r) => r.id === SESSION_IDS[which].dispatchable)!;
      expect(row.pass, row.id).toBe(false);
      expect(row.detail, row.id).toContain('skipped: no gate-home marker');
    }
    // The refusal rows are untouched by the marker: they read the subframe's report, not HOME.
    for (const which of WHICH) {
      expect(results.find((r) => r.id === SESSION_IDS[which].refused)!.detail).not.toContain('gate-home');
    }
  });

  it('a shell WITHOUT the marker command (built before it, or a release-shaped handler list) is treated as no marker — nothing is sent', async () => {
    const { results, log } = await runAgainstFakeShell({ marker: 'unregistered' });
    expect(log.writes).toEqual([]);
    expect(log.reads).toBe(0);
    expect(log.clears).toBe(0);
    expect(results.find((r) => r.id === GATE_HOME_ID)!.pass).toBe(false);
    expect(results.find((r) => r.id === SESSION_IDS.write.dispatchable)!.pass).toBe(false);
  });

  it('the marker is asked for BEFORE the seed is written — the order is the protection', async () => {
    const order: string[] = [];
    core.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      if (cmd === GATE_CHATGPT_SESSION_MARKER_COMMAND) return true;
      if (cmd === GATE_CHATGPT_SESSION_STAT_COMMAND) return { exists: false, fileMode: null, dirMode: null };
      if (cmd === 'gate_ipc_sentinel_exists') return false;
      if (cmd.startsWith('chatgpt_session_')) return null;
      throw new Error('not here');
    });
    vi.useFakeTimers();
    try {
      const running = runIpcChecks();
      await vi.advanceTimersByTimeAsync(15_000);
      await running;
    } finally {
      vi.useRealTimers();
      core.invoke.mockImplementation(async () => {
        throw new Error('not in a shell');
      });
    }
    const marker = order.indexOf(GATE_CHATGPT_SESSION_MARKER_COMMAND);
    const seed = order.indexOf(CHATGPT_SESSION_WRITE_COMMAND);
    expect(marker, 'the marker command runs').toBeGreaterThanOrEqual(0);
    expect(seed, 'the seed runs when the marker is present').toBeGreaterThanOrEqual(0);
    expect(marker).toBeLessThan(seed);
  });
});
