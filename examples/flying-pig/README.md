# flying pig

The origin-story arcade game: tap or press space to flap a pixel pig through wooden fence
towers. The agent is the flight coach.

## What it demos

- **The agent as game director**: after every run the app sends
  `sendMessage('run_over', {score, best, runsPlayed, lastDifficulty})` with a
  `responseSchema` of `{difficulty: {speed, gap}, message}`. The coach retunes the next
  run's obstacle speed and gap from your score, and heckles (or encourages) you in
  character.
- **Streaming**: the coach's line arrives via `opts.onStream`, so the taunt types itself
  into the speech bubble while the model is still talking.
- **Defensive by design**: difficulty replies are clamped (`speed` 0.6–2.5, `gap`
  130–240 px) and missing fields keep the previous values; if the reply errors or is raw
  text, the game nudges difficulty locally and keeps playing — the coach chip always shows
  the *actual* live settings.
- **Art with no images**: the pig (two wing frames), clouds, and terrain are pure CSS —
  `box-shadow` pixel sprites and gradients — because the sandbox allows no remote images.
- **Persistence**: best score, run count, and the coach's last tuning survive reloads via
  `usePersistedState`.

## Files

- `app.html` — the whole app. Hook block is byte-identical to
  `packages/sdk/embedded/snug-hooks.js`; everything after the `// 5. RESPONSE SCHEMA`
  banner is app code.
