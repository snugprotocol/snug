// net-harness.js — mounts the PRODUCTION SnugAppFrame with a REAL NetHandler built from
// the production connected-fetch executor (@snugprotocol/auth), wired to an in-memory
// SecretsQuartet + spec reader configured per __mount. This is the app half of AL-03's
// live sweep on real bytes: an app fetches through the bridge, the host injects the
// stored key, the response renders SCRUBBED. Every hop is the production postMessage
// bridge + the production executor. No JSX, no bundler.

import { SnugAppFrame } from '@snugprotocol/runner';
import { createConnectedFetch, UserDbCredentialStore, createSessionConfirmGate } from '@snugprotocol/auth';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

const React = window.React;
const { createRoot } = window.ReactDOM;

window.__netAnnounces = [];
window.__confirmPrompts = [];

let root = null;

/** In-memory SecretsQuartet — the shape UserDb exposes; enough for the static kinds. */
function memoryQuartet(seed) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    getSecret: (k) => map.get(k),
    setSecret: (k, v) => void map.set(k, v),
    deleteSecret: (k) => void map.delete(k),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

/**
 * __mount({ html, appId, spec, allowedHosts, status, apiKey, confirm }) — build a net
 * handler bound to `appId` and render the app. `confirm` ('allow'|'deny') decides the
 * mutating-call gate without UI (the executor calls it directly).
 */
window.__mount = (opts) => {
  const appId = opts.appId ?? 'e2e-net-app';
  // P3 CUTOVER: the harness drives the v4 `snug_connections` reader — the v3 spec reader
  // was deleted with its table at userdb v5. The `spec`/`status`/`allowedHosts` option
  // names are kept so every existing net.spec case reads unchanged; only the SHAPE handed
  // to the executor moved. `status: 'imported_unapproved'` becomes a `declared` row with
  // `imported: true`, which is how v4 expresses the same barred state.
  const slot = opts.slot ?? 'stub';
  const quartet = memoryQuartet({
    [authConnectionCredentialSecretKey(appId, slot, 'api_key')]: opts.apiKey ?? 'e2e-secret-key-9999',
  });
  const status = opts.status ?? 'approved';
  const connectionReader = {
    listConnections: (id) =>
      id === appId
        ? [
            {
              appId,
              slot,
              requirement: { ...opts.spec, slot },
              status: status === 'approved' ? 'approved' : 'declared',
              allowedHosts: opts.allowedHosts ?? [],
              ...(status === 'imported_unapproved' ? { imported: true } : {}),
            },
          ]
        : [],
  };
  const confirmGate = createSessionConfirmGate(async (request) => {
    window.__confirmPrompts.push(request);
    return { granted: opts.confirm !== 'deny' };
  });
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader,
    // The real browser fetch — the stub runs HTTPS with a self-signed cert; the net spec
    // scopes ignoreHTTPSErrors to its OWN context only.
    fetchImpl: (input, init) => window.fetch(input, init),
    confirmGate,
  });
  const netHandler = {
    handle: async (netAppId, frame) => {
      const result = await executor.execute(netAppId, {
        url: frame.url,
        method: frame.method,
        ...(frame.headers !== undefined ? { headers: frame.headers } : {}),
        ...(frame.body !== undefined ? { body: frame.body } : {}),
      });
      return result.ok
        ? { ok: true, status: result.status, headers: result.headers, body: result.body, truncated: result.truncated }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };

  function Harness() {
    return React.createElement(SnugAppFrame, {
      html: opts.html,
      transport: { async send() { return { ok: true, text: '{}' }; } },
      budgetKey: 'e2e-net',
      net: netHandler,
      netAppId: appId,
      theme: 'dark',
      title: 'e2e net frame',
      onAnnounce: (frame) => window.__netAnnounces.push(frame),
    });
  }

  if (root) root.unmount();
  const container = document.getElementById('root');
  root = createRoot(container);
  root.render(React.createElement(Harness));
};

window.__harnessReady = true;
