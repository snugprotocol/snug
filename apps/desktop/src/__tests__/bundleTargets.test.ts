// @vitest-environment node
// (this suite only reads files off disk; jsdom rewrites import.meta.url to an
//  http URL, which fileURLToPath refuses.)
//
// Desktop bundle target belt (TASK-20260820-desktop-bundle-targets-macos).
//
// ADR-0021's D8 addendum settled the platform question on 2026-08-20: the shell
// ships macOS-only through alpha, beta and 1.0, because wry's WebView2 backend
// discards `for_main_frame_only` and injects tauri's plaintext invoke key into
// `sandbox="allow-scripts"` app iframes — a C1 AND C2 break with no off-switch at
// the wry, tauri or WebView2 layer. macOS is unaffected (WKWebView honors it).
//
// That addendum then recorded, in its own words, that the decision was "currently
// enforced by documentation alone" — and the threat model states the same gap as
// R-5b. This suite is the other half. The specific drift it kills:
//
//   * `"targets": "all"` — the DEFAULT, and therefore what a regenerated or
//     copy-pasted config lands on — requests `nsis` and `msi` alongside the macOS
//     pair, on a platform where C2 is not merely unproven but KNOWN FALSE.
//   * `icons/icon.ico` shipping in `bundle.icon`: a Windows-only asset in a
//     macOS-only bundle, which a future reader reads as intent. R-5b names it
//     beside `"targets": "all"` as evidence a Windows artifact stays producible.
//   * the icon GENERATOR drifting from the shipped set — `generate-icons.mjs`
//     writes what `bundle.icon` names, so a generator that still emits `icon.ico`
//     puts the file back into a tree whose config no longer names it, on whatever
//     branch next touches the icons.
//
// Tauri bakes bundle config at build time, so this JSON is the only place the
// restriction can be STATED — hence a test rather than a runtime assertion. The
// shape of this file deliberately mirrors netTransportCapability.test.ts, its
// sibling belt over the capability JSON.
//
// Widening any of this is a platform decision, not a build tweak: ADR-0021 D8
// reserves Windows for a post-1.0 ADR of its own. `generate-icons.mjs` keeps the
// win master (it still produces the 32/128 PNGs, which are NOT Windows-only), so
// re-emitting `icon.ico` then is a one-line change, not a lost asset.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

interface TauriConf {
  productName: string;
  identifier: string;
  bundle: {
    active: boolean;
    targets: string | string[];
    icon: string[];
    fileAssociations?: Array<{ ext: string[]; mimeType?: string }>;
  };
}

const conf = JSON.parse(readFileSync(here('../../src-tauri/tauri.conf.json'), 'utf8')) as TauriConf;

/** The two macOS bundle types in tauri's BundleType enum (tauri-utils config.rs). */
const MACOS_TARGETS = ['app', 'dmg'] as const;
/** Every other member of that enum — none may appear. */
const NON_MACOS_TARGETS = ['nsis', 'msi', 'deb', 'rpm', 'appimage'] as const;

describe('desktop bundle targets — macOS only (ADR-0021 D8)', () => {
  it('is an explicit LIST, never the string "all" (the default is the drift)', () => {
    // `"all"` is what the config carried until this task, and what tauri assumes
    // when the key is absent — so this assertion is aimed squarely at the state a
    // regenerated config reverts to, not at a hypothetical hand edit.
    expect(Array.isArray(conf.bundle.targets)).toBe(true);
    expect(conf.bundle.targets).not.toBe('all');
  });

  it('is exactly the two macOS targets', () => {
    expect(conf.bundle.targets).toEqual([...MACOS_TARGETS]);
  });

  it('names no Windows or Linux target — a widening caught however it arrives', () => {
    // Deliberately separate from the deep-equal above: that one fails on ANY change
    // and says only "not equal", while these name the offending platform in the
    // failure message. A reader who adds `nsis` should be told about WebView2.
    //
    // Normalised to an array FIRST, on purpose: `expect('all').not.toContain('nsis')`
    // is a substring check that passes against the exact config this task exists to
    // remove — a green assertion vouching for nothing. `"all"` is expanded to the
    // full enum here so these fail loudly on it, as they must.
    const raw = conf.bundle.targets;
    const targets =
      raw === 'all' ? [...MACOS_TARGETS, ...NON_MACOS_TARGETS] : (raw as string[]);
    for (const target of NON_MACOS_TARGETS) {
      expect(targets, `${target} is a non-macOS bundle target — see ADR-0021 D8`).not.toContain(
        target,
      );
    }
  });

  it('keeps both macOS targets — the restriction must not become a shell that builds nothing', () => {
    const targets = conf.bundle.targets as string[];
    for (const target of MACOS_TARGETS) expect(targets).toContain(target);
  });
});

describe('shipped icon set carries no Windows-only asset', () => {
  it('bundle.icon names no .ico', () => {
    for (const path of conf.bundle.icon) {
      expect(path.toLowerCase().endsWith('.ico'), `${path} is a Windows icon container`).toBe(false);
    }
  });

  it('icon.ico is absent from the tree, not merely unreferenced', () => {
    // Config and working tree can drift apart in either direction; a file nothing
    // names is still a file the next `tauri icon` run treats as part of the set.
    expect(existsSync(here('../../src-tauri/icons/icon.ico'))).toBe(false);
  });

  it('every path bundle.icon names EXISTS (the guard that makes dropping one safe)', () => {
    // Without this, a delete that orphaned a config reference would fail only at
    // bundle time, on macOS, long after the branch that caused it.
    for (const path of conf.bundle.icon) {
      expect(existsSync(here(`../../src-tauri/${path}`)), `${path} is named but absent`).toBe(true);
    }
  });
});

describe('the icon generator agrees with the shipped set', () => {
  // generate-icons.mjs WRITES the icons directory (it clears it, then copies its
  // SHIP list in). So the generator, not the config, has the last word on what is
  // on disk — a generator still emitting icon.ico silently undoes this task the
  // next time anyone regenerates the icons.
  const generator = readFileSync(here('../../scripts/generate-icons.mjs'), 'utf8');
  const shipBlock = (): string => {
    const block = /const SHIP = \[([\s\S]*?)\];/.exec(generator)?.[1];
    expect(block, 'generate-icons.mjs must carry a SHIP list this test can read').toBeDefined();
    return block ?? '';
  };

  it('no longer emits icon.ico', () => {
    // Scoped to the SHIP list, NOT the whole file: the generator's header comment
    // names `icon.ico` on purpose, telling a post-1.0 reader exactly which line to
    // restore if Windows is reconsidered. A whole-file match would forbid writing
    // that down — which is the opposite of what this belt is for.
    expect(shipBlock()).not.toContain('icon.ico');
  });

  it("its SHIP list is bundle.icon's basenames plus icon.png, and nothing else", () => {
    // `icon.png` is the one shipped file `bundle.icon` does NOT name — tauri reads
    // it implicitly as the macOS master, and appIcon.test.ts decodes it. So the two
    // lists are not equal and must not be asserted equal; the relationship is
    // "everything the config names, plus that one implicit mac asset". Pinning the
    // exact difference is what makes this catch a SIXTH file appearing.
    const shipped = [...shipBlock().matchAll(/\['([^']+)'/g)].map((m) => m[1]).sort();
    const configured = conf.bundle.icon.map((p) => p.split('/').pop() ?? p);
    expect(shipped).toEqual([...configured, 'icon.png'].sort());
  });
});

describe('the rest of the bundle block is untouched by the target restriction', () => {
  // A whole-file rewrite is the realistic way this config gets damaged; these pin
  // the identity and the .snug association (ADR-0021 D6) that share the block.
  it('keeps the product identity', () => {
    expect(conf.productName).toBe('Snug');
    expect(conf.identifier).toBe('org.snugprotocol.desktop');
  });

  it('still bundles at all, and still registers the .snug association', () => {
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.fileAssociations?.[0]?.ext).toEqual(['snug']);
  });

  it('does not advertise .snug as a SQLite database (ADR-0043)', () => {
    // A `.snug` used to be a plain SQLite file always, so `application/x-sqlite3` was
    // honest. Since protection shipped it may be a SNUGENC1 container, and telling the
    // desktop environment every `.snug` is an openable database invites other tools to
    // try — then report the user's healthy protected file as corrupt.
    expect(conf.bundle.fileAssociations?.[0]?.mimeType).toBe('application/octet-stream');
  });
});
