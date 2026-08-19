// TASK-20260818-ledger-starter A3 (ADR-0038): `performTokenClaim` — the claim-once mint.
//
// THE SHAPE UNDER TEST: decode the pasted setup token (base64 of a claim URL) → refuse
// unless the decoded target is https + on the frozen ceiling + default port + no
// userinfo → POST it once (`redirect:'error'`, no headers, empty body) → parse the
// response body as the access URL → refuse unless https + on-ceiling + default port +
// carries BOTH userinfo credentials + path is EXACTLY the pairing's `accessPath` →
// verify with the minted Basic pair (2xx only, `redirect:'error'`) → hand the pair to
// the injected `commit`, which the caller implements as the write-together act.
//
// C1 DISCIPLINE UNDER TEST, byte-level: no result object — success or ANY failure —
// ever carries the setup token, the decoded URLs, or the minted username/password. The
// mint reaches exactly one seat: the `commit` callback, called once, after the verify.
//
// FETCH DOUBLES ARE FACTORIES (2026-08-04 lesson): a `Response` is a one-shot resource,
// so every stub mints a fresh one per call.

import { describe, expect, it, vi } from 'vitest';

import { performTokenClaim, type TokenClaimResult } from '../token-claim.js';
import type { WellKnownTokenClaimPairing } from '../well-known-providers.js';

const PAIRING: WellKnownTokenClaimPairing = {
  kind: 'token-claim',
  tokenLabel: 'SimpleFIN setup token',
  usernameField: 'username',
  passwordField: 'password',
  accessPath: '/simplefin',
  preconditionInstruction: 'Copy the setup token from SimpleFIN Bridge.',
  verify: { method: 'GET', pathAndQuery: '/simplefin/accounts?balances-only=1' },
};

const CEILING = ['bridge.simplefin.org'] as const;
const CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/demo-token-123';
const ACCESS_URL = 'https://user-abc:secret-xyz@bridge.simplefin.org/simplefin';

/** Standard base64 the way SimpleFIN mints tokens (btoa is fine: claim URLs are ASCII). */
const token = (url: string): string => btoa(url);

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A fetch double that answers the claim POST then the verify GET, recording both. Each
 * response is minted fresh per call (factory rule).
 */
function claimThenVerifyFetch(
  options: {
    claimStatus?: number;
    claimBody?: string;
    verifyStatus?: number;
  } = {},
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(options.claimBody ?? ACCESS_URL, { status: options.claimStatus ?? 200 });
    }
    return new Response('{"accounts":[]}', { status: options.verifyStatus ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function commitSpy() {
  return vi.fn(async (_mint: { username: string; password: string; verifiedAt: number }) => {});
}

async function run(
  setupToken: string,
  fetchImpl: typeof fetch,
  commit = commitSpy(),
): Promise<{ result: TokenClaimResult; commit: ReturnType<typeof commitSpy> }> {
  const result = await performTokenClaim({
    setupToken,
    allowedHosts: CEILING,
    pairing: PAIRING,
    fetchImpl,
    commit,
  });
  return { result, commit };
}

/** Byte-probe: no result may carry the token, a URL, or either credential half. */
function expectNoSecretEcho(result: TokenClaimResult, setupToken: string): void {
  const bytes = JSON.stringify(result);
  expect(bytes).not.toContain(setupToken);
  expect(bytes).not.toContain('user-abc');
  expect(bytes).not.toContain('secret-xyz');
  expect(bytes).not.toContain('bridge.simplefin.org/simplefin/claim');
}

describe('the happy path', () => {
  it('claims, verifies, then commits the minted pair exactly once', async () => {
    const { fetchImpl, calls } = claimThenVerifyFetch();
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ username: 'user-abc', password: 'secret-xyz' });
    expect(commit.mock.calls[0]?.[0]?.verifiedAt).toBeGreaterThan(0);
    expect(calls.length).toBe(2);
  });

  it('POSTs the decoded claim URL with redirect:"error", no headers, empty body', async () => {
    // The option must ARRIVE (2026-08-12 seam lesson): asserting behavior through a stub
    // proves the request shape, and the executor's redirect discipline is an option here.
    const { fetchImpl, calls } = claimThenVerifyFetch();
    await run(token(CLAIM_URL), fetchImpl);
    expect(calls[0]?.url).toBe(CLAIM_URL);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.headers ?? {}).toEqual({});
    expect(calls[0]?.init?.body ?? undefined).toBeUndefined();
  });

  it('verifies at the pairing path on the ACCESS URL host, Basic-credentialed, redirect:"error"', async () => {
    const { fetchImpl, calls } = claimThenVerifyFetch();
    await run(token(CLAIM_URL), fetchImpl);
    expect(calls[1]?.url).toBe('https://bridge.simplefin.org/simplefin/accounts?balances-only=1');
    expect(calls[1]?.init?.method).toBe('GET');
    expect(calls[1]?.init?.redirect).toBe('error');
    const headers = (calls[1]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${btoa('user-abc:secret-xyz')}`);
  });

  it('decodes percent-encoded userinfo before committing', async () => {
    // The URL API keeps userinfo percent-encoded; the Basic header must carry the REAL
    // bytes or every credential containing a reserved character fails forever.
    const { fetchImpl } = claimThenVerifyFetch({
      claimBody: 'https://u%40x:p%2Fw@bridge.simplefin.org/simplefin',
    });
    const commit = commitSpy();
    await run(token(CLAIM_URL), fetchImpl, commit);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ username: 'u@x', password: 'p/w' });
  });

  it('the success result carries NO secret bytes (C1)', async () => {
    const { fetchImpl } = claimThenVerifyFetch();
    const { result } = await run(token(CLAIM_URL), fetchImpl);
    expectNoSecretEcho(result, token(CLAIM_URL));
  });
});

describe('the pasted token is refused before any network', () => {
  const neverFetch = (() => {
    throw new Error('no request may fire for a refused token');
  }) as unknown as typeof fetch;

  const refusedBeforeNetwork = async (setupToken: string, reason: string) => {
    const { result, commit } = await run(setupToken, neverFetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
    expect(commit).not.toHaveBeenCalled();
    expectNoSecretEcho(result, setupToken);
  };

  it('not base64 at all', () => refusedBeforeNetwork('%%% not a token %%%', 'malformed_token'));
  it('base64 of something that is not a URL', () => refusedBeforeNetwork(btoa('just words'), 'malformed_token'));
  it('an http claim URL', () =>
    refusedBeforeNetwork(token('http://bridge.simplefin.org/simplefin/claim/x'), 'claim_target_refused'));
  it('a claim URL off the frozen ceiling', () =>
    refusedBeforeNetwork(token('https://evil.example/simplefin/claim/x'), 'claim_target_refused'));
  it('a lookalike host (subdomain of an attacker domain)', () =>
    refusedBeforeNetwork(token('https://bridge.simplefin.org.evil.example/claim/x'), 'claim_target_refused'));
  it('a claim URL with an explicit port', () =>
    refusedBeforeNetwork(token('https://bridge.simplefin.org:8443/simplefin/claim/x'), 'claim_target_refused'));
  it('a claim URL carrying its own userinfo', () =>
    refusedBeforeNetwork(token('https://a:b@bridge.simplefin.org/simplefin/claim/x'), 'claim_target_refused'));
});

describe('the claim response is refused honestly', () => {
  it('403 names the one-use nature — the commonest real failure', async () => {
    const { fetchImpl, calls } = claimThenVerifyFetch({ claimStatus: 403 });
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('token_used_or_expired');
      expect(result.message).toMatch(/once|used|fresh|new token/i);
    }
    expect(commit).not.toHaveBeenCalled();
    expect(calls.length, 'no verify may follow a failed claim').toBe(1);
  });

  it('a network throw is claim_failed, never an unhandled rejection', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { result, commit } = await run(token(CLAIM_URL), failing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('claim_failed');
    expect(commit).not.toHaveBeenCalled();
  });

  const accessRefused = async (claimBody: string) => {
    const { fetchImpl, calls } = claimThenVerifyFetch({ claimBody });
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('access_url_refused');
    expect(commit).not.toHaveBeenCalled();
    expect(calls.length, 'no verify may ride a refused access URL').toBe(1);
    expectNoSecretEcho(result, token(CLAIM_URL));
  };

  it('an access URL that is not a URL', () => accessRefused('the bridge is on fire'));
  it('an http access URL', () => accessRefused('http://user:pass@bridge.simplefin.org/simplefin'));
  it('an access URL off the frozen ceiling', () => accessRefused('https://user:pass@evil.example/simplefin'));
  it('an access URL with an explicit port', () =>
    accessRefused('https://user:pass@bridge.simplefin.org:8443/simplefin'));
  it('an access URL missing its credentials', () => accessRefused('https://bridge.simplefin.org/simplefin'));
  it('an access URL on the WRONG BASE PATH — the checked invariant (review Blocker 3)', () =>
    accessRefused('https://user:pass@bridge.simplefin.org/other-prefix'));
});

describe('verify-before-commit (ADR-0025)', () => {
  it('a failed verify commits NOTHING', async () => {
    const { fetchImpl } = claimThenVerifyFetch({ verifyStatus: 401 });
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('verify_failed');
    expect(commit).not.toHaveBeenCalled();
  });

  it('a verify network throw commits NOTHING', async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      if (callCount === 1) return new Response(ACCESS_URL, { status: 200 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('verify_failed');
    expect(commit).not.toHaveBeenCalled();
  });

  it('commit runs AFTER the verify answered — pinned by call order, not by comment', async () => {
    const order: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      order.push(url.includes('claim') ? 'claim' : 'verify');
      return url.includes('claim') ? new Response(ACCESS_URL, { status: 200 }) : new Response('{}', { status: 200 });
    }) as typeof fetch;
    const commit = vi.fn(async () => {
      order.push('commit');
    });
    await performTokenClaim({
      setupToken: token(CLAIM_URL),
      allowedHosts: CEILING,
      pairing: PAIRING,
      fetchImpl,
      commit,
    });
    expect(order).toEqual(['claim', 'verify', 'commit']);
  });

  it('a commit throw is commit_failed — named, never silent, never a success', async () => {
    const { fetchImpl } = claimThenVerifyFetch();
    const commit = vi.fn(async () => {
      throw new Error('db unavailable');
    });
    const result = await performTokenClaim({
      setupToken: token(CLAIM_URL),
      allowedHosts: CEILING,
      pairing: PAIRING,
      fetchImpl,
      commit,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('commit_failed');
  });
});

describe('bounds', () => {
  it('an absurdly large claim response is refused, not parsed', async () => {
    const { fetchImpl } = claimThenVerifyFetch({ claimBody: 'x'.repeat(64 * 1024) });
    const { result, commit } = await run(token(CLAIM_URL), fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('access_url_refused');
    expect(commit).not.toHaveBeenCalled();
  });

  it('every failure message is a fixed sentence — pasted content is never echoed', async () => {
    // The ed25519-key lesson: a paste's "context" IS the secret. Adversarial inputs
    // whose bytes would be recognizable in any echo.
    const adversarial = [
      'AAAA%%%%',
      btoa('https://evil.example/steal?token=SENTINEL-9'),
      btoa('http://bridge.simplefin.org/claim/SENTINEL-9'),
    ];
    for (const setupToken of adversarial) {
      const { result } = await run(setupToken, (() => {
        throw new Error('unreachable');
      }) as unknown as typeof fetch);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SENTINEL-9');
      expect(JSON.stringify(result)).not.toContain('evil.example');
    }
  });
});
