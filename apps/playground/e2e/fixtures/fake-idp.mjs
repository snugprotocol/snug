// fake-idp.mjs — a zero-dep local OAuth2 IdP for the AL-04 PKCE popup e2e.
// Plain HTTP on 127.0.0.1 (top-level popup navigation — the SSRF loopback guard
// applies to the connected-fetch path, not to OAuthService's ceiling-checked token
// exchange, whose host the user approves explicitly in the wizard).
//
//   GET  /authorize?redirect_uri=…&state=…&code_challenge=…  → 302 back with a code
//   POST /token   (authorization_code + PKCE verifier)       → token JSON (CORS open)
//   GET  /healthz                                            → 200
import http from 'node:http';

const PORT = Number(process.env.SNUG_E2E_FAKE_IDP_PORT ?? '') || 43121;
const CODE = 'fake-code-123';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,accept',
};

const server = http.createServer((req, res) => {
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
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-idp] listening on http://127.0.0.1:${PORT}`);
});
