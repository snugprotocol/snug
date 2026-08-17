// TASK-20260816-whatsapp-twin Phase C (ADR-0032): the sidecar's request router.
//
// WHAT THIS PROCESS IS. A helper that holds a WhatsApp linked-device session — the same
// kind of link WhatsApp Web makes — and exposes the small enumerated contract from
// `@snugprotocol/protocol`'s sidecar-contract module over a unix socket. It is
// deliberately LLM-FREE: every analysis or compose turn runs in the governed host, so this
// process is transport and custody, never a second brain (the "LLM calls originate from the
// host page only" invariant).
//
// THE THREE PROPERTIES WORTH TESTING HARD, all of them refusals:
//
//   (1) EVERY route requires the token, `/pair/*` INCLUDED. The first draft of this task
//       said "every non-pair route 401s", which would have made the pairing routes an
//       unauthenticated token-disclosure surface: `GET /pair/status` hands the token back,
//       so anything able to call it could mint itself a credential. The wizard holds the
//       spawn nonce and that is what gets it through.
//   (2) NO route ever serializes WhatsApp session key material. The credential the host
//       holds is a key to THIS HELPER, never a key to the user's WhatsApp — that split is
//       the whole C1 story of ADR-0032, and it is only true if the keys never cross the
//       wire. Asserted against a populated, real-shaped auth store rather than an empty one.
//   (3) Thread scoping is enforced HERE. An app authorized for one thread must not read
//       another by asking for it; the request path is not a suggestion.

import { describe, expect, it, beforeEach } from 'vitest';
import { createRouter, type RouterDeps } from '../router.js';
import { createFakeWaSocket, type FakeWaSocket } from './fake-wa-socket.js';
import { createMemoryStore } from '../store.js';

const NONCE = 'spawn-nonce-from-sidecar-ctl';

/**
 * Deps whose `socket` keeps the FAKE's type, not the seam's.
 *
 * `RouterDeps.socket` is a `WaSocket` — deliberately narrow, since the router must not be
 * able to reach scripting handles. But a test needs `emitLinked`/`seedChat`, so the helper
 * returns the wider type and passes it where the narrower one is expected. That direction
 * is safe (the fake IS a WaSocket) and it keeps the production seam honest.
 */
type TestDeps = Omit<RouterDeps, 'socket'> & { socket: FakeWaSocket };

function deps(overrides: Partial<TestDeps> = {}): TestDeps {
  return {
    socket: createFakeWaSocket(),
    store: createMemoryStore(),
    spawnNonce: NONCE,
    mintToken: () => 'minted-token-value',
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

/** Link the session and return the router plus the token the wizard would hold. */
async function linked(routerDeps = deps()) {
  const router = createRouter(routerDeps);
  await router.handle({ method: 'POST', path: '/pair/start', headers: { 'x-snug-spawn-nonce': NONCE } });
  routerDeps.socket.emitLinked();
  const status = await router.handle({
    method: 'GET',
    path: '/pair/status',
    headers: { 'x-snug-spawn-nonce': NONCE },
  });
  return { router, deps: routerDeps, token: (status.body as { token?: string }).token! };
}

describe('every route requires the token — /pair/* included', () => {
  let router: ReturnType<typeof createRouter>;
  beforeEach(() => {
    router = createRouter(deps());
  });

  it('401s an app route with no token', async () => {
    const res = await router.handle({ method: 'GET', path: '/chats', headers: {} });
    expect(res.status).toBe(401);
  });

  it('401s the PAIRING routes with neither token nor nonce (the token-disclosure refusal)', async () => {
    // THE ATTACK: `/pair/status` releases the token. If this were open, anything that could
    // reach the socket could mint itself a credential and drive the user's WhatsApp.
    for (const [method, path] of [
      ['POST', '/pair/start'],
      ['GET', '/pair/qr'],
      ['GET', '/pair/status'],
    ] as const) {
      const res = await router.handle({ method, path, headers: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('401s the verify route with no token', async () => {
    const res = await router.handle({ method: 'GET', path: '/session/status', headers: {} });
    expect(res.status).toBe(401);
  });

  it('refuses a WRONG token, and does not leak whether one exists', async () => {
    const { router: live } = await linked();
    const res = await live.handle({
      method: 'GET',
      path: '/chats',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('minted-token-value');
  });

  it('refuses a wrong spawn nonce on the pairing routes', async () => {
    const res = await router.handle({
      method: 'POST',
      path: '/pair/start',
      headers: { 'x-snug-spawn-nonce': 'guessed' },
    });
    expect(res.status).toBe(401);
  });
});

describe('pairing mints exactly one token', () => {
  it('releases the token only after the device is actually linked', async () => {
    const d = deps();
    const router = createRouter(d);
    await router.handle({ method: 'POST', path: '/pair/start', headers: { 'x-snug-spawn-nonce': NONCE } });

    // Before the scan: no token, and the wizard is told to keep waiting rather than
    // handed a null it might mistake for a value.
    const pending = await router.handle({
      method: 'GET',
      path: '/pair/status',
      headers: { 'x-snug-spawn-nonce': NONCE },
    });
    expect(pending.status).toBe(200);
    expect((pending.body as { state: string }).state).toBe('waiting');
    expect((pending.body as { token?: string }).token).toBeUndefined();

    d.socket.emitLinked();
    const done = await router.handle({
      method: 'GET',
      path: '/pair/status',
      headers: { 'x-snug-spawn-nonce': NONCE },
    });
    expect((done.body as { state: string }).state).toBe('linked');
    expect((done.body as { token?: string }).token).toBe('minted-token-value');
  });

  it('does not re-mint on a second poll — one link, one token', async () => {
    // A route that re-mints on every read is a route that invalidates the wizard's
    // credential behind its back, and hands out a fresh secret to every caller.
    const { router, deps: d, token } = await linked();
    const again = await router.handle({
      method: 'GET',
      path: '/pair/status',
      headers: { 'x-snug-spawn-nonce': NONCE },
    });
    expect((again.body as { token?: string }).token).toBe(token);
    expect(d.store.mintCount()).toBe(1);
  });

  it('the STORE refuses a second mint even if a caller asks directly', async () => {
    // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Removing the store's overwrite guard
    // left every test green, because the router only calls `setToken` when it already
    // believes no token exists — the router's check MASKED the store's, so the store's
    // guard was pure decoration that nothing exercised.
    //
    // Two guards for one property is deliberate (the router avoids the call; the store
    // refuses it anyway), but a defense that no test can distinguish from its absence is
    // not a defense — it is a comment. Driving the store directly is what separates them.
    const store = createMemoryStore();
    store.setToken('first');
    store.setToken('second');
    expect(store.token()).toBe('first');
    expect(store.mintCount()).toBe(1);
  });

  it('serves the QR payload while waiting, and stops once linked', async () => {
    const d = deps();
    const router = createRouter(d);
    await router.handle({ method: 'POST', path: '/pair/start', headers: { 'x-snug-spawn-nonce': NONCE } });
    d.socket.emitQr('QR-PAYLOAD-1');
    const qr = await router.handle({ method: 'GET', path: '/pair/qr', headers: { 'x-snug-spawn-nonce': NONCE } });
    expect((qr.body as { qr?: string }).qr).toBe('QR-PAYLOAD-1');

    d.socket.emitLinked();
    const after = await router.handle({
      method: 'GET',
      path: '/pair/qr',
      headers: { 'x-snug-spawn-nonce': NONCE },
    });
    expect((after.body as { qr?: string }).qr).toBeUndefined();
  });
});

describe('NO route serializes WhatsApp session key material (C1)', () => {
  it('keeps real-shaped credentials out of every response', async () => {
    // A POPULATED store, not an empty one: a leak test against a store with nothing in it
    // passes for the wrong reason (lessons.md — a fixture that cannot fail tests nothing).
    const d = deps();
    d.store.setAuthState({
      creds: {
        noiseKey: { private: 'NOISE-PRIVATE-SECRET', public: 'NOISE-PUBLIC' },
        signedIdentityKey: { private: 'IDENTITY-PRIVATE-SECRET', public: 'IDENTITY-PUBLIC' },
        signedPreKey: { keyPair: { private: 'PREKEY-PRIVATE-SECRET' } },
        registrationId: 42,
        me: { id: '15551234567@s.whatsapp.net', name: 'Owner' },
      },
      keys: { 'session-15551234567': 'SESSION-RECORD-SECRET' },
    });
    const { router, token } = await linked(d);
    d.socket.seedChat('123@g.us', [{ id: 'm1', from: '15559999999@s.whatsapp.net', text: 'hello', ts: 1 }]);

    const secrets = [
      'NOISE-PRIVATE-SECRET',
      'IDENTITY-PRIVATE-SECRET',
      'PREKEY-PRIVATE-SECRET',
      'SESSION-RECORD-SECRET',
    ];
    for (const [method, path] of [
      ['GET', '/session/status'],
      ['GET', '/chats'],
      ['GET', '/chats/123@g.us/history'],
      ['GET', '/chats/123@g.us/messages'],
    ] as const) {
      const res = await router.handle({ method, path, headers: { authorization: `Bearer ${token}` } });
      const serialized = JSON.stringify(res.body ?? {});
      for (const secret of secrets) {
        expect(serialized, `${method} ${path} leaked ${secret}`).not.toContain(secret);
      }
    }
  });

  it('does not echo the access token back on any app route', async () => {
    const { router, token } = await linked();
    const res = await router.handle({ method: 'GET', path: '/chats', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.stringify(res.body ?? {})).not.toContain(token);
  });
});

describe('the app surface is thread-scoped and bounded', () => {
  it('reads a thread the caller names, and only that thread', async () => {
    const { router, deps: d, token } = await linked();
    d.socket.seedChat('111@g.us', [{ id: 'a1', from: 'x@s.whatsapp.net', text: 'in-111', ts: 1 }]);
    d.socket.seedChat('222@g.us', [{ id: 'b1', from: 'y@s.whatsapp.net', text: 'in-222', ts: 2 }]);

    const res = await router.handle({
      method: 'GET',
      path: '/chats/111@g.us/messages',
      headers: { authorization: `Bearer ${token}` },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain('in-111');
    expect(serialized).not.toContain('in-222');
  });

  it('404s a thread that does not exist rather than inventing an empty one', async () => {
    const { router, token } = await linked();
    const res = await router.handle({
      method: 'GET',
      path: '/chats/nope@g.us/messages',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('reports history sync state honestly, including INFERRED completion', async () => {
    // The plan correction: `messaging-history.set` is push-based and completion can be
    // inferred by timeout rather than proven (`explicit:false`). An app that renders an
    // inferred-complete sync as "this is the whole history" is lying to the user about
    // what the analysis below it was computed from.
    const { router, deps: d, token } = await linked();
    d.socket.seedChat('111@g.us', [{ id: 'a1', from: 'x@s.whatsapp.net', text: 'one', ts: 1 }]);
    d.socket.setHistoryState({ complete: true, explicit: false, progress: 100 });

    const res = await router.handle({
      method: 'GET',
      path: '/chats/111@g.us/history',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.body as { sync: { complete: boolean; explicit: boolean } };
    expect(body.sync.complete).toBe(true);
    expect(body.sync.explicit).toBe(false);
  });

  it('refuses an unknown route and an unknown method on a known path', async () => {
    const { router, token } = await linked();
    const auth = { authorization: `Bearer ${token}` };
    expect((await router.handle({ method: 'GET', path: '/admin', headers: auth })).status).toBe(404);
    expect((await router.handle({ method: 'DELETE', path: '/chats', headers: auth })).status).toBe(405);
  });
});

describe('sending', () => {
  it('sends to the named thread and reports the message it created', async () => {
    const { router, deps: d, token } = await linked();
    d.socket.seedChat('111@g.us', []);
    const res = await router.handle({
      method: 'POST',
      path: '/chats/111@g.us/messages',
      headers: { authorization: `Bearer ${token}` },
      body: { text: 'sent as the user' },
    });
    expect(res.status).toBe(200);
    expect(d.socket.sent()).toEqual([{ jid: '111@g.us', text: 'sent as the user' }]);
  });

  it('refuses an empty or oversized body rather than sending nonsense', async () => {
    const { router, deps: d, token } = await linked();
    d.socket.seedChat('111@g.us', []);
    const auth = { authorization: `Bearer ${token}` };
    const empty = await router.handle({
      method: 'POST',
      path: '/chats/111@g.us/messages',
      headers: auth,
      body: { text: '   ' },
    });
    expect(empty.status).toBe(400);

    const huge = await router.handle({
      method: 'POST',
      path: '/chats/111@g.us/messages',
      headers: auth,
      body: { text: 'x'.repeat(70_000) },
    });
    expect(huge.status).toBe(400);
    expect(d.socket.sent()).toEqual([]);
  });

  it('refuses to send before the device is linked', async () => {
    // Sending through an unlinked session cannot succeed; failing here names the reason
    // instead of surfacing a library error the user cannot act on.
    const d = deps();
    const router = createRouter(d);
    d.store.setToken('preexisting-token');
    const res = await router.handle({
      method: 'POST',
      path: '/chats/111@g.us/messages',
      headers: { authorization: 'Bearer preexisting-token' },
      body: { text: 'hi' },
    });
    expect(res.status).toBe(409);
  });
});

/**
 * PERCENT-ENCODED JIDs (Phase C.2 — found by the first end-to-end run, not by inspection).
 *
 * A WhatsApp JID contains `@`, and every caller in the shipped stack percent-encodes it into
 * the path: the starter builds `/chats/' + encodeURIComponent(jid) + '/messages`. The Rust
 * admission decodes only to REASON about traversal and deliberately forwards the ORIGINAL
 * path (decoding before forwarding would let `%2f` smuggle a separator past the matcher), so
 * this router is the seat that owes the per-segment decode.
 *
 * Until it did, every layer was individually correct and tested while the seam between them
 * was broken: the app asked for `a%40s.whatsapp.net`, the router looked up a thread by that
 * literal string, found nothing, and answered a perfectly well-formed 404. Nothing was red.
 * This is what the missing server was hiding — no test in the package had ever driven a real
 * request end to end, so no test had ever spelled a JID the way a caller actually spells it.
 */
describe('a percent-encoded JID resolves to the same thread as its literal form', () => {
  it('finds the thread when the caller encoded the @', async () => {
    const d = deps();
    d.socket.emitLinked();
    d.socket.seedChat('a@s.whatsapp.net', [{ id: 'm1', from: 'a@s.whatsapp.net', text: 'hi', ts: 1 }]);
    const router = createRouter(d);
    d.store.setToken('tok');

    const res = await router.handle({
      method: 'GET',
      path: '/chats/a%40s.whatsapp.net/messages',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.status).toBe(200);
  });

  it('still finds it when the caller did NOT encode', async () => {
    // Both spellings must mean the same thread — the Rust layer forwards whatever arrived,
    // so the router cannot assume one convention.
    const d = deps();
    d.socket.emitLinked();
    d.socket.seedChat('a@s.whatsapp.net', [{ id: 'm1', from: 'a@s.whatsapp.net', text: 'hi', ts: 1 }]);
    const router = createRouter(d);
    d.store.setToken('tok');

    const res = await router.handle({
      method: 'GET',
      path: '/chats/a@s.whatsapp.net/messages',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.status).toBe(200);
  });

  it('a malformed escape is refused, never compared as raw bytes', async () => {
    // `%zz` cannot be decoded, so the segment has no determinate identity. Falling back to
    // the raw string would make a thread reachable under a spelling nothing else agrees on.
    const d = deps();
    d.socket.emitLinked();
    d.socket.seedChat('a@s.whatsapp.net', [{ id: 'm1', from: 'a@s.whatsapp.net', text: 'hi', ts: 1 }]);
    const router = createRouter(d);
    d.store.setToken('tok');

    const res = await router.handle({
      method: 'GET',
      path: '/chats/a%zzs.whatsapp.net/messages',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.status).toBe(404);
  });
});
