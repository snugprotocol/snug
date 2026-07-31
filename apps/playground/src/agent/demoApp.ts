// demoApp.ts — the app the "demo brain" (mock adapter, BYOK with no key) builds.
// Deliberately CDN-free vanilla JS so it runs fully offline, yet speaks the real
// bridge protocol: announce → host-ready → app-message → renders the agent's reply.
// The wire literals are injected from @snugprotocol/protocol — never retyped.

import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

export const DEMO_APP_TITLE = 'the oracle (demo)';

export const DEMO_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${DEMO_APP_TITLE}</title>
<style>
  :root { --bg:#ffffff; --fg:#17171f; --muted:#6b7280; --card:#f4f4f8; --accent:#c96f1e; }
  :root[data-theme="dark"] { --bg:#171310; --fg:#f3ece1; --muted:#b3a48f; --card:#241d16; --accent:#e8873a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family: system-ui, sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; }
  main { width:min(420px, 92vw); text-align:center; }
  h1 { font-family: Georgia, serif; }
  button { min-width:44px; min-height:44px; cursor:pointer; border:1px solid var(--accent);
           background:var(--accent); color:#fff; border-radius:10px; padding:0 20px; font-size:1rem; }
  #answer { margin-top:20px; padding:16px; border-radius:12px; background:var(--card); min-height:56px; }
  .muted { color: var(--muted); font-size:.85rem; }
</style>
</head>
<body>
<main>
  <h1>the oracle</h1>
  <p class="muted" id="status">connecting…</p>
  <button id="ask" disabled>ask the oracle</button>
  <div id="answer"></div>
</main>
<script>
(function () {
  var V = ${PROTOCOL_VERSION};
  var instanceId = null;
  var pending = {};
  var statusEl = document.getElementById('status');
  var askEl = document.getElementById('ask');
  var answerEl = document.getElementById('answer');

  function post(frame) { window.parent.postMessage(Object.assign({ v: V }, frame), '*'); }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.v !== V) return;
    if (data.type === '${FRAME_TYPES.hostReady}') {
      instanceId = data.instanceId;
      if (data.theme) document.documentElement.dataset.theme = data.theme;
      statusEl.textContent = 'connected';
      askEl.disabled = false;
      return;
    }
    if (data.type === '${FRAME_TYPES.appResponse}') {
      var entry = pending[data.requestId];
      if (!entry) return;
      if (data.streaming) { answerEl.textContent = String(data.text || ''); return; }
      delete pending[data.requestId];
      askEl.disabled = false;
      statusEl.textContent = 'connected';
      answerEl.textContent = data.ok
        ? String((data.data && data.data.message) || '(silence)')
        : 'error: ' + ((data.error && data.error.message) || 'unknown');
      return;
    }
    if (data.type === '${FRAME_TYPES.hostEvent}') {
      if (data.event === 'theme-change' && data.data && data.data.theme) {
        document.documentElement.dataset.theme = data.data.theme;
      }
    }
  });

  askEl.addEventListener('click', function () {
    if (!instanceId) return;
    var requestId = (crypto.randomUUID && crypto.randomUUID()) || 'req-' + Date.now();
    pending[requestId] = true;
    askEl.disabled = true;
    statusEl.textContent = 'it\\u2019s thinking\\u2026';
    post({
      type: '${FRAME_TYPES.appMessage}',
      instanceId: instanceId,
      requestId: requestId,
      appId: 'oracle-demo',
      action: 'ask',
      payload: { question: 'what should I build next?' },
      responseSchema: { kind: "string: 'answer'", message: 'string: the oracle\\u2019s reply (ALWAYS include)' }
    });
  });

  post({
    type: '${FRAME_TYPES.announce}',
    appId: 'oracle-demo',
    displayName: '${DEMO_APP_TITLE}',
    description: 'ask a question, get a suspiciously confident answer.',
    iconEmoji: '\\uD83D\\uDD2E',
    iconColor: '#8b5cf6'
  });
})();
</script>
</body>
</html>
`;

/** The JSON-only reply the demo brain gives to any app-mode request. */
export const DEMO_APP_REPLY = JSON.stringify({
  kind: 'answer',
  message: 'the demo brain says: build the thing you keep describing to your friends.',
});
