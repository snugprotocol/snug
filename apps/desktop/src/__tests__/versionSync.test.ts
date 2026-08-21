// versionSync.test.ts — TASK-20260821-hardening-polish AC9 (ADR-0047 §8).
//
// ONE version, THREE files. The shell's version is declared in package.json,
// src-tauri/tauri.conf.json (the one Tauri bundles and the updater compares), and
// src-tauri/Cargo.toml — with no build-time derivation between them. Before this test,
// nothing failed when they drifted; the updater makes drift consequential (a client
// compares the CONFIG version against latest.json, while humans read package.json).
// The release script bumps all three together; this test is what makes forgetting one
// a red instead of a shipped lie.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

function packageJsonVersion(): string {
  const data = JSON.parse(readFileSync(here('../../package.json'), 'utf8')) as { version?: unknown };
  return String(data.version);
}

function tauriConfVersion(): string {
  const data = JSON.parse(readFileSync(here('../../src-tauri/tauri.conf.json'), 'utf8')) as {
    version?: unknown;
  };
  return String(data.version);
}

function cargoTomlVersion(): string {
  const toml = readFileSync(here('../../src-tauri/Cargo.toml'), 'utf8');
  // The [package] section's version line — the first `version = "…"` in the file,
  // which precedes every [dependencies] entry by Cargo.toml convention here.
  const match = /^version\s*=\s*"([^"]+)"/m.exec(toml);
  return match?.[1] ?? '(missing)';
}

describe('desktop version is single-sourced across its three declarations (AC9)', () => {
  it('package.json, tauri.conf.json and Cargo.toml agree', () => {
    const pkg = packageJsonVersion();
    const conf = tauriConfVersion();
    const cargo = cargoTomlVersion();
    expect(conf, 'tauri.conf.json version must match package.json').toBe(pkg);
    expect(cargo, 'Cargo.toml [package] version must match package.json').toBe(pkg);
  });

  it('the version is a plain semver string (the updater compares semver)', () => {
    expect(packageJsonVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
