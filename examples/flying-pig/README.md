# flying pig feed!

The origin-story arcade game, ported to the contract as the **LLM-free exemplar**
(ADR-0011): aim a slingshot, throw food at flying pigs, chase combos. No model call
anywhere in the loop.

## What it demos

- **LLM-free by declaration**: `RESPONSE_SCHEMA = null` and the authored code never
  calls `sendMessage` — enforced by the validate suite's posture check. Reflexes, spawn
  timers, physics and scoring are all local; a round trip would only add latency to a
  game whose appeal is instant response. The agent's role ended when it authored the app.
- **Even an LLM-free app honors the handshake**: first paint is gated on `hostReady`,
  because the persisted high score hydrates through the bridge — the handshake is the
  contract, the agent call is not.
- **Dynamic difficulty, locally**: pig speed scales with the player's measured accuracy —
  the "game director" is a formula, not a model.
- **Persistence**: the high score survives reloads via `usePersistedState` (a read-only
  boot pattern — nothing writes until the first game ends).
- **Art with no images**: pigs, food, clouds and terrain are emoji + CSS gradients —
  the sandbox allows no remote images.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
