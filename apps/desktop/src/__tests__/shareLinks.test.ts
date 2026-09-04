// shareLinks.test.ts — TASK-20260904 AC18: the desktop share-link seat rides the
// deep-link plugin's own two seats, delivers ONLY `snug://s/…` URLs (every other
// scheme is ignored explicitly), and covers the cold-start race through getCurrent.
// The config half: the scheme, the capability and the Cargo plugin are pinned so a
// dropped line is a red test, not a silently dead link.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createOnOpenShareLink, isSnugShareUrl } from '../share-links.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('createOnOpenShareLink', () => {
  it('delivers snug://s/ URLs from onOpenUrl and from getCurrent; ignores every other scheme', async () => {
    let handler: ((urls: string[]) => void) | undefined;
    const deps = {
      onOpenUrl: vi.fn(async (h: (urls: string[]) => void) => {
        handler = h;
        return undefined;
      }),
      getCurrent: vi.fn(async () => ['snug://s/AAAAAAAAAAAAAAAAAAAAAA#' + 'k'.repeat(43), 'https://evil.example/s/x#y']),
    };
    const seen: string[] = [];
    createOnOpenShareLink(deps)((url) => seen.push(url));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['snug://s/AAAAAAAAAAAAAAAAAAAAAA#' + 'k'.repeat(43)]);
    handler?.(['file:///Users/x/user.snug', 'SNUG://s/BBBBBBBBBBBBBBBBBBBBBB#' + 'k'.repeat(43), 'snug://settings']);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/^SNUG:\/\/s\//);
  });

  it('isSnugShareUrl is the only gate before the playground’s strict parse', () => {
    expect(isSnugShareUrl('snug://s/x')).toBe(true);
    expect(isSnugShareUrl('snug://open/x')).toBe(false);
    expect(isSnugShareUrl('https://playground.snugprotocol.org/s/x#y')).toBe(false);
    expect(isSnugShareUrl('file:///x.snug')).toBe(false);
  });

  it('a plugin that rejects (no scheme registered in a dev build) is swallowed — the seat never throws', async () => {
    const deps = { onOpenUrl: vi.fn(async () => { throw new Error('not registered'); }), getCurrent: vi.fn(async () => { throw new Error('nope'); }) };
    expect(() => createOnOpenShareLink(deps)(() => undefined)).not.toThrow();
    await Promise.resolve();
  });
});

describe('the scheme is registered on every layer', () => {
  it('tauri.conf.json declares the snug scheme, the capability grants deep-link:default, Cargo pulls the plugin, lib.rs inits it', () => {
    const conf = JSON.parse(read('../../src-tauri/tauri.conf.json')) as { plugins: { 'deep-link'?: { desktop?: { schemes?: string[] } } } };
    expect(conf.plugins['deep-link']?.desktop?.schemes).toEqual(['snug']);
    const cap = JSON.parse(read('../../src-tauri/capabilities/main.json')) as { permissions: unknown[] };
    expect(cap.permissions).toContain('deep-link:default');
    expect(read('../../src-tauri/Cargo.toml')).toMatch(/^tauri-plugin-deep-link = "2"$/m);
    expect(read('../../src-tauri/src/lib.rs')).toMatch(/tauri_plugin_deep_link::init\(\)/);
    // The open-file allowlist is UNCHANGED: a URL never enters it.
    expect(read('../../src-tauri/src/lib.rs')).toMatch(/to_file_path\(\)\.ok\(\)/);
  });
});
