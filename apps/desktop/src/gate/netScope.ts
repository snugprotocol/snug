// The http scope, asked of the REAL plugin (TASK-20261008-p0-clearance W3).
//
// `src-tauri/src/http_scope.rs` proves what `capabilities/main.json` admits with a copy of the
// plugin's private matcher; this asks tauri-plugin-http itself, inside the shell, from the main
// window, so a drift between that copy and the plugin cannot pass both. `plugin:http|fetch`
// checks the scope BEFORE it stores a lazy request (commands.rs:304-328) and nothing touches the
// network until `fetch_send`, so an admitted URL answers with a resource id and opens no socket;
// a refused one rejects with the plugin's Display string. Any OTHER rejection means this check
// cannot tell, and fails — a gate that reads "some error" as "refused" vouches for nothing.
//
// No probe URL here names the debug stub (127.0.0.1 on the gate's stub port): this module ships
// in the debug bundle and the driver's remap-absent-from-release-bundle check scans for it.

import { invoke } from '@tauri-apps/api/core';

import type { CheckResult } from './types.js';

export const NET_SCOPE_CHECK_IDS = [
  'net-scope-rfc1918-http-admitted',
  'net-scope-non-private-http-refused',
  'net-scope-https-any-port-admitted',
  'net-scope-https-loopback-denied',
] as const;

/** tauri-plugin-http 2.5.9 `Error::UrlNotAllowed`, serialised through its Display (error.rs:22-24, 48-55). */
export const SCOPE_REFUSAL = 'url not allowed on the configured scope';

export const PROBES = {
  'net-scope-rfc1918-http-admitted': ['http://10.255.255.254/', 'http://172.31.255.254/', 'http://192.168.255.254:8787/v1/bundles'],
  'net-scope-non-private-http-refused': ['http://172.32.0.1/', 'http://11.0.0.1/', 'http://192.169.0.1/', 'http://127.0.0.1:8080/', 'http://localhost:11434/'],
  'net-scope-https-any-port-admitted': ['https://example.com:8443/', 'https://192.168.255.254:5001/'],
  'net-scope-https-loopback-denied': ['https://localhost:6443/', 'https://foo_bar.localhost:6443/', 'https://127.0.0.1:8443/', 'https://0.0.0.0:8443/', 'https://169.254.169.254:80/', 'https://[::1]:6443/'],
} as const satisfies Record<(typeof NET_SCOPE_CHECK_IDS)[number], readonly string[]>;

export interface FetchOutcome {
  url: string;
  rid?: number;
  error?: string;
}

/** Admitted = the plugin handed back a resource id for every URL. */
export function decideAdmitted(id: string, outcomes: FetchOutcome[]): CheckResult {
  const bad = outcomes.filter((o) => typeof o.rid !== 'number');
  if (outcomes.length === 0) return { id, pass: false, detail: 'no probe ran' };
  return bad.length === 0
    ? { id, pass: true, detail: `the plugin admitted all ${outcomes.length}: ${outcomes.map((o) => o.url).join(', ')}` }
    : { id, pass: false, detail: `NOT admitted: ${bad.map((o) => `${o.url} (${o.error ?? 'no resource id'})`).join('; ')}` };
}

/** Refused = the plugin rejected every URL with ITS scope refusal — and nothing else. */
export function decideRefused(id: string, outcomes: FetchOutcome[]): CheckResult {
  if (outcomes.length === 0) return { id, pass: false, detail: 'no probe ran' };
  const admitted = outcomes.filter((o) => typeof o.rid === 'number');
  const other = outcomes.filter((o) => typeof o.rid !== 'number' && !(o.error ?? '').includes(SCOPE_REFUSAL));
  if (admitted.length > 0) return { id, pass: false, detail: `ADMITTED (the scope is open): ${admitted.map((o) => o.url).join(', ')}` };
  if (other.length > 0) return { id, pass: false, detail: `cannot tell — rejected for another reason: ${other.map((o) => `${o.url} (${o.error})`).join('; ')}` };
  return { id, pass: true, detail: `the plugin refused all ${outcomes.length} by scope: ${outcomes.map((o) => o.url).join(', ')}` };
}

async function probe(url: string): Promise<FetchOutcome> {
  try {
    const rid = await invoke<number>('plugin:http|fetch', {
      clientConfig: { method: 'GET', url, headers: [], data: null, maxRedirections: 0 },
    });
    // Drop the lazy request: nothing was sent, and nothing will be.
    await invoke('plugin:http|fetch_cancel', { rid }).catch(() => undefined);
    return { url, rid };
  } catch (err) {
    return { url, error: String(err) };
  }
}

export async function runNetScopeChecks(): Promise<CheckResult[]> {
  const run = async (urls: readonly string[]): Promise<FetchOutcome[]> => Promise.all(urls.map(probe));
  return [
    decideAdmitted('net-scope-rfc1918-http-admitted', await run(PROBES['net-scope-rfc1918-http-admitted'])),
    decideRefused('net-scope-non-private-http-refused', await run(PROBES['net-scope-non-private-http-refused'])),
    decideAdmitted('net-scope-https-any-port-admitted', await run(PROBES['net-scope-https-any-port-admitted'])),
    decideRefused('net-scope-https-loopback-denied', await run(PROBES['net-scope-https-loopback-denied'])),
  ];
}
