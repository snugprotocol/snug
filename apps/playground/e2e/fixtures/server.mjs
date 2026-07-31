// e2e/fixtures/server.mjs — zero-dependency static server for the Playwright harness.
//
// Purpose: the CSP and StrictMode suites must run against REAL http-served pages even
// before the playground app (workstream A) exists. This server exposes:
//
//   /blank.html            embedder page for the BROWSER_CSP_CHECKS iframes
//   /harness.html + .js    a page that mounts the PRODUCTION SnugAppFrame (runner dist)
//   /shims/*               ESM shims mapping react/react-dom onto the UMD globals
//   /vendor/react(-dom).js react 18 UMD builds (served from the workspace, not a CDN)
//   /pkg/runner/*          packages/runner/dist   (production bytes under test)
//   /pkg/protocol/*        packages/protocol/dist
//   /zod/*                 zod ESM (protocol's dependency; all-relative imports)
//   /healthz               200 ok (playwright webServer readiness)
//
// No bundler: harness.js is plain ESM + an import map in harness.html. This keeps the
// harness dependency-free and guarantees the iframe/runner code is the exact dist output.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const port = Number(process.env.SNUG_E2E_FIXTURE_PORT ?? 43117);

/** Longest-prefix-first mounts; single-file mounts map exactly. */
const MOUNTS = [
  { prefix: '/pkg/runner/', dir: path.join(repoRoot, 'packages/runner/dist') },
  { prefix: '/pkg/protocol/', dir: path.join(repoRoot, 'packages/protocol/dist') },
  { prefix: '/zod/', dir: path.join(repoRoot, 'packages/protocol/node_modules/zod') },
  {
    file: '/vendor/react.js',
    target: path.join(repoRoot, 'packages/runner/node_modules/react/umd/react.development.js'),
  },
  {
    file: '/vendor/react-dom.js',
    target: path.join(repoRoot, 'packages/runner/node_modules/react-dom/umd/react-dom.development.js'),
  },
  { prefix: '/', dir: here },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function resolveTarget(urlPath) {
  for (const mount of MOUNTS) {
    if (mount.file !== undefined) {
      if (urlPath === mount.file) return mount.target;
      continue;
    }
    if (!urlPath.startsWith(mount.prefix)) continue;
    const rel = urlPath.slice(mount.prefix.length);
    const target = path.resolve(mount.dir, rel);
    if (!target.startsWith(mount.dir + path.sep) && target !== mount.dir) return null; // traversal guard
    return target;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const target = resolveTarget(urlPath === '/' ? '/blank.html' : urlPath);
  if (target === null) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`snug e2e fixture server on http://127.0.0.1:${port}`);
});
