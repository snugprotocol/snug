// @vitest-environment node
// (this suite only reads files off disk; jsdom rewrites import.meta.url to an
//  http URL, which fileURLToPath refuses.)
//
// Tauri HTTP capability belt (TASK-20260812 review finding 2).
//
// The capability scope is BELT, not policy — the real ceiling is the
// connected-fetch executor's frozen per-connection allowlist, exactly as in the
// browser where page fetch is unscoped too. But a belt that claims to be narrow
// and is not is worse than an honest wide one, because the threat-model delta
// and ADR-0021 both cite it. The specific drift these tests kill:
//
//   * `http://172.*.*.*:*` covers ALL of 172/8 — 172.0.x through 172.255.x —
//     when RFC 1918 is only 172.16-31. That admitted ~15/16ths of a /8 of
//     PUBLIC address space over cleartext http. The sixteen private /16s are
//     enumerated instead.
//   * blanket `http://localhost:*` and `http://127.0.0.1:*` admitted every
//     loopback service on the machine. connected-fetch refuses loopback
//     outright (gate 5, isForbiddenNetHost), so nothing legitimate wanted them.
//     Only two single-purpose loopback ports remain: the Ollama probe (11434)
//     and the debug gate's net stub (43120).
//
// Tauri bakes these scopes at build time, so this JSON is the only place they
// can be stated — hence a test rather than a runtime assertion.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface HttpPermission {
  identifier: string;
  allow: Array<{ url: string }>;
}
type Permission = string | HttpPermission;

const capability = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/capabilities/main.json', import.meta.url)), 'utf8'),
) as { windows: string[]; permissions: Permission[] };

const httpAllow: string[] = (() => {
  const perm = capability.permissions.find(
    (p): p is HttpPermission => typeof p === 'object' && p.identifier === 'http:default',
  );
  return (perm?.allow ?? []).map((a) => a.url);
})();

describe('tauri http capability belt', () => {
  it('is scoped to the main window only (C2 — iframes never reach IPC)', () => {
    expect(capability.windows).toEqual(['main']);
  });

  it('enumerates the sixteen RFC-1918 172.16-31 /16s and never the whole 172/8', () => {
    expect(httpAllow).not.toContain('http://172.*.*.*:*');
    for (let octet = 16; octet <= 31; octet += 1) {
      expect(httpAllow).toContain(`http://172.${octet}.*.*:*`);
    }
    // Public neighbours of the private block must have no entry of their own.
    for (const octet of [0, 15, 32, 217, 255]) {
      expect(httpAllow).not.toContain(`http://172.${octet}.*.*:*`);
    }
  });

  it('admits the other two RFC-1918 ranges over http', () => {
    expect(httpAllow).toContain('http://10.*.*.*:*');
    expect(httpAllow).toContain('http://192.168.*.*:*');
  });

  it('has NO blanket loopback or localhost http entry', () => {
    for (const url of httpAllow) {
      expect(url).not.toBe('http://localhost:*');
      expect(url).not.toBe('http://127.0.0.1:*');
      expect(url.startsWith('http://localhost')).toBe(false);
    }
  });

  it('admits loopback http ONLY on the two named single-purpose ports', () => {
    const loopback = httpAllow.filter((u) => u.startsWith('http://127.0.0.1'));
    expect(loopback.sort()).toEqual(['http://127.0.0.1:11434/*', 'http://127.0.0.1:43120/*']);
  });

  it('keeps the debug gate reachable — the stub port the gate driver targets', () => {
    // gate/run-gate.mjs remaps the journey host to http://127.0.0.1:<STUB_PORT>,
    // default 43120. Scopes are build-time, so the gate cannot widen this at run
    // time: if that default ever changes, this test fails before the gate does.
    const gateSrc = readFileSync(fileURLToPath(new URL('../../gate/run-gate.mjs', import.meta.url)), 'utf8');
    const defaultPort = /SNUG_GATE_STUB_PORT\s*\?\?\s*(\d+)/.exec(gateSrc)?.[1];
    expect(defaultPort).toBe('43120');
    expect(httpAllow).toContain(`http://127.0.0.1:${defaultPort}/*`);
  });

  it('still allows https to any host (the LAN rung is http-only widening)', () => {
    expect(httpAllow).toContain('https://**');
  });
});
