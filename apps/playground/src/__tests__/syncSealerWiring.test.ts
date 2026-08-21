// TASK-20260820 — the composition root must hand the sync loop its sealer (D-2).
//
// WHY THIS TEST EXISTS AND WHY IT LOOKS LIKE THIS. `encrypted-sync.test.ts` in
// packages/db proves the LOOP seals personal-origin payloads — but it wires the sealer
// by hand, so it proved a capability nobody was using. The real app never passed
// `sealForOrigin`, and a protected file therefore synced to the user's own Dropbox as a
// plainly readable database. Every suite was green.
//
// The lesson is the shape of the test, not the fix: a test that constructs its own
// wiring cannot detect missing wiring. This one asserts against the actual call the
// shipping code makes.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const syncSource = readFileSync(join(SRC, 'state/sync.ts'), 'utf8');

// The SAME defect class bit twice: components built and unit-tested in isolation, never
// rendered by the app. Owner found it by running the desktop client and never being asked
// for a passphrase. These assertions are deliberately about REACHABILITY — "is this
// component mounted by something the user can get to" — because that is the question
// component tests structurally cannot answer.
describe('the protection flow is REACHABLE by a real user', () => {
  const appSource = readFileSync(join(SRC, 'App.tsx'), 'utf8');
  const hubSource = readFileSync(join(SRC, 'views/HubView.tsx'), 'utf8');
  const settingsSource = readFileSync(join(SRC, 'views/SettingsView.tsx'), 'utf8');

  it('the offer latch is initialised at boot', () => {
    // Without this the store is false forever and the offer never appears, no matter
    // how correct protectOffer.ts is.
    expect(appSource).toContain('initProtectOffer');
  });

  it('something actually RENDERS ProtectSetupFlow', () => {
    const rendered = `${appSource}${hubSource}${settingsSource}`;
    expect(rendered).toContain('ProtectSetupFlow');
  });

  it('Settings can turn protection on and off after first run', () => {
    // D3 said the offer is prominent at first run AND changeable in Settings. A user
    // who said "not now" needs a door, and a protected user needs a way back out.
    expect(settingsSource).toMatch(/enableProtection|ProtectSetupFlow/);
    expect(settingsSource).toContain('disableProtection');
  });
});

describe('the sync loop is constructed WITH the sealer (D-2)', () => {
  it('passes sealForOrigin from the user db into createSyncLoop', () => {
    const call = /createSyncLoop\(\{[\s\S]*?\n  \}\);/.exec(syncSource)?.[0] ?? '';
    expect(call).not.toBe('');
    expect(call).toContain('sealForOrigin');
    expect(call).toContain('userDb.sealForOrigin');
  });

  it('reads it through the getter rather than a captured local', () => {
    // `const seal = db.sealForOrigin` at module scope would snapshot the value and go
    // stale the moment protection is toggled — the D-1 failure in a new costume.
    const call = /createSyncLoop\(\{[\s\S]*?\n  \}\);/.exec(syncSource)?.[0] ?? '';
    expect(call).toMatch(/userDb\.sealForOrigin/);
  });

  it('exposes a re-wire entry point for protection changes', () => {
    // Turning protection on mid-session must not leave a running loop pushing
    // plaintext with the sealer it captured at startup.
    expect(syncSource).toContain('export async function resyncAfterProtectionChange');
  });

  it('the protection flows call it', () => {
    const enable = readFileSync(join(SRC, 'vault/enableProtection.ts'), 'utf8');
    expect(enable).toContain('resyncAfterProtectionChange');
    // Both directions: disabling must re-wire too, or exports keep getting sealed with
    // a key derived from a file that is now plaintext.
    expect(enable).toContain('export async function disableProtection');
  });
});
