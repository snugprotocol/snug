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
