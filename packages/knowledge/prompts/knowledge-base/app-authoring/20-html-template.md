<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool; the primary section the host LLM retrieves before writing any app; reachable only when the app-builder capability is enabled
blast-radius: the literal skeleton and hook code copied into every generated app — any edit here changes every app built after it; hook code must stay byte-identical to the SDK reference (a sync test locks them together)
source: rewritten for Snug v0.1 from ancestor KBs (internal/05); hook code is the Snug SDK reference implementation
-->

# The Mandatory HTML Template

## Single-File Rule

Every Snug app is ONE self-contained HTML file, at most {{maxArtifactBytes}}. No separate
`.css` or `.js` files, no build step, no npm. React 18, ReactDOM, and Babel-standalone load
as UMD scripts from the allowed CDNs ({{cdnAllowlist}}). All styles live in one `<style>`
block; all logic lives in one `<script type="text/babel">` block.

The template below has two zones:

- **Copy exactly** — the bridge runtime and hooks (sections 1–4). Never rename, reorder,
  edit, or "improve" this code. It is the app-side SDK and the host depends on its behavior.
- **Yours** — the styles, the response schema, and the `App` component (sections 5–6).

## Full Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App Title</title>
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
  <!-- Domain libraries: UMD/browser builds only, from the allowed CDNs. See "CDN Compatibility". -->
  <style>
    :root {
      --bg: #ffffff; --fg: #17171f; --muted: #6b7280;
      --card: #f4f4f8; --border: #e2e2ea; --accent: #6c5ce7;
    }
    :root[data-theme="dark"] {
      --bg: #15151d; --fg: #ececf4; --muted: #9a9aad;
      --card: #20202c; --border: #32323f; --accent: #8b7cf7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--fg);
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    button { min-width: 44px; min-height: 44px; cursor: pointer; }
    /* App-specific styles go here. Use the custom properties above for EVERY color. */
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    // ============================================================
    // 1. SNUG BRIDGE RUNTIME (MANDATORY — copy exactly, never edit)
    // ============================================================
    const SnugBridge = {
      instanceId: null,
      theme: 'light',
      capabilities: {},
      ready: false,
      pending: new Map(),    // requestId -> { resolve, onStream }
      dbPending: new Map(),  // requestId -> resolve
      listeners: new Set(),  // re-render triggers for hooks

      post(frame) {
        window.parent.postMessage({ v: 1, instanceId: this.instanceId, ...frame }, '*');
      },
      notify() { for (const fn of this.listeners) fn(); },
    };

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.v !== 1) return;

      if (data.type === '{{frameType:hostReady}}') {
        SnugBridge.instanceId = data.instanceId;
        if (data.theme) SnugBridge.theme = data.theme;
        if (data.capabilities) SnugBridge.capabilities = data.capabilities;
        SnugBridge.ready = true;
        SnugBridge.notify();
        return;
      }

      if (data.type === '{{frameType:appResponse}}') {
        const entry = SnugBridge.pending.get(data.requestId);
        if (!entry) return; // unknown or superseded requestId — ignore
        if (data.streaming) {
          // Cumulative provisional text — display only. NEVER resolve here.
          if (entry.onStream && typeof data.text === 'string') entry.onStream(data.text);
          return;
        }
        SnugBridge.pending.delete(data.requestId); // terminal — exactly one per requestId
        entry.resolve(data.ok ? { ok: true, data: data.data } : { ok: false, error: data.error });
        return;
      }

      if (data.type === '{{frameType:dbResponse}}') {
        const resolve = SnugBridge.dbPending.get(data.requestId);
        if (!resolve) return;
        SnugBridge.dbPending.delete(data.requestId);
        resolve(data.ok ? { ok: true, data: data.data } : { ok: false, error: data.error });
        return;
      }

      if (data.type === '{{frameType:hostEvent}}') {
        if (data.event === 'theme-change' && data.payload && data.payload.theme) {
          SnugBridge.theme = data.payload.theme;
          SnugBridge.notify();
        }
        // Unknown host events MUST be ignored (the protocol is additive).
      }
    });

    function snugDbRequest(op, args) {
      return new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        SnugBridge.dbPending.set(requestId, resolve);
        SnugBridge.post({ type: '{{frameType:dbRequest}}', requestId, op, ...args });
      });
    }

    // ============================================================
    // 2. useSnugApp (MANDATORY — copy exactly, never edit)
    // ============================================================
    function useSnugApp(meta) {
      const [, setTick] = useState(0);
      const [isWaiting, setIsWaiting] = useState(false);
      const [lastResponse, setLastResponse] = useState(null);
      const inFlight = useRef(0);
      const metaRef = useRef(meta);

      useEffect(() => {
        const rerender = () => setTick((n) => n + 1);
        SnugBridge.listeners.add(rerender);
        const m = metaRef.current;
        SnugBridge.post({
          type: '{{frameType:announce}}',
          appId: m.appId,
          displayName: m.displayName,
          description: m.description,
          iconEmoji: m.iconEmoji,
          iconColor: m.iconColor,
        });
        return () => SnugBridge.listeners.delete(rerender);
      }, []);

      const sendMessage = useCallback((action, payload, opts) => {
        const requestId = crypto.randomUUID(); // fresh per request — multiple in flight are legal
        inFlight.current += 1;
        setIsWaiting(true);
        return new Promise((resolve) => {
          SnugBridge.pending.set(requestId, {
            onStream: opts && opts.onStream,
            resolve: (result) => {
              inFlight.current -= 1;
              if (inFlight.current === 0) setIsWaiting(false);
              setLastResponse(result);
              resolve(result);
            },
          });
          SnugBridge.post({
            type: '{{frameType:appMessage}}',
            requestId,
            appId: metaRef.current.appId,
            action,
            payload,
            state: opts && opts.state,
            responseSchema: opts && opts.responseSchema,
          });
        });
      }, []);

      return {
        isReady: SnugBridge.ready,
        theme: SnugBridge.theme,
        isWaiting,
        lastResponse,
        sendMessage,
      };
    }

    // ============================================================
    // 3. usePersistedState (MANDATORY — copy exactly, never edit)
    // Storage is HOST-BROKERED key-value. The sandboxed iframe has a
    // null origin: no browser storage API works here.
    // ============================================================
    function usePersistedState(key, initialValue) {
      const [state, setState] = useState(initialValue);
      const [hydrated, setHydrated] = useState(false);
      const initialRef = useRef(initialValue);

      useEffect(() => {
        let cancelled = false;
        const hydrate = async () => {
          const result = await snugDbRequest('kvGet', { key });
          if (cancelled) return;
          if (result.ok && result.data && result.data.value != null) {
            const stored = result.data.value;
            const init = initialRef.current;
            // Merge objects with defaults so fields added in newer code are never undefined.
            setState(
              stored && typeof stored === 'object' && !Array.isArray(stored) &&
              init && typeof init === 'object' && !Array.isArray(init)
                ? { ...init, ...stored }
                : stored
            );
          }
          setHydrated(true);
        };
        const onReady = () => {
          if (!SnugBridge.ready) return;
          SnugBridge.listeners.delete(onReady);
          hydrate();
        };
        if (SnugBridge.ready) hydrate();
        else SnugBridge.listeners.add(onReady);
        return () => { cancelled = true; SnugBridge.listeners.delete(onReady); };
      }, [key]);

      useEffect(() => {
        if (!hydrated) return;
        snugDbRequest('kvSet', { key, value: state }); // fire-and-forget; host acks via db-response
      }, [hydrated, key, state]);

      return [state, setState];
    }

    // ============================================================
    // 4. useAppDB (copy exactly when the app needs SQL; omit otherwise)
    // ============================================================
    function useAppDB() {
      return useMemo(() => ({
        async exec(sql, params) {
          const result = await snugDbRequest('exec', { sql, params });
          if (!result.ok) throw new Error((result.error && result.error.message) || 'db exec failed');
          return result.data; // { rows, rowsAffected }
        },
        async exportDb() {
          const result = await snugDbRequest('export', {});
          if (!result.ok) throw new Error((result.error && result.error.message) || 'db export failed');
          return result.data.bytesBase64;
        },
        async importDb(bytesBase64) {
          const result = await snugDbRequest('import', { bytesBase64 });
          if (!result.ok) throw new Error((result.error && result.error.message) || 'db import failed');
        },
      }), []);
    }

    // ============================================================
    // 5. RESPONSE SCHEMA — describe the JSON the agent must return
    // ============================================================
    const RESPONSE_SCHEMA = {
      kind: "string: 'move' | 'game_over' | 'error'",
      move: { from: 'string, e.g. "e7"', to: 'string, e.g. "e5"' },
      message: 'string: human-readable commentary (ALWAYS include)',
      gameOver: 'boolean (optional)',
      winner: "string (optional): 'player' | 'ai' | 'draw'",
    };

    // ============================================================
    // 6. YOUR APP
    // ============================================================
    function App() {
      const { isReady, theme, isWaiting, sendMessage } = useSnugApp({
        appId: 'your-app-id',
        displayName: 'Your App Name',           // max 80 chars
        description: 'One sentence on what this app does.', // max 400 chars
        iconEmoji: '🎮',
        iconColor: '#6c5ce7',
      });
      const [gameState, setGameState] = usePersistedState('your-app-state', {
        // COMPLETE initial state: every array [], every object {}, every number 0.
      });

      useEffect(() => {
        document.documentElement.dataset.theme = theme;
      }, [theme]);

      const handlePlayerAction = async (actionData) => {
        const result = await sendMessage('player_move', actionData, {
          state: gameState,               // FULL state — the agent has no memory of prior turns
          responseSchema: RESPONSE_SCHEMA,
        });
        if (!result.ok) {
          // Errors are data — render them in your UI, never crash. See "Bridge Protocol".
          return;
        }
        const reply = result.data; // already a parsed object matching RESPONSE_SCHEMA
        setGameState((prev) => ({ ...prev /* apply reply fields */ }));
      };

      if (!isReady) return <div className="connecting">Connecting…</div>;
      return (
        <main>
          {/* Your UI. Show a thinking indicator while isWaiting is true. */}
        </main>
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>
```

## App Metadata

`useSnugApp` takes the app's identity object. Fill in real values: `appId` (stable
kebab-case id), `displayName` (max 80 chars), `description` (max 400 chars), `iconEmoji`,
and `iconColor` (any CSS color). The host uses these to pin and display the app; `appId` is
display metadata, not a security identity.

## sendMessage Options

`sendMessage(action, payload, opts?)`:

- `action` — a short verb string naming what happened (max 128 chars), e.g. `'player_move'`.
- `payload` — a JSON-serializable object with the action's data.
- `opts.state` — the FULL current app state. Always pass it: each request is self-contained.
- `opts.responseSchema` — the shape you expect back. Always pass it.
- `opts.onStream(text)` — optional; called with CUMULATIVE display text while the agent
  streams. Never treat streamed text as the answer — only the resolved Promise is final.

The returned Promise ALWAYS resolves (never rejects): `{ok: true, data}` on success,
`{ok: false, error}` on failure. Handle both branches.
