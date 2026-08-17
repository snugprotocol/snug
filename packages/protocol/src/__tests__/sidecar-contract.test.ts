// TASK-20260816-whatsapp-twin Phase B.0 (ADR-0032): the sidecar HTTP contract, pinned in
// ONE module that the sidecar, the wizard, the app and the Rust admission all import.
//
// WHY THIS EXISTS AND WHY IT LANDS FIRST. lessons.md (2026-08-03): "Pin every shared
// literal (header names, cookie names, routes, error codes) verbatim in both task files
// before fan-out, or in one imported constants module — two agents invented `x-snug-csrf`
// vs `x-csrf-token` and integrated dead-on-arrival." This contract has FOUR consumers on
// three sides of two process boundaries (webview → Rust → unix socket → Node), so a second
// spelling anywhere is a defect that no single package's suite can see. The plan review
// promoted this module ahead of both the sidecar and the wizard for exactly that reason.
//
// THE SECURITY SHAPE, not merely a route list. Two facts about these routes are
// load-bearing and are asserted here rather than left to prose:
//
//   (1) `/pair/*` is PAIRING-ONLY and never app-reachable. The pairing routes are how a
//       token comes into existence, so an app that could call them could mint itself a
//       credential — the cross-app token-capture attack the Gate-2 adversarial review
//       found. `APP_REACHABLE_SIDECAR_ROUTES` is therefore a strict subset of the
//       contract, and the Rust admission is built from that subset.
//   (2) Every route is METHOD-pinned. Admission matches (method, path), never path alone,
//       so a POST to a read route is refused rather than silently accepted.

import { describe, expect, it } from 'vitest';
import {
  APP_REACHABLE_SIDECAR_ROUTES,
  SIDECAR_AUTH_HEADER,
  SIDECAR_ROUTES,
  SIDECAR_SOCKET_BASENAME,
  isAppReachableSidecarRoute,
  type SidecarRoute,
} from '../sidecar-contract.js';

describe('the route table is a closed, method-pinned set', () => {
  it('pins every route the contract has, with its method', () => {
    // Set equality, not "contains": a route added without a test is a route no consumer
    // agreed to. Adding one here is the deliberate act that lets it exist.
    expect(SIDECAR_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /chats',
        'GET /chats/:jid/history',
        'GET /chats/:jid/messages',
        'POST /chats/:jid/messages',
        'GET /pair/qr',
        'POST /pair/start',
        'GET /pair/status',
        'GET /session/status',
      ].sort(),
    );
  });

  it('uses only GET and POST — no verb the transport does not carry', () => {
    for (const route of SIDECAR_ROUTES) expect(['GET', 'POST']).toContain(route.method);
  });

  it('gives every route a path that is absolute and free of a host', () => {
    // A route that could carry a host is a route that could redirect the transport
    // somewhere else. Paths are paths.
    for (const route of SIDECAR_ROUTES) {
      expect(route.path.startsWith('/')).toBe(true);
      expect(route.path).not.toMatch(/^https?:/);
    }
  });
});

describe('pairing routes are never app-reachable (the token-capture refusal)', () => {
  it('excludes every /pair/ route from the app-reachable subset', () => {
    // THE ATTACK THIS REFUSES: `/pair/status` hands back the access token once, on link.
    // If an app could call it — any app, including a second app the user approved for its
    // own unrelated reasons — it could poll for another app's token and drive the user's
    // WhatsApp. So the app-facing surface is a strict subset, and the Rust admission is
    // generated FROM this subset rather than from the full table.
    for (const route of APP_REACHABLE_SIDECAR_ROUTES) {
      expect(route.path.startsWith('/pair/')).toBe(false);
    }
  });

  it('exposes exactly the four thread routes to apps', () => {
    expect(APP_REACHABLE_SIDECAR_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      ['GET /chats', 'GET /chats/:jid/history', 'GET /chats/:jid/messages', 'POST /chats/:jid/messages'].sort(),
    );
  });

  it('is a strict subset of the full contract — never a parallel list', () => {
    // Derived, not retyped: if these were two hand-written arrays they could disagree,
    // and the disagreement would be invisible until an app hit a route nobody meant it to.
    for (const route of APP_REACHABLE_SIDECAR_ROUTES) expect(SIDECAR_ROUTES).toContainEqual(route);
    expect(APP_REACHABLE_SIDECAR_ROUTES.length).toBeLessThan(SIDECAR_ROUTES.length);
  });

  it('refuses `/session/status` to apps — it is the wizard verify seat', () => {
    // ADR-0025's verify-before-claim read belongs to the wizard, which fires it with the
    // just-minted token before claiming connected. An app has no business proving the
    // connection; it just uses it.
    expect(isAppReachableSidecarRoute('GET', '/session/status')).toBe(false);
  });
});

describe('isAppReachableSidecarRoute — the predicate the Rust admission mirrors', () => {
  it('admits an exact app route', () => {
    expect(isAppReachableSidecarRoute('GET', '/chats')).toBe(true);
  });

  it('admits a parameterised route with a concrete jid', () => {
    expect(isAppReachableSidecarRoute('GET', '/chats/123456@g.us/messages')).toBe(true);
    expect(isAppReachableSidecarRoute('POST', '/chats/123456@g.us/messages')).toBe(true);
  });

  it('matches on METHOD as well as path', () => {
    // A POST to a read route must not ride the read route's admission.
    expect(isAppReachableSidecarRoute('POST', '/chats')).toBe(false);
    expect(isAppReachableSidecarRoute('POST', '/chats/1@g.us/history')).toBe(false);
  });

  it('refuses every pairing route by both verbs', () => {
    expect(isAppReachableSidecarRoute('POST', '/pair/start')).toBe(false);
    expect(isAppReachableSidecarRoute('GET', '/pair/qr')).toBe(false);
    expect(isAppReachableSidecarRoute('GET', '/pair/status')).toBe(false);
  });

  it('refuses prefix-extension and unknown paths', () => {
    // Fixtures hostile to the mechanism (lessons.md 2026-08-13): each of these is a way a
    // naive prefix or substring match would say yes.
    for (const path of ['/chatsX', '/chats/1@g.us/messages/extra', '/', '', '//chats', '/CHATS']) {
      expect(isAppReachableSidecarRoute('GET', path), `path ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('refuses a traversal segment that the ROUTE PATTERN would otherwise admit', () => {
    // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Deleting the traversal refusal left
    // the whole file green, because every traversal fixture here was ALSO refused by the
    // anchored matcher — so the fixtures were testing the matcher twice and the traversal
    // guard never once (lessons.md 2026-08-13: "when a mutation stays green, suspect the
    // fixture before the mutation"; 2026-08-04: "a refusal's test input must pass every
    // SIBLING refusal and fail only the one under test").
    //
    // `..` is a LEGAL single path segment, so `/chats/../messages` matches
    // `/chats/:jid/messages` exactly. Only the traversal refusal stands between it and
    // admission — and once it reaches a socket, `..` is resolved by whatever serves it.
    for (const path of ['/chats/../messages', '/chats/../history']) {
      expect(isAppReachableSidecarRoute('GET', path), `path ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('refuses PERCENT-ENCODED traversal, which a literal `..` scan misses', () => {
    // The attacker picks the spelling (lessons.md 2026-08-11: "neutralize the delimiter
    // PRIMITIVE, not one spelling"). `%2e%2e` is `..` and `%2f` is `/` to anything that
    // decodes before resolving, so a guard that only scans for a literal `..` refuses the
    // obvious form and admits the same attack one encoding over.
    for (const path of [
      '/chats/%2e%2e/messages',
      '/chats/%2E%2E/messages',
      '/chats/..%2fpair%2fstatus/messages',
      '/chats/%2e%2e%2fpair/messages',
    ]) {
      expect(isAppReachableSidecarRoute('GET', path), `path ${JSON.stringify(path)}`).toBe(false);
    }
  });

  it('refuses a jid segment that is empty or contains a slash', () => {
    expect(isAppReachableSidecarRoute('GET', '/chats//messages')).toBe(false);
    expect(isAppReachableSidecarRoute('GET', '/chats/a/b/messages')).toBe(false);
  });

  it('ignores query strings when matching the route, and never admits by them', () => {
    // `?since=` and `?cursor=` are contract parameters; they must not widen the match.
    expect(isAppReachableSidecarRoute('GET', '/chats/1@g.us/messages?since=42')).toBe(true);
    expect(isAppReachableSidecarRoute('GET', '/pair/status?x=1')).toBe(false);
  });
});

describe('the transport identifiers', () => {
  it('names the auth header once', () => {
    // ONE spelling. The Node side reads it, the wizard writes it, the registry's
    // headerTemplate references it — a second spelling integrates dead on arrival.
    expect(SIDECAR_AUTH_HEADER).toBe('authorization');
  });

  it('names a socket BASENAME, never a path the webview could choose', () => {
    // The directory is the Rust side's to decide (it owns ~/Snug, as the user-file
    // commands already do). If the webview could name a path, it could point the
    // transport at any socket on the machine — the same class of defect as letting it
    // name a host. A basename with no separators cannot express one.
    expect(SIDECAR_SOCKET_BASENAME).not.toContain('/');
    expect(SIDECAR_SOCKET_BASENAME).not.toContain('\\');
    expect(SIDECAR_SOCKET_BASENAME).not.toContain('..');
    expect(SIDECAR_SOCKET_BASENAME.length).toBeGreaterThan(0);
  });

  it('types a route as its literal method union', () => {
    // Compile-level pin: a route object is not a loose {string,string}.
    const route: SidecarRoute = { method: 'GET', path: '/chats' };
    expect(route.method).toBe('GET');
  });
});
