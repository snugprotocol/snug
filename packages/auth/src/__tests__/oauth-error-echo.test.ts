/**
 * THE OAUTH ERROR-BODY ECHO (TASK-20260820-threat-model-v1, audit finding D2).
 *
 * `postForm` interpolated 500 chars of the RAW provider response body into an Error on
 * any non-2xx. That string is not a dead end — it rides all the way out:
 *
 *   oauth-service.postForm     `HTTP ${status}: ${text.slice(0, 500)}`
 *     -> SnugAuthError          "Refresh failed: <raw provider bytes>"
 *     -> connected-fetch        failure(NET_AUTH_FAILED, `${err.message} (${err.code})`)
 *     -> playground state/net   relayed verbatim into the net-response frame  => THE IFRAME
 *     -> providerTools          `Error: ${code} — ${message}`                 => THE LLM
 *
 * Reachable, not theoretical: an app on an approved host drives a 401, which triggers the
 * executor's own transparent refresh. That refresh POSTs `refresh_token` and
 * `client_secret` in the body — and a provider that echoes submitted parameters back in
 * its error envelope (ordinary OAuth debugging behaviour) puts them inside the slice.
 *
 * WHY THE SCRUBBER CANNOT COVER THIS, EVEN IN PRINCIPLE. Two independent reasons, and
 * both matter for where the fix belongs:
 *   1. On this path injection THROWS before returning, so `scrubCandidates` is never
 *      built — there is no candidate set to match against.
 *   2. The leaking values are POST BODY parameters. They were never injected headers, so
 *      they would fall outside the candidate set even if one existed. This is the same
 *      shape as the v2 delta's R-2 ("the raw secret was never injected, so it is not in
 *      the scrubber's candidate set") — but unlike R-2 it was never disclosed.
 *
 * The fix is bounding at the source, reusing the extraction discipline that already
 * governs the observer's `detail` seat: recognized error shapes yield a short reason,
 * everything else yields nothing. A provider's error envelope is the only useful content
 * in that body; the rest is bytes we have no reason to forward.
 *
 * WHY THE SUITE WAS GREEN: the existing refresh-failure test (`oauth-service.test.ts`,
 * "marks the connection expired and throws typed errors") asserts `code:
 * 'refresh_failed'` via `toMatchObject` and never looks at `message`. Every
 * NET_AUTH_FAILED assertion in the package has the same shape. The leaking field is
 * exactly the one no test read.
 */

import { describe, expect, it } from 'vitest';
import type { Oauth2AuthCodeSpec } from '@snugprotocol/protocol';
import { UserDbCredentialStore, type CredentialStore } from '../credential-store.js';
import { OAuthService, SnugAuthError } from '../oauth-service.js';

const APP = 'app-spotify';
const REFRESH_TOKEN = 'rt-USER-REFRESH-SECRET-value';
const CLIENT_SECRET = 'cs-USER-CLIENT-SECRET-value';

const spec: Oauth2AuthCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    refreshUrl: 'https://accounts.spotify.com/api/token',
  },
  scopes: ['user-read-private'],
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
};

const ALLOWED = ['accounts.spotify.com', 'api.spotify.com'];

function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

/**
 * A connected app whose provider answers every refresh with `body` at `status`.
 * The refresh token and client secret are REAL stored credentials, so the POST that
 * triggers the error genuinely carries them — the echo fixture is not fabricating a
 * value the request never sent.
 */
async function connectedWithFailingRefresh(
  status: number,
  body: string,
): Promise<{ service: OAuthService; store: CredentialStore }> {
  const store = new UserDbCredentialStore(memoryQuartet());
  const service = new OAuthService({
    store,
    redirectUriProvider: { redirectUri: (appId: string) => `http://127.0.0.1:8787/auth/callback/${appId}` },
    fetch: (_input: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('grant_type') === 'refresh_token') {
        return Promise.resolve(new Response(body, { status }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'ACCESS_1',
            refresh_token: REFRESH_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    },
  } as never);

  await store.setCredential(APP, 'client_id', 'client-abc');
  await store.setCredential(APP, 'client_secret', CLIENT_SECRET);
  await store.setCredential(APP, 'refresh_token', REFRESH_TOKEN);
  await store.setConnectionState(APP, {
    status: 'connected',
    obtainedAt: Date.now() - 3600_000,
    expiresIn: 3600,
  });
  return { service, store };
}

async function refreshMessage(status: number, body: string): Promise<string> {
  const { service } = await connectedWithFailingRefresh(status, body);
  try {
    await service.refresh({ appId: APP, spec, allowedHosts: ALLOWED });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the refresh to fail');
}

/** An error envelope that echoes the submitted parameters — ordinary provider behaviour. */
const ECHOING_ERROR_BODY = JSON.stringify({
  error: 'invalid_grant',
  error_description: 'The refresh token is expired.',
  debug: {
    received: { refresh_token: REFRESH_TOKEN, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' },
  },
});

describe('a provider error body never carries credential material out of the oauth seat', () => {
  it('a refresh failure whose body ECHOES the submitted secrets leaks neither of them', async () => {
    const message = await refreshMessage(400, ECHOING_ERROR_BODY);

    // THE POINT. Both values were submitted by us, in the POST body, on a path where the
    // response scrubber has no candidate set and could not have matched them anyway.
    expect(message, 'the refresh token never rides the error message').not.toContain(REFRESH_TOKEN);
    expect(message, 'the client secret never rides the error message').not.toContain(CLIENT_SECRET);
    // Not a vacuous pass: a fix that returned an empty message would satisfy the two
    // assertions above for the wrong reason.
    expect(message.length).toBeGreaterThan(0);
  });

  it('keeps the provider’s stated reason — the bound is on raw bytes, not on diagnosis', async () => {
    const message = await refreshMessage(400, ECHOING_ERROR_BODY);

    expect(message, 'RFC 6749 error_description is the useful half and survives').toContain(
      'The refresh token is expired.',
    );
  });

  it('forwards NOTHING from an unrecognized body shape — brace noise is not a diagnosis', async () => {
    const hostile = JSON.stringify({ blob: REFRESH_TOKEN, nested: { deep: CLIENT_SECRET } });
    const message = await refreshMessage(400, hostile);

    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message).not.toContain(CLIENT_SECRET);
    // The status still surfaces — a caller must be able to tell 400 from 503.
    expect(message).toMatch(/400/);
  });

  it('an HTML error page never becomes a message body', async () => {
    const html = `<html><body>error for token ${REFRESH_TOKEN}</body></html>`;
    const message = await refreshMessage(502, html);

    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message).toMatch(/502/);
  });

  /**
   * GATE-5 REVIEW FINDING — the first fix bounded VOLUME, not CONTENT.
   *
   * `extractProviderErrorDetail` is an allowlist of error-envelope SHAPES, and the first
   * cut of this fix leaned on that as though it were an allowlist of VALUES. It is not:
   * the shape decides which FIELD is forwarded, and the field's own content is still
   * chosen by the provider. Measured against the shipped extractor, all three of these
   * carried the live refresh token straight through the 160-char cap:
   *
   *   'invalid_grant for token rt-…'                    -> forwarded verbatim (plain-text head)
   *   'error=invalid_grant&refresh_token=rt-…'          -> forwarded verbatim (form-encoded)
   *   {"error_description":"bad token rt-…"}            -> forwarded verbatim (RECOGNIZED field)
   *
   * The third is the one that matters most, because it defeats the tempting narrower fix
   * of "only forward recognized JSON fields" — a hostile or merely verbose provider puts
   * the echo INSIDE `error_description`, which is exactly the field a reader wants.
   *
   * So the bound has to be a value-scrub as well as a shape-allowlist, and this seat can
   * build a real candidate set: `postForm` holds the `URLSearchParams` it just submitted,
   * so the secrets at risk are known EXACTLY rather than guessed at. That is the
   * difference from the response-scrub path, where the candidate set genuinely does not
   * contain these values (they were POST body params, never injected headers).
   */
  it('scrubs a submitted secret out of a PLAIN-TEXT error body', async () => {
    const message = await refreshMessage(400, `invalid_grant for token ${REFRESH_TOKEN}`);

    expect(message).not.toContain(REFRESH_TOKEN);
    // The surrounding reason survives — scrubbing replaces the value, not the diagnosis.
    expect(message).toContain('invalid_grant');
  });

  it('scrubs a submitted secret out of a FORM-ENCODED error body', async () => {
    const message = await refreshMessage(400, `error=invalid_grant&refresh_token=${REFRESH_TOKEN}`);

    expect(message).not.toContain(REFRESH_TOKEN);
  });

  it('scrubs a submitted secret echoed INSIDE a recognized JSON field', async () => {
    // The sharpest case: the echo rides `error_description`, the very field a reader
    // wants. A shape-only allowlist forwards this happily.
    const body = JSON.stringify({ error_description: `bad refresh token ${REFRESH_TOKEN}` });
    const message = await refreshMessage(400, body);

    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message, 'the useful half of the reason still survives').toContain('bad refresh token');
  });

  it('scrubs the CLIENT SECRET too — every submitted value is a candidate, not just the token', async () => {
    const body = JSON.stringify({ error_description: `client ${CLIENT_SECRET} rejected` });
    const message = await refreshMessage(400, body);

    expect(message).not.toContain(CLIENT_SECRET);
  });

  /**
   * GATE-5 REVIEW, SECOND FINDING — scrub-before-extract is not sufficient on its own.
   *
   * `JSON.parse` DECODES `\u` escapes, and it runs inside `extractProviderErrorDetail` —
   * i.e. AFTER the scrub. So a provider that escapes its echo defeats an exact-substring
   * scrub of the raw text and the token is recovered character-for-character, in
   * cleartext, in the extracted field:
   *
   *   {"error_description":"bad token rt-…"}  ->  "bad token rt-USER-…"
   *
   * This is NOT the documented re-encoding boundary (`scrub.ts:16-19`). That boundary is
   * about a value arriving in a DIFFERENT form (base64, hex) which no exact-substring
   * matcher can be expected to catch. Here the value arrives in the SAME form after a
   * decode step we ourselves perform — the scrub simply ran on the wrong side of it.
   *
   * Fixed by scrubbing the EXTRACTED string as well. Both passes are kept: the pre-scrub
   * still handles the plain-text and form-encoded heads (where no decode happens), and
   * the post-scrub catches anything a decode reconstituted.
   */
  it('scrubs a JSON \\u-ESCAPED echo — the decode happens inside the extractor, after the first scrub', async () => {
    const escaped = [...REFRESH_TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const message = await refreshMessage(400, `{"error_description":"bad token ${escaped}"}`);

    expect(message).not.toContain(REFRESH_TOKEN);
    expect(message, 'the reason still survives the double scrub').toContain('bad token');
  });

  it('does not scrub NON-secret submitted values — grant_type must still be readable', async () => {
    // Non-vacuity in the other direction: scrubbing every submitted parameter would
    // redact `grant_type=refresh_token` and turn honest diagnoses into a row of asterisks.
    // Only the values that are actually secret belong in the candidate set.
    const message = await refreshMessage(400, JSON.stringify({ error_description: 'grant_type refresh_token is unsupported' }));

    expect(message).toContain('grant_type');
    expect(message).toContain('refresh_token');
  });

  it('still throws the TYPED cause, so host surfaces can tell failures apart (N1)', async () => {
    const { service } = await connectedWithFailingRefresh(400, ECHOING_ERROR_BODY);

    await expect(service.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toBeInstanceOf(
      SnugAuthError,
    );
    // The code is what the CTA map keys on; bounding the prose must not disturb it.
    await expect(service.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toMatchObject({
      code: 'refresh_failed',
    });
  });
});
