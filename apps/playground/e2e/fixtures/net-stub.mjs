// e2e/fixtures/net-stub.mjs — a self-signed HTTPS provider stub for the AL-03 net e2e.
//
// Amendment A1: the http-localhost exception is DEAD — the connected-fetch scheme gate
// is https-only. So the stub runs HTTPS with a self-signed cert; the Playwright net spec
// scopes `ignoreHTTPSErrors` to its OWN context (never the app-serving contexts).
//
// The stub requires `X-Api-Key: e2e-secret-key-9999` and, to prove the scrubber, ECHOES
// every request header it received back into the response body AND into an `etag`
// response header — so a green run means the injected key reached the provider (proving
// injection) yet never appears in what the app renders (proving scrubbing). It also sets
// a `set-cookie` header to prove A2 (never crosses the bridge).
//
// Zero external deps: the cert is minted with `node:crypto`'s X509 self-sign at boot.

import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.SNUG_E2E_NET_STUB_PORT ?? 43120);
const REQUIRED_KEY = 'e2e-secret-key-9999';

// Mint a self-signed cert for 127.0.0.1 via openssl (present on macOS/Linux CI images).
function selfSignedCert() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'snug-net-stub-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=stub.snug.test',
    // `api.coinbase.com` is a SAN because the P3 connection-wizard journey dials the REAL
    // provider host (resolver-mapped to this stub) rather than the stub's own name — the
    // whole point being that what the user reviews and freezes is a ceiling a real app
    // would have. Without the SAN that fetch fails the TLS check as NET_FETCH_FAILED.
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:stub.snug.test,DNS:api.coinbase.com',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE',
  // The CB-ACCESS-* trio is the P3 signed-template shape: an injected header the browser
  // has never seen before triggers a preflight, and a preflight that does not list it is
  // refused — which surfaced as NET_FETCH_FAILED with no clue that CORS was the cause.
  'access-control-allow-headers':
    'x-api-key,authorization,content-type,cb-access-key,cb-access-sign,cb-access-timestamp,cb-access-passphrase',
};

const server = https.createServer(selfSignedCert(), (req, res) => {
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const method = req.method ?? 'GET';
  // CORS preflight: the harness page is a different origin, so a POST with X-Api-Key
  // triggers an OPTIONS preflight the stub must answer.
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  /**
   * THE COINBASE SHAPE (P3 fold). The v4 wizard's motivating journey signs its requests
   * with a header TEMPLATE — `CB-ACCESS-TIMESTAMP` plus an HMAC `CB-ACCESS-SIGN` — rather
   * than presenting a bare key, so this stub answered it with a 401 and journey 1 failed
   * at its final assertion with NET_AUTH_FAILED. The stub had simply never been taught the
   * shape the phase exists to support.
   *
   * WHAT IT PROVES, and why the echo is deliberately `***`: a real signature is a
   * credential-derived value, and echoing it verbatim would make this fixture the one
   * place in the suite that hands a signing artifact back to the page. The spec asserts
   * `"sawSignature":"***"` — presence WITHOUT disclosure — which is exactly the property
   * that matters: the template was rendered HOST-side and reached the provider, and
   * nothing derived from the secret came back through the bridge.
   */
  const signature = req.headers['cb-access-sign'];
  if (typeof signature === 'string' && signature.length > 0) {
    const timestamp = req.headers['cb-access-timestamp'];
    res.writeHead(200, {
      ...CORS,
      'access-control-expose-headers': 'etag,x-ratelimit-remaining,content-type',
      'content-type': 'application/json',
      'x-ratelimit-remaining': '42',
    });
    res.end(
      JSON.stringify({
        method,
        path: url.pathname,
        // Presence, never the value — see above.
        sawSignature: '***',
        sawTimestamp: typeof timestamp === 'string' && timestamp.length > 0 ? '***' : null,
        sawAuthorization: req.headers['authorization'] ?? null,
      }),
    );
    return;
  }

  const receivedKey = req.headers['x-api-key'];
  if (receivedKey !== REQUIRED_KEY) {
    res.writeHead(401, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'missing or wrong X-Api-Key' }));
    return;
  }
  // Echo the injected key back — the scrubber must strip it before the app sees it.
  // Also echo whether an app-supplied Authorization survived to here (it must NOT — C1).
  const echoed = {
    method,
    path: url.pathname,
    sawApiKey: receivedKey,
    sawAuthorization: req.headers['authorization'] ?? null,
  };
  res.writeHead(200, {
    ...CORS,
    // The app reads etag/x-ratelimit via the whitelist — expose them cross-origin.
    'access-control-expose-headers': 'etag,x-ratelimit-remaining,content-type',
    'content-type': 'application/json',
    // R1: an injected value reflected into a WHITELISTED header must be scrubbed too.
    etag: `W/"${receivedKey}"`,
    'x-ratelimit-remaining': '42',
    // A2: set-cookie must never cross the bridge, regardless of request-side stripping.
    'set-cookie': 'sid=server-only-secret; HttpOnly',
    // non-whitelisted header must be dropped.
    'x-powered-by': 'net-stub',
  });
  res.end(JSON.stringify(echoed));
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`snug e2e net stub (https) on https://127.0.0.1:${port}`);
});

// keep the digest import used (silences no-unused for strict setups)
void createHash;
