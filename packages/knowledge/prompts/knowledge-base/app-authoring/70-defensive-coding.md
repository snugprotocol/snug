<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries error handling, crashes, or prohibited patterns; reachable only when the app-builder capability is enabled
blast-radius: the crash rate of generated apps — removing a guard rule here reintroduces the runtime failures the ancestors shipped
source: rewritten for Snug v0.1 from ancestor KBs (internal/05), "What NOT to Do" carried and re-targeted at the Snug bridge
-->

# Defensive Coding

## Why This Section Exists

The app runs in an iframe with NO error recovery — one uncaught exception kills the whole
app for the user. These rules are not style preferences; each one prevents a class of
shipped crash.

## What NOT to Do

- Do NOT call `fetch()` or `XMLHttpRequest` — the CSP blocks all network from the iframe.
  Everything goes through the bridge; for external APIs that means `useConnectedFetch`,
  which asks the HOST to make the call — see "Connected APIs".
- Do NOT touch `localStorage`, `sessionStorage`, cookies, or IndexedDB — the null-origin
  sandbox has no working browser storage. Use `usePersistedState` / `useAppDB` only.
- Do NOT hand-roll `postMessage` plumbing, rename the hooks, or "improve" the bridge
  runtime — copy it exactly from the template.
- Do NOT invent frame types or event names in the reserved `snug:` namespace.
- Do NOT open new windows, create nested iframes, or navigate the page.
- Do NOT assume the agent remembers anything — send FULL state in every request.
- Do NOT load CommonJS/Node builds via `<script>` — see "CDN Compatibility".
- Do NOT leave state fields uninitialized — every array `[]`, every object `{}`, every
  number `0`, every flag `false`.
- Do NOT trust agent output: validate moves/SQL/values before applying them.

## Initialize Complete State

```javascript
// WRONG — crashes on first render when .map() hits undefined
const [captured, setCaptured] = useState();

// RIGHT — complete, valid defaults for every field
const [gameState, setGameState] = usePersistedState('game-state', {
  board: createInitialBoard(),
  captured: { player: [], ai: [] },
  moveHistory: [],
  currentTurn: 'player',
  gameOver: false,
  winner: null,
});
```

Mentally run your render against the initial state — if it would crash before the first
interaction, it is broken.

## Guard Every Collection and Property Access

```javascript
// WRONG
captured.map((p) => ...)
const score = state.scores.player;

// RIGHT
(captured || []).map((p) => ...)
const score = state?.scores?.player ?? 0;
```

The persisted-state hook merges stored objects over your defaults, but nested shapes and
agent-supplied data still need guards.

## Handle ok:false Everywhere

`sendMessage` never throws — it resolves `{ok: false, error}` on failure. EVERY call site
handles both branches, and errors become UI, not exceptions:

```javascript
const result = await sendMessage('player_move', payload, opts);
if (!result.ok) {
  const { code, message, retryable, rawExcerpt, attemptsRemaining } = result.error;
  if (code === 'PARSE_FAILED') {
    setNotice(`The AI answered in the wrong format (${attemptsRemaining} tries left).`);
    // Optionally show rawExcerpt in a collapsed details element. When the budget is
    // exhausted the HOST shows a reset affordance — do not build your own reset loop.
  } else if (code === 'CANCELLED' || code === 'SUPERSEDED') {
    // Stale by design — discard quietly.
  } else {
    setNotice(message + (retryable ? ' — tap to retry.' : ''));
  }
  return; // state stays intact; the user can act again
}
```

Never auto-retry in an unbounded loop; retry once on user action when `retryable` is true.

## JSON-Only Reply Discipline (both sides)

- App side: always send `responseSchema`, always expect `data` as an already-parsed object,
  and never parse streamed `onStream` text — it is provisional prose, not the answer.
- If a reply's fields are missing or the wrong type, treat it like an error state (render a
  notice), don't index into `undefined`.

## Multiple In-Flight Requests

The bridge correlates responses by `requestId` in a map, so concurrent requests are safe at
the protocol level. In app logic:

- Turn-based flows: disable the triggering input while `isWaiting` so users cannot
  double-move.
- Independent flows (e.g. a hint request alongside a move): fine — each `sendMessage`
  Promise resolves with its own result; just make sure applying result B does not clobber
  the state written by result A (use functional `setState((prev) => ...)` updates).
- Discard stale results: if the user restarted the game while a request was in flight,
  check a generation counter before applying the reply.

## Startup Order

Wait for `isReady` before enabling actions that call `sendMessage`. The persisted-state
hook already defers hydration until the host is ready — render with defaults meanwhile, and
never block first paint on the bridge.
