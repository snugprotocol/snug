// e2e/helpers.ts — the kit suite's constants, request policy, probe app and fixture builder
// (TASK-20260905-host-kit P9). Run via `pnpm --filter host test:e2e` (cwd = apps/host).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Page } from '@playwright/test';
import { createMemoryBackend, openUserDb } from '@snugprotocol/db';
import { JSDOM } from 'jsdom';

export const KIT_PORT = 43123;
export const KIT_ORIGIN = `http://127.0.0.1:${KIT_PORT}`;
export const KIT_URL = `${KIT_ORIGIN}/snug-host.html`;

const hostDir = (): string => (path.basename(process.cwd()) === 'host' ? process.cwd() : path.join(process.cwd(), 'apps', 'host'));
export const KIT_DIST_FILE = path.join(hostDir(), 'dist', 'snug-host.html');
export const KIT_FILE_URL = pathToFileURL(KIT_DIST_FILE).href;
export const STARTERS_PKG_DIR = path.join(hostDir(), 'starters-pkg');

export interface StartersIndex {
  name: string;
  version: string;
  starters: Record<string, { file: string; sha384: string }>;
}
export function startersIndex(): StartersIndex {
  return JSON.parse(fs.readFileSync(path.join(STARTERS_PKG_DIR, 'index.json'), 'utf8')) as StartersIndex;
}

/**
 * `RUNNER_CSP` from the runner package. Its index evaluates the browser CSP template at
 * import time (DOMParser), so the spec shims DOMParser with jsdom first — the same shape as
 * apps/playground/e2e/csp.spec.ts.
 */
export async function runnerCsp(): Promise<string> {
  if (typeof globalThis.DOMParser === 'undefined') {
    (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM('').window.DOMParser;
  }
  const mod = (await import('@snugprotocol/runner')) as { RUNNER_CSP: string };
  return mod.RUNNER_CSP;
}

/** The loader's named refusal begins with this (pinned in src/starterLoader.ts). */
export const STARTER_LOAD_REFUSAL_PREFIX = 'starters load from the network';

const STARTER_SCRIPT = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@snugprotocol\/starters@([^/]+)\/([^/?#]+)$/;
const JSDELIVR_NPM = 'https://cdn.jsdelivr.net/npm/';

export interface RoutePolicy {
  /** Every request the policy ABORTED. */
  blocked: string[];
  /** Every request let through to the network (jsDelivr /npm/ only). */
  passed: string[];
  /** Starter wrappers served from starters-pkg (the package is not published — owner act). */
  starters: string[];
  /** Every request the page made, whatever happened to it. */
  all: string[];
}

/**
 * The suite's network truth (AC2/AC3/AC8): the page's own origin and file:// continue;
 * `@snugprotocol/starters@<version>/<file>` is INTERCEPTED and served from the local
 * package build with the CORS header SRI needs (the version must be the baked one — any
 * other is aborted, which is the pin that the loader asks for exactly what it hashed);
 * other jsDelivr /npm/ requests (the apps' React) pass when allowed; everything else is
 * aborted and recorded. A `sql-wasm.wasm` request can never appear in `all`.
 */
export async function installRoutePolicy(
  page: Page,
  opts: { allowJsDelivr: boolean; allowStarters?: boolean },
): Promise<RoutePolicy> {
  const policy: RoutePolicy = { blocked: [], passed: [], starters: [], all: [] };
  const index = startersIndex();
  page.on('request', (request) => {
    policy.all.push(request.url());
  });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file://') || url.startsWith(`${KIT_ORIGIN}/`)) return route.continue();
    const starter = STARTER_SCRIPT.exec(url);
    if (starter !== null) {
      const [, version, file] = starter;
      const local = path.join(STARTERS_PKG_DIR, file!);
      if (opts.allowStarters === false || version !== index.version || !fs.existsSync(local)) {
        policy.blocked.push(url);
        return route.abort('connectionrefused');
      }
      policy.starters.push(file!);
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
        body: fs.readFileSync(local),
      });
    }
    if (opts.allowJsDelivr && url.startsWith(JSDELIVR_NPM)) {
      policy.passed.push(url);
      return route.continue();
    }
    policy.blocked.push(url);
    return route.abort('connectionrefused');
  });
  return policy;
}

/** Console noise that is not a defect: aborted loads and source-map CSP notes. */
const BENIGN = [
  /\.map['"]? violates the following Content Security Policy/i,
  /Failed to load resource/i,
  /net::ERR_/i,
];
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !BENIGN.some((re) => re.test(message.text()))) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/**
 * The probe app (AC6/AC7): announces, renders `host-ready.capabilities` into `#caps`,
 * fires ONE app-message so the pinned brain answers, attempts a fetch (which the runner's
 * CSP must block before any request exists) and records the `securitypolicyviolation`
 * the frame receives. Hand-rolled bridge frames, CDN-free — the runner is the thing
 * under test.
 */
export function capsAppHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>caps probe</title></head>
<body>
<div id="status">connecting</div>
<pre id="caps"></pre>
<div id="fetch"></div>
<div id="csp"></div>
<script>
(function () {
  var V = 1, instanceId = null, sent = false, announced = false;
  function set(id, text) { document.getElementById(id).textContent = text; }
  document.addEventListener('securitypolicyviolation', function (e) {
    set('csp', 'violation:' + e.violatedDirective + ':' + (e.blockedURI || ''));
  });
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || d.v !== V) return;
    if (d.type === 'snug:host-ready') {
      instanceId = d.instanceId;
      set('caps', JSON.stringify(d.capabilities));
      if (!announced) {
        announced = true;
        parent.postMessage({ v: V, type: 'snug:app-announce', appId: 'caps-probe', displayName: 'caps probe',
          description: 'capability probe', iconEmoji: '\\ud83d\\udd0d', iconColor: '#e8853b' }, '*');
      }
      if (!sent) {
        sent = true;
        parent.postMessage({ v: V, type: 'snug:app-message', requestId: 'req-1', instanceId: instanceId,
          appId: 'caps-probe', action: 'probe', payload: { ping: 1 }, state: {}, responseSchema: { answer: 'string' } }, '*');
        set('status', 'sent');
        fetch('https://example.com/probe').then(function (r) { set('fetch', 'ok:' + r.status); })
          .catch(function (e) { set('fetch', 'blocked:' + (e && e.message)); });
      }
      return;
    }
    if (d.type === 'snug:app-response' && d.requestId === 'req-1') {
      if (d.streaming) { set('status', 'streaming'); return; }
      // The error CODE is part of the truth: CONSENT_REQUIRED here would mean the F15 gate
      // armed with no card to clear it (Gate-5 finding, 2026-09-05).
      set('status', d.ok ? 'done' : 'error:' + ((d.error && d.error.code) || 'unknown'));
    }
  });
})();
</script>
</body></html>`;
}

/**
 * A user file built in Node with the real package (review #12/#19/#27): the probe app as
 * an owned row, plus settings that would route every turn AWAY from the demo brain on the
 * web — `mode: local` and a BYOK key — so the kit's platform brain seat is seen to outrank
 * the file (AC3) and the secret to be left behind (AC9).
 */
export async function buildProbeUserFile(): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');
  const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (opened.status !== 'ok') throw new Error(`fixture user db: ${opened.status}`);
  const db = opened.userDb;
  db.installApp({ displayName: 'caps probe', html: capsAppHtml(), usesDb: true });
  db.setSetting('mode', 'local');
  db.setSecret('byok:anthropic', 'sk-ant-e2e-must-never-be-used');
  const bytes = await db.exportUserDb({ includeSecrets: true });
  await db.close();
  return Buffer.from(bytes);
}
