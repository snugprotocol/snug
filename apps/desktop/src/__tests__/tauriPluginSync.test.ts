// tauriPluginSync.test.ts — TASK-20261024-desktop-v0.1.4.
//
// `tauri build` refuses when an `@tauri-apps/*` npm package and its Rust crate sit on
// different major.minor releases ("Found version mismatched Tauri packages"). CI never
// runs `tauri build` — only the release script does — so the v0.1.4 release found
// @tauri-apps/plugin-notification 2.5.1 against tauri-plugin-notification 2.4.0 at the
// very end of the pipeline. This test applies the same rule to the two lockfiles, so
// the drift is a red on the PR that introduces it instead of a failed release.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** Crate name → locked version, from src-tauri/Cargo.lock. */
function cargoLockVersions(): Map<string, string> {
  const lock = readFileSync(here('../../src-tauri/Cargo.lock'), 'utf8');
  const versions = new Map<string, string>();
  for (const match of lock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"/gm)) {
    versions.set(match[1], match[2]);
  }
  return versions;
}

/** `@tauri-apps/*` package → resolved version, from the apps/desktop importer of pnpm-lock.yaml. */
function desktopTauriNpmVersions(): Map<string, string> {
  const lock = readFileSync(here('../../../../pnpm-lock.yaml'), 'utf8');
  const start = lock.indexOf('\n  apps/desktop:\n');
  expect(start, 'pnpm-lock.yaml has an apps/desktop importer').toBeGreaterThan(-1);
  const rest = lock.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  const versions = new Map<string, string>();
  for (const match of block.matchAll(/^ {6}'(@tauri-apps\/[^']+)':\n {8}specifier: .*\n {8}version: (\d+\.\d+\.\d+)/gm)) {
    versions.set(match[1], match[2]);
  }
  return versions;
}

/** The crate tauri's own check pairs with an npm package; undefined when it has none. */
function crateFor(npmName: string): string | undefined {
  const short = npmName.slice('@tauri-apps/'.length);
  if (short === 'cli') return undefined;
  if (short === 'api') return 'tauri';
  return `tauri-${short}`;
}

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.');

describe('every @tauri-apps package matches its crate on major.minor (the tauri build check)', () => {
  const npm = desktopTauriNpmVersions();
  const crates = cargoLockVersions();

  it('finds the desktop’s tauri packages in the lockfile', () => {
    expect(npm.has('@tauri-apps/api')).toBe(true);
    expect(npm.has('@tauri-apps/plugin-notification')).toBe(true);
  });

  it('pairs agree', () => {
    const mismatches: string[] = [];
    for (const [name, version] of npm) {
      const crate = crateFor(name);
      if (crate === undefined) continue;
      const crateVersion = crates.get(crate);
      if (crateVersion === undefined) {
        mismatches.push(`${name} ${version} has no ${crate} in Cargo.lock`);
      } else if (majorMinor(crateVersion) !== majorMinor(version)) {
        mismatches.push(`${crate} (v${crateVersion}) : ${name} (v${version})`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
