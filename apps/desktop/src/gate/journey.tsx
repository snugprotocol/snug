// Wizard journey 1 INSIDE the shell (TASK-20260812 P4, AC8).
//
// Mirrors apps/playground/e2e/connection-wizard.spec.ts journey 1 (api_key
// MULTI-FIELD, the three-secret HMAC shape) end to end, through the REAL App
// rendered exactly as the normal desktop boot renders it, driven by real DOM
// events on the same testids/labels the e2e uses. The provider is the demo
// brain's `?demoreq=coinbase` variant — the same production-path seam the e2e
// leans on — whose app dials the requirement's DECLARED host; only resolution
// is local, via the debug-gate host remap (the desktop twin of Playwright's
// `--host-resolver-rules`). NO host literal lives in this file: the journey
// host and its loopback target come exclusively from the gate config.
//
// Verdict collection where the e2e uses frameLocator: a sandboxed srcdoc
// iframe is an OPAQUE origin, so the embedding page cannot read its DOM — by
// design, and Playwright's out-of-band inspector is exactly what a self-driving
// in-page harness does not have. The journey therefore proves the same facts
// through three observable channels:
//   1. the REAL RunView iframe's `snug:net-request` frame is observed at the
//      host window (it is sent only after `snug:host-ready` arrives INSIDE the
//      sandboxed iframe — so seeing it proves host→iframe postMessage delivery
//      and app boot under the shell's webview);
//   2. the net stub RECORDS the request it served — the HMAC-signed headers
//      arrived (presence-only markers), and no raw secret ever hit the wire;
//   3. an instrumented TWIN of the demo app (same sandbox, same bridge shape)
//      renders the response through the PRODUCTION net handler and self-reports
//      its rendered DOM — the same trust model as the CSP checks' verdicts.

import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

import { App } from '@playground/App';
import { createNetHandlerFor } from '@playground/state/net.js';
import type { NetRequestFrame } from '@snugprotocol/protocol';

import type { ShellGateConfig } from './config.js';
import type { JourneyResult, JourneyStep } from './types.js';
import { fillReactInput, findByText, q, waitFor } from './dom.js';

// The e2e's canary secrets, verbatim (connection-wizard.spec.ts): the SECRET is
// standard base64 because `hmac_sha256_b64` decodes it before signing.
const CB_KEY = 'e2e-cb-key-1111';
const CB_SECRET = 'ZTJlLWNiLXNlY3JldC0yMjIyLW5vdC1hLXJlYWwtc2VjcmV0';
const CB_PASSPHRASE = 'e2e-cb-passphrase-3333';
const SECRETS = [CB_KEY, CB_SECRET, CB_PASSPHRASE];

export const JOURNEY_STEPS = [
  'boot-app',
  'build-app',
  'open-wizard',
  'approve-connection',
  'register-continue',
  'fill-credentials-and-save',
  'wizard-done',
  'no-secrets-in-dom-after-wizard',
  'run-app',
  'iframe-net-request-observed',
  'stub-saw-signed-headers',
  'sandboxed-reply-rendered',
  'no-secrets-in-dom-final',
] as const;

function wizardEl(): HTMLElement {
  const el = q(document, '[data-testid="connection-wizard"]');
  if (el === null) throw new Error('connection wizard is not on screen');
  return el as HTMLElement;
}

function assertNoSecretsIn(text: string, where: string): void {
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`C1 VIOLATION: secret material found in ${where}`);
  }
}

interface StubRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export async function runJourney(config: ShellGateConfig): Promise<JourneyResult> {
  const steps: JourneyStep[] = [];
  const remapHosts = Object.keys(config.remap);
  const stubOrigin = Object.values(config.remap)[0];
  let aborted = false;

  const run = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
    if (aborted) {
      steps.push({ step: name, ok: false, detail: 'not-run (earlier step failed)' });
      return;
    }
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, detail: detail ?? '' });
    } catch (err) {
      steps.push({ step: name, ok: false, detail: String(err) });
      aborted = true;
    }
  };

  // Bridge snoop: frames the sandboxed app posts to its parent surface here on
  // the host window. Registered before anything renders so no frame is missed.
  const netRequests: string[] = [];
  const snoop = (event: MessageEvent): void => {
    const d = event.data as { v?: number; type?: string; url?: string } | null;
    if (d != null && d.v === 1 && d.type === 'snug:net-request' && typeof d.url === 'string') {
      netRequests.push(d.url);
    }
  };
  window.addEventListener('message', snoop);

  let capturedNetUrl = '';
  let runAppId = '';

  // Surface any render-time error into the step detail (React swallows async
  // errors otherwise, leaving only an opaque boot timeout).
  let firstError = '';
  const onError = (e: ErrorEvent): void => {
    if (firstError === '') firstError = `${e.message} @ ${e.filename}:${e.lineno}`;
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    if (firstError === '') firstError = `unhandled rejection: ${String(e.reason)}`;
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  await run('boot-app', async () => {
    if (remapHosts.length === 0 || stubOrigin === undefined) {
      throw new Error('gate config carries no remap — journey cannot run without a stub target');
    }
    // The demo-brain seam reads window.location.search; HashRouter reads the
    // hash. Set both before React boots — same wiring as the e2e's page.goto.
    history.replaceState(null, '', `${location.pathname}?demoreq=coinbase#/build`);
    const container = document.getElementById('root');
    if (container === null) throw new Error('missing #root');
    createRoot(container).render(
      createElement(StrictMode, null, createElement(HashRouter, null, createElement(App))),
    );
    try {
      await waitFor(
        'builder composer',
        () => q<HTMLTextAreaElement>(document, 'textarea[aria-label="describe your app"]'),
        20_000,
      );
    } catch (err) {
      const bodyLen = document.body.innerHTML.length;
      const testids = Array.from(document.querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .slice(0, 20)
        .join(',');
      throw new Error(
        `${String(err)} | firstError=${firstError || 'none'} | bodyLen=${bodyLen} | testids=[${testids}]`,
      );
    }
    return `origin=${location.origin}`;
  });

  await run('build-app', async () => {
    const composer = q<HTMLTextAreaElement>(document, 'textarea[aria-label="describe your app"]');
    if (composer === null) throw new Error('composer vanished');
    fillReactInput(composer, 'build my connected app');
    const buildButton = await waitFor(
      'enabled build button',
      () => {
        const b = findByText(document, 'button', /^\s*build\s*$/);
        return b !== null && !b.disabled ? b : null;
      },
      5_000,
    );
    buildButton.click();
    await waitFor('artifact card', () => q(document, '[data-testid="artifact-card"]'), 30_000);
    await waitFor(
      'connection requirement card',
      () => q(document, '[data-testid="connection-requirement-card"]'),
      30_000,
    );
  });

  await run('open-wizard', async () => {
    const card = q(document, '[data-testid="connection-requirement-card"]');
    if (card === null) throw new Error('requirement card vanished');
    const connect = findByText(card, 'button', /connect/i);
    if (connect === null) throw new Error('no connect button on the requirement card');
    connect.click();
    const wizard = await waitFor('connection wizard', () => q(document, '[data-testid="connection-wizard"]'), 10_000);
    const template = await waitFor(
      'review header template',
      () => q(wizard as ParentNode, '[data-testid="review-header-template"]'),
      10_000,
    );
    const templateText = template.textContent ?? '';
    if (!templateText.includes('CB-ACCESS-SIGN') || !templateText.includes('{{request.timestamp}}')) {
      throw new Error('review header template missing the HMAC template seats');
    }
    const hosts = q(wizard as ParentNode, '[data-testid="review-hosts"]');
    const journeyHost = remapHosts[0];
    if (!(hosts?.textContent ?? '').includes(journeyHost)) {
      throw new Error(`review hosts does not name the declared provider host ${journeyHost}`);
    }
    return `declared host ${journeyHost} on the review screen`;
  });

  await run('approve-connection', async () => {
    const approve = findByText(wizardEl(), 'button', /approve this connection/i);
    if (approve === null) throw new Error('approve button missing');
    approve.click();
    await waitFor(
      'register walkthrough (3 steps)',
      () => (document.querySelectorAll('[data-testid="register-steps"] li').length === 3 ? true : null),
      10_000,
    );
  });

  await run('register-continue', async () => {
    const cont = findByText(wizardEl(), 'button', /i've got my credentials/i);
    if (cont === null) throw new Error('register-continue button missing');
    cont.click();
    await waitFor('credential fields', () => q(document, '#connection-field-api_key'), 10_000);
  });

  await run('fill-credentials-and-save', async () => {
    for (const [id, value] of [
      ['#connection-field-api_key', CB_KEY],
      ['#connection-field-api_secret', CB_SECRET],
      ['#connection-field-passphrase', CB_PASSPHRASE],
    ] as const) {
      const input = q<HTMLInputElement>(document, id);
      if (input === null) throw new Error(`missing credential input ${id}`);
      fillReactInput(input, value);
    }
    const save = findByText(wizardEl(), 'button', /save my credentials/i);
    if (save === null) throw new Error('save button missing');
    save.click();
    // A static kind never visits `connect`: the next screen is DONE.
    await waitFor('connected done screen', () => (/connected/i.test(wizardEl().textContent ?? '') ? true : null), 15_000);
  });

  await run('wizard-done', async () => {
    const done = findByText(wizardEl(), 'button', /^\s*done\s*$/i);
    if (done === null) throw new Error('done button missing');
    done.click();
    await waitFor('wizard closed', () => (q(document, '[data-testid="connection-wizard"]') === null ? true : null), 10_000);
  });

  await run('no-secrets-in-dom-after-wizard', async () => {
    assertNoSecretsIn(document.documentElement.outerHTML, 'the page DOM after the wizard closed');
    return 'three canary secrets absent from the serialized page';
  });

  await run('run-app', async () => {
    const runLink = findByText(document, 'a', /run it/i);
    if (runLink === null) throw new Error('run-it link missing');
    runLink.click();
    await waitFor('run route', () => (location.hash.startsWith('#/run/') ? true : null), 10_000);
    runAppId = decodeURIComponent(location.hash.slice('#/run/'.length).split('?')[0]);
    if (runAppId === '') throw new Error('run route carries no app id');
    return `app ${runAppId}`;
  });

  await run('iframe-net-request-observed', async () => {
    // Sent by the sandboxed app ONLY after `snug:host-ready` reached it — this
    // single observation proves srcdoc mount, sandbox script execution, and
    // host→iframe postMessage delivery inside the shell's webview.
    const url = await waitFor(
      'net-request frame from the RunView iframe',
      () => netRequests.find((u) => remapHosts.some((h) => u.includes(h))) ?? null,
      30_000,
    );
    capturedNetUrl = url;
    return `app dialed ${url}`;
  });

  await run('stub-saw-signed-headers', async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await tauriFetch(`${stubOrigin}/__gate/requests`);
      const body = (await res.json()) as { requests: StubRequest[] };
      const signed = body.requests.find(
        (r) => r.path === new URL(capturedNetUrl).pathname && r.headers['cb-access-sign'] === '***',
      );
      if (signed !== undefined) {
        if (signed.headers['cb-access-timestamp'] !== '***') {
          throw new Error('stub saw a signature without its timestamp seat');
        }
        // C1 on the wire: raw secrets must never appear in ANY recorded header
        // (the signature/timestamp markers are presence-only by stub contract).
        assertNoSecretsIn(JSON.stringify(body.requests), "the stub's recorded request headers");
        return `stub recorded ${signed.method} ${signed.path} with HMAC-signed headers present`;
      }
      if (Date.now() > deadline) {
        throw new Error(`stub never recorded a signed request for ${capturedNetUrl} (saw ${body.requests.length} requests)`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  await run('sandboxed-reply-rendered', async () => {
    const outcome = await runEchoLeg(runAppId, capturedNetUrl);
    if (outcome.status !== 'ok:200') {
      throw new Error(`instrumented app rendered ${outcome.status}: ${outcome.body.slice(0, 300)}`);
    }
    if (!outcome.body.includes('"sawSignature":"***"')) {
      throw new Error(`rendered body lacks the sawSignature marker: ${outcome.body.slice(0, 300)}`);
    }
    assertNoSecretsIn(outcome.body, 'the app-rendered response body');
    return 'sandboxed twin rendered ok:200 with "sawSignature":"***" and no secret material';
  });

  await run('no-secrets-in-dom-final', async () => {
    assertNoSecretsIn(document.documentElement.outerHTML, 'the page DOM after the run leg');
    return 'three canary secrets absent from the serialized page';
  });

  window.removeEventListener('message', snoop);
  const pass = steps.length === JOURNEY_STEPS.length && steps.every((s) => s.ok);
  return { steps, pass };
}

// ---------------------------------------------------------------------------
// The instrumented twin (channel 3 in the header comment): same sandbox, same
// render targets as the demo app, but it POSTS its rendered DOM back out —
// because that DOM is opaque to the embedder by design. The request runs
// through the PRODUCTION `createNetHandlerFor` seam against the SAME user db
// row the wizard just approved, so this leg re-proves executor + credentials +
// platform fetch + remap end to end with an observable verdict.

const sc = '<' + 'script>';
const scEnd = '</' + 'script>';

const ECHO_APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>gate echo</title></head><body>
<div id="net-status"></div><pre id="net-out"></pre>${sc}
(function () {
  function setText(id, t) { document.getElementById(id).textContent = t; }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'snug-gate-echo-response') return;
    var r = d.result;
    setText('net-status', r.ok ? ('ok:' + r.status) : ('err:' + (r.code || 'unknown')));
    setText('net-out', r.ok ? r.body : JSON.stringify(r));
    parent.postMessage({
      type: 'snug-gate-echo-rendered',
      status: document.getElementById('net-status').textContent,
      body: document.getElementById('net-out').textContent
    }, '*');
  });
  parent.postMessage({ type: 'snug-gate-echo-ready' }, '*');
})();
${scEnd}</body></html>`;

function runEchoLeg(appId: string, url: string): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    const cleanup = (): void => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('no rendered verdict from the instrumented iframe within 30s'));
    }, 30_000);
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) return;
      const d = event.data as { type?: string; status?: unknown; body?: unknown } | null;
      if (d == null) return;
      if (d.type === 'snug-gate-echo-ready') {
        // The PRODUCTION net handler: same deps assembly as RunView.
        const handler = createNetHandlerFor();
        const frame = { url, method: 'GET' } as unknown as NetRequestFrame;
        void handler.handle(appId, frame).then(
          (result) => iframe.contentWindow?.postMessage({ type: 'snug-gate-echo-response', result }, '*'),
          (err) =>
            iframe.contentWindow?.postMessage(
              { type: 'snug-gate-echo-response', result: { ok: false, code: 'HANDLER_THREW', message: String(err) } },
              '*',
            ),
        );
        return;
      }
      if (d.type === 'snug-gate-echo-rendered') {
        clearTimeout(timer);
        cleanup();
        resolve({ status: String(d.status ?? ''), body: String(d.body ?? '') });
      }
    };
    window.addEventListener('message', onMessage);
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.width = '320px';
    iframe.style.height = '200px';
    iframe.srcdoc = ECHO_APP_HTML;
    document.body.appendChild(iframe);
  });
}
