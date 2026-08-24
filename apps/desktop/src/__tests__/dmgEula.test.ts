// @vitest-environment node
// (reads files off disk; jsdom rewrites import.meta.url to an http URL, which
//  fileURLToPath refuses — the bundleTargets.test.ts precedent.)
//
// dmgEula.test.ts — TASK-20260823-legal-terms-privacy-eula AC10 (ADR-0055 §2).
//
// The DMG's license screen is the product's ONE clickwrap. Tauri embeds
// `bundle.licenseFile` as the disk image's SLA resource (tauri-bundler dmg/mod.rs →
// bundle_dmg.sh --eula → hdiutil udifrez), so the config and the file are the whole
// mechanism — and, like bundleTargets.test.ts, a test is the only place the contract
// can be STATED. What this belt pins:
//
//   * `bundle.licenseFile` names a file that exists (a dropped key ships a DMG with no
//     Agree screen and nothing else fails);
//   * that file is a BYTE-COPY of `legal/eula.ts`'s EULA_TEXT — one source, rendered
//     offline in Settings → about and embedded in the installer (review F2);
//   * the text passes `checkEulaText` — defined ONCE in scripts/release-desktop.mjs and
//     imported here (review F14; the release script runs the same function before it
//     builds): ASCII only (the SLA resource is classic TEXT — a curly quote or an em dash
//     renders as garbage in the installer window), short lines, a hard line budget;
//   * the MIT grant + disclaimer are LICENSE's own words, whitespace-collapsed;
//   * the R-30 sentence and its pairing are byte-identical (collapsed) to the playground
//     constants — one contract, two artifacts (updaterConfig.test.ts's discipline);
//   * every disclosure the plan requires is present, and NOTHING ELSE is (a section
//     allowlist — it is a screen someone reads standing up);
//   * the claim-discipline checker finds nothing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { findClaimViolations } from '@playground/legal/claimDiscipline.js';
import { EULA_TEXT } from '@playground/legal/eula.js';
import {
  MIT_DISCLAIMER,
  MIT_GRANT,
  PRIVACY_URL,
  TERMS_URL,
  UPDATE_CHECK_DISCLOSURE,
  UPDATE_CHECK_PAIRING,
  WE_US_OUR_DEFINITION,
} from '@playground/legal/legalShared.js';

import { EULA_LINE_BUDGET, EULA_MAX_COLUMNS, checkEulaText } from '../../../../scripts/release-desktop.mjs';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface TauriConf {
  bundle: { licenseFile?: unknown };
}

const conf = JSON.parse(readFileSync(here('../../src-tauri/tauri.conf.json'), 'utf8')) as TauriConf;
const LICENSE = readFileSync(here('../../../../LICENSE'), 'utf8');

describe('the DMG carries the EULA (config)', () => {
  it('bundle.licenseFile names EULA.txt beside the config', () => {
    expect(conf.bundle.licenseFile).toBe('EULA.txt');
  });

  it('that file exists (tauri resolves it against src-tauri/ — the cli chdirs there before bundling)', () => {
    expect(existsSync(here('../../src-tauri/EULA.txt'))).toBe(true);
  });
});

describe('EULA.txt is a byte-copy of legal/eula.ts (one source, two consumers)', () => {
  it('byte-equal to EULA_TEXT', () => {
    const onDisk = readFileSync(here('../../src-tauri/EULA.txt'), 'utf8');
    expect(onDisk).toBe(EULA_TEXT);
  });
});

describe('the text itself (checkEulaText — the release script\'s own rule)', () => {
  it('passes the shape check: ASCII only, short lines, under budget', () => {
    expect(checkEulaText(EULA_TEXT)).toEqual({ ok: true });
  });

  it('the shape check is not decorative: it refuses non-ASCII, long lines, and too many lines', () => {
    expect(checkEulaText(EULA_TEXT.replace('"AS IS"', '“AS IS”')).ok).toBe(false);
    expect(checkEulaText(EULA_TEXT.replace(' - ', ' — ')).ok).toBe(false);
    expect(checkEulaText(`${EULA_TEXT}${'x'.repeat(EULA_MAX_COLUMNS + 1)}\n`).ok).toBe(false);
    expect(checkEulaText(`${EULA_TEXT}${'\n'.repeat(EULA_LINE_BUDGET)}`).ok).toBe(false);
    expect(checkEulaText('')).toMatchObject({ ok: false });
  });

  it('the line budget has headroom over the accepted draft, and the draft is short', () => {
    // Derived from the draft with headroom (review F15) — the number is a statement
    // about THIS text, not a hope about a future one.
    const lines = EULA_TEXT.split('\n').length;
    expect(lines).toBeLessThanOrEqual(EULA_LINE_BUDGET);
    expect(EULA_LINE_BUDGET - lines).toBeGreaterThanOrEqual(3);
    expect(EULA_LINE_BUDGET).toBeLessThanOrEqual(60);
  });

  it('quotes the MIT grant and disclaimer in LICENSE\'s own words', () => {
    expect(collapse(EULA_TEXT)).toContain(collapse(MIT_GRANT));
    expect(collapse(EULA_TEXT)).toContain(collapse(MIT_DISCLAIMER));
    // …and those ARE LICENSE's words (the constants are pinned to the file elsewhere,
    // but a desktop reader should not have to trust that).
    expect(collapse(LICENSE)).toContain(collapse(MIT_DISCLAIMER));
  });

  it('carries the R-30 sentence and its pairing byte-identical to the playground constants', () => {
    expect(collapse(EULA_TEXT)).toContain(collapse(UPDATE_CHECK_DISCLOSURE));
    expect(collapse(EULA_TEXT)).toContain(collapse(UPDATE_CHECK_PAIRING));
  });

  it('names the parties with the shared definition, and points at the public terms + privacy', () => {
    expect(collapse(EULA_TEXT)).toContain(collapse(WE_US_OUR_DEFINITION));
    expect(EULA_TEXT).toContain(TERMS_URL);
    expect(EULA_TEXT).toContain(PRIVACY_URL);
  });

  it('carries every required disclosure — and only those sections', () => {
    const text = collapse(EULA_TEXT);
    expect(text).toMatch(/helper on this computer/i); // local helper
    expect(text).toMatch(/starts with the app/i); // …that autostarts once linked (review F3)
    expect(text).toMatch(/devices on your own network/i); // LAN reach
    expect(text).toMatch(/~\/Snug/); // where the data lives
    expect(text).toMatch(/keys included/i); // the sync-origin warning
    expect(text).toMatch(/pre-release/i);
    expect(text).toMatch(/USD 50/);
    expect(text).toMatch(/section 1668/); // ASCII: never "§"
    expect(text).toMatch(/California law governs/);
    expect(text).toMatch(/Clicking Agree means you accept these terms\./);

    // The section allowlist: a screen someone reads standing up grows only by decision.
    const headings = [...EULA_TEXT.matchAll(/^([A-Z][A-Z0-9 .\-]+)\. /gm)].map((m) => m[1]);
    expect(headings).toEqual(['LICENSE', 'UPDATE CHECK', 'LOCAL HELPER AND YOUR NETWORK', 'YOUR DATA', 'PRE-1.0', 'LIABILITY']);
  });

  it('makes no forbidden or unbounded claim (claimDiscipline — the same rule as /terms and /privacy)', () => {
    expect(findClaimViolations(EULA_TEXT)).toEqual([]);
  });
});
