// wizardProvenanceCopy.test.tsx — TASK-20260904 AC8: the wizard's review copy for a
// `shared` row names its author honestly, and (N) never wears the registry's
// "pinned by Snug" copy. The switch is compile-time exhaustive (no default arm for
// known literals) — this file pins the runtime text.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sheet = readFileSync(join(__dirname, '..', 'connections', 'ConnectionWizardSheet.tsx'), 'utf8');

describe('provenanceCopy — the shared channel', () => {
  it('has a shared case whose copy names a third-party author and asks for the host check', () => {
    const start = sheet.indexOf("case 'shared':");
    expect(start).toBeGreaterThan(-1);
    const arm = sheet.slice(start, sheet.indexOf("case 'user':", start));
    expect(arm).toMatch(/a shared app proposed this/);
    expect(arm).toMatch(/its author wrote it, not Snug/);
    expect(arm).toMatch(/Check every host/);
  });

  it('(N) the shared copy is not the registry copy, and the registry copy is unchanged', () => {
    const registryArm = sheet.slice(sheet.indexOf("case 'registry':"), sheet.indexOf("case 'starter':"));
    expect(registryArm).toMatch(/pinned by Snug/);
    const sharedArm = sheet.slice(sheet.indexOf("case 'shared':"), sheet.indexOf("case 'user':"));
    expect(sharedArm).not.toMatch(/pinned by Snug/);
  });

  it('keeps compile-time exhaustiveness (a `never` check) with a runtime fallback for unknown values', () => {
    const fn = sheet.slice(sheet.indexOf('function provenanceCopy'), sheet.indexOf('function consoleUrlIsClickable'));
    expect(fn).toMatch(/const unknown: never = row\.provenance/);
    expect(fn).toMatch(/treat it as unverified/);
  });
});
