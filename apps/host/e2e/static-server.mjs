// e2e/static-server.mjs — a loopback server for the kit's Playwright suite that serves
// EXACTLY one thing: the built page. Anything else the page asks its own origin for 404s
// here — and with ONE exception that is a self-containment defect (the spec's request log
// catches it too).
//
// The exception (MIGRATED 2026-10-03, K2): served from the literal `http://127.0.0.1`, the
// one page asks its own origin for `/status`, once, to find out whether it is the local
// runner's page. This server's 404 IS the answer — "no" — and the page then boots as what
// it is here: a plain page, file-class, whose file lives in this browser. (Before, any
// loopback origin was called `local-host` and this page said "your file: on this Mac".)
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const port = Number(process.env.SNUG_HOST_E2E_PORT ?? 43123);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname !== '/snug-host.html') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not served: ${url.pathname}`);
      return;
    }
    try {
      const bytes = await fs.readFile(path.join(dist, 'snug-host.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(bytes);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dist/snug-host.html missing — run `pnpm --filter host build`');
    }
  })
  .listen(port, '127.0.0.1');
