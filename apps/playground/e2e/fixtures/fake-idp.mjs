// fake-idp.mjs — a zero-dep local OAuth2 IdP for the OAuth popup e2e.
//
// TWO LISTENERS, and the second one is the P3 fold's addition:
//   - HTTP  on 127.0.0.1:<PORT>      — the original, kept for the v3 `?demoauth=` spec.
//   - HTTPS on 127.0.0.1:<PORT+1>    — required by the v4 journey, and the reason is a
//     GUARD RATHER THAN A PREFERENCE. `connectionRequirementSchema` demands `https` for
//     every OAuth endpoint, so an http authorize/token URL is rejected before a card can
//     render. That is correct — a plaintext authorize URL is a credential-grade downgrade
//     — and it must not be relaxed for a fixture, so the fixture speaks https instead.
//     The connection-wizard project maps `idp.snug.test` here and ignores the self-signed
//     cert, both scoped to that project.
//
//   GET  /authorize?redirect_uri=…&state=…&code_challenge=…  → 302 back with a code
//   POST /token   (authorization_code + PKCE verifier)       → token JSON (CORS open)
//   GET  /healthz                                            → 200
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.SNUG_E2E_FAKE_IDP_PORT ?? '') || 43121;
/** The https twin. Adjacent by construction so one env var still configures the pair. */
const TLS_PORT = PORT + 1;
const CODE = 'fake-code-123';

/** Self-signed for `idp.snug.test`, minted at boot — same recipe as the net stub. */
function selfSignedCert() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'snug-fake-idp-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '2',
      '-subj', '/CN=idp.snug.test',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:idp.snug.test',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,accept',
};

/** One handler, both listeners — the two schemes must never answer differently. */
const handle = (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, CORS);
    res.end('ok');
    return;
  }
  if (url.pathname === '/authorize' && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge');
    if (redirectUri === null || challenge === null) {
      res.writeHead(400, CORS);
      res.end('missing redirect_uri or code_challenge (PKCE required)');
      return;
    }
    const sep = redirectUri.includes('?') ? '&' : '?';
    res.writeHead(302, { ...CORS, Location: `${redirectUri}${sep}code=${CODE}&state=${encodeURIComponent(state)}` });
    res.end();
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const ok =
        params.get('grant_type') === 'authorization_code' &&
        params.get('code') === CODE &&
        (params.get('code_verifier') ?? '').length >= 43; // PKCE enforced
      res.writeHead(ok ? 200 : 400, { ...CORS, 'content-type': 'application/json' });
      res.end(
        ok
          ? JSON.stringify({
              access_token: 'e2e-access-token-abc',
              refresh_token: 'e2e-refresh-token-def',
              expires_in: 3600,
              token_type: 'Bearer',
            })
          : JSON.stringify({ error: 'invalid_grant' }),
      );
    });
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
};

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-idp] listening on http://127.0.0.1:${PORT}`);
});

https.createServer(selfSignedCert(), handle).listen(TLS_PORT, '127.0.0.1', () => {
  console.log(`[fake-idp] listening on https://127.0.0.1:${TLS_PORT}`);
});
