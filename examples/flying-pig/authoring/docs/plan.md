# Plan

Built as one file in five pieces (the whole app is `app.html`):

1. **The contract shell** — the embedded hook block, byte-identical to
   `packages/sdk/embedded/snug-hooks.js`; `RESPONSE_SCHEMA = null` under the ADR-0011
   posture comment; announce meta (`flying-pig-feed`, 🐷); first paint gated on
   `isReady` so the hydrating high score never flashes a 0.
2. **The loop** — three screens (`intro | playing | gameover`) in one component; a
   `requestAnimationFrame` loop drives pigs on wall-clock linear traverses with a sine
   bob; a spawn interval feeds it; an escaped pig costs one of five lives; the level
   rises every 200 points.
3. **The slingshot** — pointer/touch down–move–up with a dotted aim arc; the hit is
   decided at release by projecting every live pig onto the aim ray against a
   viewport-scaled radius (the flying food is pure theater); six foods × three pig
   types set the points; a 2.5-second combo window multiplies from x3 up.
4. **The director** — pig speed = level base + measured accuracy × 1.4, clamped
   0.5–3.5 and shown live on the accuracy meter: a formula, not a model.
5. **The juice** — WebAudio-synthesized oinks, splats, fanfares and a looping triangle
   melody (toggleable); emoji art over CSS-gradient sky and ground; clouds, popups,
   banners. The one persisted value, `fpf-hs`, is written at game over.

Test spine: the examples validate suite (LLM-free posture lint, hook byte-sync, the
no-network-API rule, CDN allowlist); `starterShelf.test.tsx`'s keeper roster;
`e2e/starters.spec.ts` "the arcade starts and runs with zero networking"; and the
flying-pig archetype in the sdk's `integration.test.tsx` LLM-free runtime path (AC27)
plus `starterRuntimeContract.test.ts`'s no-contract-no-write branch.
