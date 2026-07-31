// smoke.ts — boots the app with the mock adapter, runs one scripted /invoke chat turn
// through createHttpTransport (the real runner transport client), verifies the artifact
// was produced and served with the runner CSP, and prints PASS/FAIL.

import { createHttpTransport } from '@snugprotocol/adapters';
import { RUNNER_CSP } from '@snugprotocol/runner/dist/csp.js';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? 'ok' : 'FAIL'} — ${name}${!ok && detail !== undefined ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const config = loadConfig({ ...process.env, SNUG_ADAPTER: 'mock', SNUG_DATA_DIR: ':memory:', PORT: '0' });
const app = await buildApp({ config });
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
if (address === null || typeof address === 'string') throw new Error('no listen address');
const base = `http://127.0.0.1:${address.port}`;

console.log(`smoke: server up at ${base} (adapter: mock)`);

const transport = createHttpTransport(`${base}/invoke`, { threadId: 'smoke-thread' });
const deltas: string[] = [];
const result = await transport.send('Build me a demo app', {
  signal: new AbortController().signal,
  onDelta: (delta) => deltas.push(delta),
});

check('/invoke turn completed', result.ok, result.ok ? undefined : `${result.code}: ${result.message}`);
check('deltas were streamed', deltas.length > 0);
if (result.ok) check('done text equals accumulated deltas', result.text === deltas.join(''));

const listResponse = await fetch(`${base}/artifacts`);
const listBody = (await listResponse.json()) as { artifacts: Array<{ id: string; displayName: string }> };
check('one artifact persisted', listBody.artifacts.length === 1, `got ${listBody.artifacts.length}`);

const artifact = listBody.artifacts[0];
if (artifact !== undefined) {
  const artifactResponse = await fetch(`${base}/artifacts/${artifact.id}`);
  const html = await artifactResponse.text();
  check('artifact HTML served', artifactResponse.status === 200 && html.includes('Snug Demo Counter'));
  check(
    'CSP header is byte-exact RUNNER_CSP',
    artifactResponse.headers.get('content-security-policy') === RUNNER_CSP,
  );
  check('nosniff header present', artifactResponse.headers.get('x-content-type-options') === 'nosniff');
}

await app.close();

if (failures.length === 0) {
  console.log('SMOKE PASS');
} else {
  console.log(`SMOKE FAIL: ${failures.join(', ')}`);
  process.exitCode = 1;
}
