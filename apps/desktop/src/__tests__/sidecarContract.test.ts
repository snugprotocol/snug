// @vitest-environment node
// (this suite only reads files off disk; jsdom rewrites import.meta.url to an
//  http URL, which fileURLToPath refuses.)
//
// TASK-20260816-whatsapp-twin Phase G (ADR-0032): the cross-language equivalence check.
//
// WHY THIS FILE EXISTS. `sidecar.rs` restates the app-reachable route table that
// `packages/protocol/src/sidecar-contract.ts` owns, because this crate sits on the far side
// of an IPC boundary and cannot import TypeScript. That is the same deliberate duplication
// `is_rfc1918_ipv4_literal` carries — and the codebase's own rule for it is that a
// duplicate is only safe when a test PROVES the two agree (`lan-class-registry.test.ts:452`
// does exactly this for the LAN class).
//
// Without this, the two tables drift the first time someone adds a route on one side. The
// drift would be silent and the failure mode is asymmetric: a route the TS side admits and
// Rust refuses is a mysteriously broken app, while a route Rust admits and TS does not is a
// hole in the admission the whole design rests on.
//
// lessons.md (2026-07-31): "One contract must never live in two artifacts by convention —
// inject from one source or byte-compare in CI; for CI-only artifacts no local suite
// executes, DERIVE the value by parsing the source of truth and pin the derivation with a
// fast local test."

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_REACHABLE_SIDECAR_ROUTES, SIDECAR_ROUTES } from '@snugprotocol/protocol';

const RUST_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/sidecar.rs', import.meta.url)),
  'utf8',
);

/** Parse the `APP_ROUTES` table out of the Rust source — derived, never retyped here. */
function rustAppRoutes(): Array<{ method: string; path: string }> {
  const block = /const APP_ROUTES:[^=]*=\s*\[([\s\S]*?)\];/.exec(RUST_SOURCE);
  if (block?.[1] === undefined) throw new Error('could not find APP_ROUTES in sidecar.rs');
  return [...block[1].matchAll(/\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((match) => ({
    method: match[1]!,
    path: match[2]!,
  }));
}

describe('the Rust route table matches the protocol contract exactly', () => {
  it('admits the same app routes the contract module admits', () => {
    const rust = rustAppRoutes()
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const typescript = APP_REACHABLE_SIDECAR_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(rust).toEqual(typescript);
  });

  it('parsed a non-empty table — a regex that matched nothing would pass vacuously', () => {
    // Without this, a rename in the Rust source turns the check above into
    // `[].toEqual([])`... which it would not be, since the TS side is non-empty. Belt: if
    // BOTH ever became empty the equality would still hold and prove nothing.
    expect(rustAppRoutes().length).toBeGreaterThan(0);
    expect(APP_REACHABLE_SIDECAR_ROUTES.length).toBeGreaterThan(0);
  });

  it('never lists a pairing or session route in the Rust app table', () => {
    // The refusal restated at the boundary that enforces it. Rust is what stands between an
    // app and the token-releasing routes, so its table is the one that must not contain them.
    for (const route of rustAppRoutes()) {
      expect(route.path.startsWith('/pair/'), `${route.path} must not be app-reachable`).toBe(false);
      expect(route.path.startsWith('/session/'), `${route.path} must not be app-reachable`).toBe(false);
    }
  });

  it('leaves the wizard-only routes present in the FULL contract', () => {
    // The other half: they are refused to apps, not deleted. The wizard still needs them.
    const all = SIDECAR_ROUTES.map((route) => route.path);
    expect(all).toContain('/pair/status');
    expect(all).toContain('/session/status');
  });
});

describe('the Rust module holds the guards the design depends on', () => {
  it('refuses traversal on the DECODED path, not one spelling', () => {
    // Pinned as source structure because the cargo suite proves the behavior and this
    // suite proves the behavior is reached from the shipped module — a decode step that
    // was deleted would leave the cargo tests green only if they were deleted too.
    expect(RUST_SOURCE).toMatch(/fn decode_path/);
    expect(RUST_SOURCE).toMatch(/SidecarRefusal::Traversal/);
  });

  it('caps the response size before bytes cross IPC', () => {
    expect(RUST_SOURCE).toMatch(/MAX_RESPONSE_BYTES/);
  });

  it('names the socket path itself rather than accepting one', () => {
    // A webview that could name the socket could point this transport at any socket on the
    // machine — the same class of defect as letting it name a host.
    expect(RUST_SOURCE).toMatch(/fn socket_path/);
  });
});
