// The page's half of the loopback contract (ADR-0068 D-B16).
//
// The reconstruction cases here are not hypothetical: each one is a shape that makes
// `new Response(...)` THROW, which the executor would then report to the app as a transport
// failure for a request that actually succeeded.

import { describe, expect, it, vi } from 'vitest';

import { claimTokenFromFragment, responseFromEnvelope, serializeBody } from '../local/client.js';

const TOKEN = 'a'.repeat(64);

describe('claiming the token from the fragment', () => {
  const win = (hash: string, stored: string | null = null) => {
    const store = new Map<string, string>();
    if (stored !== null) store.set('snug-host-token', stored);
    const replaceState = vi.fn();
    return {
      win: {
        location: { hash, pathname: '/', search: '' },
        history: { replaceState },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      },
      replaceState,
      store,
    };
  };

  it('reads the token and REMOVES it from the address bar', () => {
    const { win: w, replaceState } = win(`#token=${TOKEN}`);
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
    // The router reads location.hash on its first render; a leftover #token= would be
    // treated as a route, and the address bar would show the credential.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/');
  });

  it('remembers it for a reload, when the fragment is gone', () => {
    const { win: w } = win('#/', TOKEN);
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
  });

  it('returns nothing for a tab opened without one', () => {
    expect(claimTokenFromFragment(win('#/').win)).toBeUndefined();
  });

  it('ignores a fragment that is not a well-formed token', () => {
    expect(claimTokenFromFragment(win('#token=short').win)).toBeUndefined();
  });

  it('survives sessionStorage throwing (a private window)', () => {
    const w = {
      location: { hash: `#token=${TOKEN}`, pathname: '/', search: '' },
      history: { replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    // This load still works; only the reload does not.
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
  });
});

describe('rebuilding a Response the executor can gate', () => {
  it('carries status, headers and body', async () => {
    const response = responseFromEnvelope({
      ok: true,
      status: 200,
      headers: [['content-type', 'application/json']],
      bodyBase64: Buffer.from('{"a":1}').toString('base64'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it.each([204, 205, 304])('handles %i — a null-body status with a body THROWS', (status) => {
    // A provider answering 204 to a DELETE is ordinary. Constructing that Response with a
    // body would throw inside fetchImpl and reach the app as NET_FETCH_FAILED on a request
    // that in fact succeeded.
    const response = responseFromEnvelope({ ok: true, status, bodyBase64: Buffer.from('ignored').toString('base64') });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('clamps a status outside 200–599 rather than throwing', () => {
    expect(responseFromEnvelope({ ok: true, status: 0 }).status).toBe(200);
    expect(responseFromEnvelope({ ok: true, status: 999 }).status).toBe(599);
  });

  it('drops a statusText outside the reason-phrase grammar', () => {
    expect(() => responseFromEnvelope({ ok: true, status: 200, statusText: 'bad\nnewline' })).not.toThrow();
  });

  it('preserves a 3xx as data, so the executor’s own redirect gate is what refuses it', () => {
    const response = responseFromEnvelope({ ok: true, status: 302, headers: [['content-type', 'text/html']] });
    expect(response.status).toBe(302);
  });

  it('round-trips bytes above 0x7F without mangling them', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x41]);
    const response = responseFromEnvelope({ ok: true, status: 200, bodyBase64: Buffer.from(bytes).toString('base64') });
    return response.arrayBuffer().then((buffer) => expect(new Uint8Array(buffer)).toEqual(bytes));
  });
});

describe('serializing a request body', () => {
  it('passes a string through — what the executor always sends', () => {
    expect(serializeBody('{"a":1}')).toBe('{"a":1}');
  });

  it('encodes URLSearchParams — what the OAuth service sends', () => {
    // JSON.stringify of URLSearchParams is "{}", which would make every token exchange,
    // refresh and revoke a silently empty POST.
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r1' });
    expect(serializeBody(params)).toBe('grant_type=refresh_token&refresh_token=r1');
  });

  it('leaves an absent body absent', () => {
    expect(serializeBody(undefined)).toBeUndefined();
    expect(serializeBody(null)).toBeUndefined();
  });
});
