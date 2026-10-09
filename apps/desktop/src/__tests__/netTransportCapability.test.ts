// @vitest-environment node
// (this suite only reads files off disk; jsdom rewrites import.meta.url to an
//  http URL, which fileURLToPath refuses.)
//
// Tauri HTTP capability scope (TASK-20260812 review finding 2; rewritten by
// TASK-20261008-p0-clearance W3).
//
// What this file can pin is the SET of entries; what they ADMIT is pinned by
// behaviour in Rust (`src-tauri/src/http_scope.rs`, the plugin's own matcher)
// and against the real plugin in the in-shell gate (`src/gate/netScope.ts`).
// The split is the lesson: from 2026-08-12 to this rewrite the file listed
// `http://192.168.*.*:*` & co., a test pinned those strings, and not one of
// them ever matched an address — urlpattern IPv4-parses the fixed digits
// (`192.168.*.*` compiles to the host `192.0.0.168*.*`). A string test cannot
// see that, so the http ranges are exact-octet REGEX hosts now, and the lint
// below refuses the dead star form outright.
//
// The scope is NOT only a belt behind connected-fetch: OAuth token/refresh/
// revoke, the local-model adapter, BYOK, discovery, the relay and the Ollama
// probe call the platform fetch outside connected-fetch's scheme and host-class
// gates, so for them this file is the port and loopback limit (threat-model
// delta, desktop shell). Hence https to any port (R-14: a port is not host
// identity) but DENIED for loopback, 0/8 and every IPv6 literal.
//
// Tauri bakes these scopes at build time, so this JSON is the only place they
// can be stated — hence a test rather than a runtime assertion.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface HttpPermission {
  identifier: string;
  allow: Array<{ url: string }>;
  deny?: Array<{ url: string }>;
}
type Permission = string | HttpPermission;

const capability = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/capabilities/main.json', import.meta.url)), 'utf8'),
) as { windows: string[]; permissions: Permission[] };

const httpPermission = capability.permissions.find(
  (p): p is HttpPermission => typeof p === 'object' && p.identifier === 'http:default',
);
const httpAllow: string[] = (httpPermission?.allow ?? []).map((a) => a.url);
const httpDeny: string[] = (httpPermission?.deny ?? []).map((a) => a.url);

/** One octet, 0-255, no leading zero — the same alphabet as lanfetch::is_rfc1918_ipv4_literal. */
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';

const EXPECTED_HTTP_ALLOW = [
  'https://*:*',
  `http://(10(?:\\.${OCTET}){3}):*`,
  `http://(172\\.(?:1[6-9]|2[0-9]|3[01])(?:\\.${OCTET}){2}):*`,
  `http://(192\\.168(?:\\.${OCTET}){2}):*`,
  'http://127.0.0.1:11434/*',
  'http://127.0.0.1:43120/*',
];
const EXPECTED_HTTP_DENY = [
  'https://((?:[a-z0-9-]+\\.)*localhost\\.?):*',
  `https://(127(?:\\.${OCTET}){3}):*`,
  `https://(0(?:\\.${OCTET}){3}):*`,
  'https://(\\[[0-9a-f:.]+\\]):*',
];

describe('tauri http capability scope', () => {
  it('is scoped to the main window only (C2 — iframes never reach IPC)', () => {
    expect(capability.windows).toEqual(['main']);
  });

  it('allows EXACTLY the closed set — any edit here is a reviewed edit to the desktop net ceiling', () => {
    expect([...httpAllow].sort()).toEqual([...EXPECTED_HTTP_ALLOW].sort());
  });

  it('denies EXACTLY the closed set: https to loopback, 0/8 and IPv6 literals on every port', () => {
    expect([...httpDeny].sort()).toEqual([...EXPECTED_HTTP_DENY].sort());
  });

  it('NEGATIVE lint: no entry uses the dead star form — fixed digits beside a `*` in a hostname', () => {
    // `http://192.168.*.*:*` compiles to the host `192.0.0.168*.*` and matches nothing.
    const dead = [...httpAllow, ...httpDeny].filter((u) => /^[a-z]+:\/\/[^/(]*\d[^/(]*\*/.test(u.replace(/:\*.*$/, '')));
    expect(dead).toEqual([]);
  });

  it('the three RFC-1918 http ranges are regex hosts and nothing else on plain http is open beyond loopback\'s two ports', () => {
    const http = httpAllow.filter((u) => u.startsWith('http://'));
    expect(http.filter((u) => u.startsWith('http://(')).length).toBe(3);
    expect(http.filter((u) => !u.startsWith('http://(')).sort()).toEqual(['http://127.0.0.1:11434/*', 'http://127.0.0.1:43120/*']);
    for (const url of http) {
      expect(url.startsWith('http://localhost')).toBe(false);
      expect(url).not.toBe('http://127.0.0.1:*');
    }
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

  it('the Rust behaviour test reads this same file (the strings here, the matches there)', () => {
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/http_scope.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('include_str!("../capabilities/main.json")');
  });
});

// Opener capability belt (TASK-20260812-desktop-auth-awareness AC3, P1).
//
// The Spotify field defect: `opener:allow-open-url` was granted as a BARE string,
// which per the plugin's permission set enables the open_url command with an
// EMPTY url scope — tauri-plugin-opener's `is_url_allowed` is `any()` over an
// empty vec, so EVERY openUrl invoke (including the https authorize URL) was
// rejected with ForbiddenUrl, deterministically, on every desktop sign-in. The
// vitest suites stayed green because platform-oauth.test.ts mocks ../oauth.js
// wholesale. This belt pins the scope the way the http belt pins its ranges.
describe('tauri opener capability belt', () => {
  const openerPerms = capability.permissions.filter(
    (p) => p === 'opener:allow-open-url' || (typeof p === 'object' && p.identifier === 'opener:allow-open-url'),
  );

  it('grants open_url exactly once, as a SCOPED object — never a bare string (bare = empty scope = every open refused)', () => {
    expect(openerPerms).toHaveLength(1);
    expect(typeof openerPerms[0], 'a bare string grant carries no url scope').toBe('object');
  });

  it('the scope admits https URLs and nothing else (matches oauth.ts openInSystemBrowser https-only guard)', () => {
    const allow = (openerPerms[0] as HttpPermission).allow.map((a) => a.url);
    expect(allow).toEqual(['https://*']);
  });

  it('no broader opener permission sneaks in (opener:default would add reveal-in-dir + mailto/tel)', () => {
    const broad = capability.permissions.filter(
      (p) => p === 'opener:default' || p === 'opener:allow-default-urls',
    );
    expect(broad).toHaveLength(0);
  });
});

// `lan_fetch` command scope + registration (ADR-0023 D3; P0 amendments 6, 16).
//
// The pinned-TLS LAN transport is the shell's one outbound-network command that
// carries a relaxed trust decision inside it, so WHERE it is reachable from is a
// C2 question, not a convenience one. Tauri scopes app-defined commands to the
// windows a capability names, and this capability names exactly `main` — the
// sandboxed app iframes are subframes of that window and hold no invoke key
// (proven per-command by gateIpc.test.ts's `ipc-lan-fetch-refused`).
//
// These tests pin the two things a capability file can state and a refactor can
// silently break: the window scope, and the fact that `lan_fetch` is registered
// in BOTH handler lists (debug and release). The gate commands are
// debug-only-by-design; `lan_fetch` is not, and a copy-paste that put it under
// `#[cfg(debug_assertions)]` would ship a release binary where every Hue
// request fails with "command not found" — green tests, dead feature.
describe('lan_fetch command surface', () => {
  const libSrc = readFileSync(fileURLToPath(new URL('../../src-tauri/src/lib.rs', import.meta.url)), 'utf8');

  it('the capability is scoped to the main window ONLY — app iframes never reach it', () => {
    expect(capability.windows).toEqual(['main']);
  });

  it('is registered in BOTH the debug and release handler lists (a production capability, not a gate)', () => {
    const lists = libSrc.split('invoke_handler(tauri::generate_handler![').slice(1);
    expect(lists, 'lib.rs must carry the two cfg-split handler lists').toHaveLength(2);
    for (const list of lists) {
      const body = list.split('])')[0] ?? '';
      expect(body).toContain('lanfetch::lan_fetch');
    }
  });

  it('the gate commands stay debug-only — lan_fetch must not have dragged them into release', () => {
    const releaseList = (libSrc.split('invoke_handler(tauri::generate_handler![')[2] ?? '').split('])')[0] ?? '';
    expect(releaseList).not.toContain('gate::');
  });

  it('needs no http-capability entry — it does not ride tauri-plugin-http', () => {
    // The pinned transport builds its OWN reqwest client (the plugin's client
    // verifies against the public root store and would refuse the bridge). So
    // the http allowlist above governs the plugin path only, and widening it for
    // Hue would be a change with no effect that future readers would trust.
    expect(httpAllow).not.toContain('https://192.168.*.*:*');
  });
});
