// updaterConfig.test.ts — TASK-20260821-hardening-polish AC10 (ADR-0047 §§2-4).
//
// The update channel's config claims, each pinned because nothing else fails when it
// drifts:
//  - `plugins.updater.endpoints` must BYTE-EQUAL the playground's single-homed
//    `DESKTOP_RELEASE_MANIFEST_URL` — tauri.conf.json cannot import TS, so this compare
//    IS the single-homing (one contract, never two artifacts — lessons 2026-07-31).
//    Dependency direction: desktop reads the playground constant via @playground,
//    never the reverse (plan-review finding 16).
//  - `createUpdaterArtifacts` must be on, or `tauri build` ships a DMG with no
//    .app.tar.gz/.sig and the release script's latest.json points at nothing.
//  - The pubkey must be a non-empty minisign key (the artifact-only trust anchor);
//    losing/blanking it silently disables signature verification config-side — the
//    updater refuses to run without one, which surfaces as "updates broken", far from
//    the cause.
//  - The capability must grant `updater:default` + `process:allow-restart` to the MAIN
//    window (the C2 question — can an app IFRAME reach these commands — is answered by
//    the in-shell gate's keyless srcdoc probes, not here: capabilities are per-window,
//    never per-frame, gate/ipc.ts amendment-16 doctrine).
//  - ADR-0021 D8 stands: `bundle.targets` stays macOS-only (bundleTargets.test.ts owns
//    the full claim; the updater block must not have grown a Windows installMode).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DESKTOP_RELEASE_MANIFEST_URL } from '@playground/desktop/releaseChannel.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

interface TauriConf {
  plugins?: { updater?: { pubkey?: unknown; endpoints?: unknown; windows?: unknown } };
  bundle?: { createUpdaterArtifacts?: unknown; targets?: unknown };
}

const conf = JSON.parse(readFileSync(here('../../src-tauri/tauri.conf.json'), 'utf8')) as TauriConf;
const capability = JSON.parse(
  readFileSync(here('../../src-tauri/capabilities/main.json'), 'utf8'),
) as { windows?: unknown; permissions?: unknown };

describe('updater config (AC10)', () => {
  it('the endpoint byte-equals the playground single-homed constant', () => {
    expect(conf.plugins?.updater?.endpoints).toEqual([DESKTOP_RELEASE_MANIFEST_URL]);
  });

  it('updater artifacts are produced by the bundle', () => {
    expect(conf.bundle?.createUpdaterArtifacts).toBe(true);
  });

  it('the pubkey is a non-empty minisign public key', () => {
    const pubkey = conf.plugins?.updater?.pubkey;
    expect(typeof pubkey).toBe('string');
    // A tauri-signer pubkey is base64 of "untrusted comment: …\n<key>" — decode and pin
    // the marker so a pasted path or placeholder cannot pass as a key.
    const decoded = Buffer.from(pubkey as string, 'base64').toString('utf8');
    expect(decoded).toContain('minisign public key');
  });

  it('no Windows updater config exists (ADR-0021 D8 — macOS-only through 1.0)', () => {
    expect(conf.plugins?.updater && 'windows' in (conf.plugins.updater as object)).toBeFalsy();
    expect(conf.bundle?.targets).toEqual(['app', 'dmg']);
  });

  it('the main-window capability grants exactly the updater/process permissions the flow needs', () => {
    expect(capability.windows).toEqual(['main']);
    const permissions = (capability.permissions as unknown[]).filter(
      (p): p is string => typeof p === 'string',
    );
    expect(permissions).toContain('updater:default');
    expect(permissions).toContain('process:allow-restart');
    // The exit permission is deliberately ABSENT: the flow relaunches (after the
    // explicit sidecar reap, ADR-0047 §10); a bare exit seat would be an unused door.
    expect(permissions).not.toContain('process:allow-exit');
    expect(permissions).not.toContain('process:default');
  });
});
