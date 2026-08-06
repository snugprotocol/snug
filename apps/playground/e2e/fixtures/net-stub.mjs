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
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:stub.snug.test',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE',
  'access-control-allow-headers': 'x-api-key,authorization,content-type',
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
