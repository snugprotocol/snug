# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: starters-connect.spec.ts >> P4-AC7 / AL-09 AC8 — the degraded pre-connect state is real >> spotify boots into an honest, useful pre-connect state
- Location: e2e/starters-connect.spec.ts:157:5

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]').contentFrame().getByTestId('connect-hero')
Expected pattern: /spotify/i
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" with timeout 20000ms
  - waiting for locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]').contentFrame().getByTestId('connect-hero')

```

```yaml
- banner:
  - link "snug.":
    - /url: /
  - navigation "primary":
    - link "your apps":
      - /url: /
    - link "build":
      - /url: /build
    - link "settings":
      - /url: /settings
    - button "switch to light theme": ☀
- main:
  - text: "Rewind Your listening, understood: a portrait of your own Spotify data, a trend journal Spotify forgets, playback control, and a weekly rewind written by the agent."
  - button "install"
  - button "export .sqlite": ⤓
  - button "switch to light theme": ☀ light
  - button "hide watch it think" [pressed]: ◨ hide
  - text: 🔌 this starter ships a declared connection to
  - strong: Spotify
  - text: (api.spotify.com). installing only copies the app — nothing is connected until you review and approve it yourself.
  - iframe
  - separator "resize the watch it think panel"
  - complementary "watch it think":
    - text: watch it think
    - group "rail tabs":
      - button "inspector" [pressed]
    - heading "model round trips" [level=3]
    - text: prompt in, reply out
    - heading "no round trips yet" [level=2]
    - paragraph: your browser calls the model directly in byok mode, so each prompt, reply, token count and timing lands here the moment a turn runs. in-memory only.
```

# Test source

```ts
  29  | // the AC hold; testing only the ones that happened to work is how the gap survived a
  30  | // review.
  31  | //
  32  | // ── AC9: HUE IS HONESTLY GREYED ────────────────────────────────────────────────────
  33  | // Hue reaches a bridge on the user's own LAN, which a sandboxed web iframe cannot do. The
  34  | // posture is: ship the app fully alive, grey the ONE control that cannot work, and NAME
  35  | // THE REASON. "Unsupported" fails this AC. And because Hue declares nothing — no
  36  | // manifest, no requirement, no registry entry — it must offer NO connect affordance
  37  | // whatsoever. That last assertion is the one that stops a later refactor from
  38  | // "helpfully" wiring it to the wizard, which would mint a connect button that leads
  39  | // nowhere.
  40  | 
  41  | // PROJECT HOME: the plain `chromium` project, deliberately, and NOT the
  42  | // `connection-wizard` project the plan's exit (b) names for the install→connect journey.
  43  | // The two need different things and conflating them would over-scope a security
  44  | // allowance. `connection-wizard` exists to carry a self-signed-cert allowance and
  45  | // `--host-resolver-rules` for specs that actually complete a connected fetch; NOTHING in
  46  | // this file connects. AC8 asserts the state BEFORE any credential exists and AC9 asserts
  47  | // a control that is greyed precisely because it cannot reach anything — so neither needs
  48  | // a cert exception, and granting one here would widen a browser-level allowance for
  49  | // specs that make no request. Verified with `npx playwright test --list`: all 7 collect
  50  | // under `chromium`, which `testIgnore`s only the mobile/no-server/net/connection-wizard
  51  | // specs.
  52  | import { expect, test, type FrameLocator, type Page } from '@playwright/test';
  53  | 
  54  | const hasApp = process.env.SNUG_E2E_HAS_APP === '1';
  55  | const AWAITS = 'playground app not present yet — spec awaits integration';
  56  | 
  57  | /**
  58  |  * The sandboxed app iframe. Starters render inside it exactly as built apps do.
  59  |  *
  60  |  * A `FrameLocator`, not a `Frame`, and that is a REPAIR to the harvested helper rather
  61  |  * than a stylistic preference. The AL-09 original took a synchronous `page.frames()`
  62  |  * snapshot and threw "the app iframe never mounted" when the list was empty — which it
  63  |  * always is at that instant, because the route has only just navigated and the iframe
  64  |  * mounts asynchronously. All seven specs failed in ~700ms on that throw, before asserting
  65  |  * anything about a starter.
  66  |  *
  67  |  * `frameLocator` is what every other e2e in this suite uses (`build-run`, `net`,
  68  |  * `connection-wizard`), and it AUTO-WAITS: resolution is deferred to the first assertion,
  69  |  * so the mount is awaited instead of raced. The selector is the sandbox attribute itself,
  70  |  * which is C2's invariant (`sandbox="allow-scripts"`) and therefore the most stable handle
  71  |  * on the app frame that exists.
  72  |  */
  73  | function appFrame(page: Page): FrameLocator {
  74  |   return page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
  75  | }
  76  | 
  77  | async function openStarterByName(page: Page, folder: string): Promise<FrameLocator> {
  78  |   await page.goto('/');
  79  |   // Click by IDENTITY, never by label (TASK-20260818 repair, first integration run of
  80  |   // this env-gated spec): the tile's accessible name derives from its DISPLAY label
  81  |   // (`open Standup`), which TASK-20260817's rename decoupled from the folder — so
  82  |   // `open ${folder}` stopped matching for every renamed starter while this spec sat
  83  |   // un-run. `data-starter-name` is the identity key the hue tests already key on.
  84  |   await page.locator(`[data-testid="starter-tile"][data-starter-name="${folder}"] .tile-card-button`).click();
  85  |   await expect(page).toHaveURL(new RegExp(`/run/starter--${folder}`));
  86  |   return appFrame(page);
  87  | }
  88  | 
  89  | test.describe('P4-AC7 / AL-09 AC8 — the degraded pre-connect state is real', () => {
  90  |   test.skip(!hasApp, AWAITS);
  91  | 
  92  |   /**
  93  |    * Pinned by EXACT copy and an EXACT shell locator against the REBUILT apps' shipped
  94  |    * HTML. A generic assertion here would let a placeholder pass, which is the failure
  95  |    * the old table's weather row recorded.
  96  |    *
  97  |    * RE-POINTED AND RE-PINNED (TASK-20260815-starter-apps-rebuild): my-repos → github,
  98  |    * spotify-party-dj → spotify, weather-planner → weather. The rebuilt apps do not ship
  99  |    * the old `preconnect-notice`/shell testids, so each row now pins (1) the app's own
  100 |    * "connect <provider>" copy and (2) a live piece of its pre-connect working shell,
  101 |    * both read from the shipped `examples/<folder>/app.html` (this spec is env-gated —
  102 |    * it could not be executed for this re-pin, so treat the first integration run as the
  103 |    * verifier). The two-assertion shape — honest copy + alive shell — is the AC.
  104 |    *
  105 |    * The crypto-portfolio (CoinGecko) row is MIGRATED, not dropped: its successor
  106 |    * `trade-copilot` (Coinbase) is desktop-only — its web tile is LOCKED exactly like
  107 |    * Hue's, so it cannot be opened by this project at all; its shelf honesty is asserted
  108 |    * tile-level in the desktop-only describe below.
  109 |    */
  110 |   const DEGRADED: Array<{
  111 |     folder: string;
  112 |     /** The provider-naming pre-connect copy, and where it renders. */
  113 |     honest: (app: FrameLocator) => Promise<void>;
  114 |     /** A working piece of the app's own shell, alive before any credential exists. */
  115 |     shell: (app: FrameLocator) => ReturnType<FrameLocator['locator']>;
  116 |   }> = [
  117 |     {
  118 |       folder: 'github',
  119 |       // examples/github/app.html: the "🔌 connect github" heading in the connect card.
  120 |       honest: async (app) =>
  121 |         expect(app.getByRole('heading', { name: /connect github/i })).toBeVisible({ timeout: 20_000 }),
  122 |       // The repo-watch input — the sketch queue's shell is interactive pre-connect.
  123 |       shell: (app) => app.getByLabel(/repository to watch/i),
  124 |     },
  125 |     {
  126 |       folder: 'spotify',
  127 |       // examples/spotify/app.html: the connect-hero card names Spotify and the lane.
  128 |       honest: async (app) => {
> 129 |         await expect(app.getByTestId('connect-hero')).toContainText(/spotify/i, { timeout: 20_000 });
      |                                                       ^ Error: expect(locator).toContainText(expected) failed
  130 |         await expect(app.getByTestId('connect-hero')).toContainText(/not connected yet/i);
  131 |       },
  132 |       shell: (app) => app.getByTestId('rewind-card'),
  133 |     },
  134 |     {
  135 |       folder: 'weather',
  136 |       // examples/weather/app.html: the "connect openweather — it's free" steps card.
  137 |       honest: async (app) =>
  138 |         expect(app.getByRole('heading', { name: /connect openweather/i })).toBeVisible({ timeout: 20_000 }),
  139 |       // The city search — places/decisions work before any forecast can load.
  140 |       shell: (app) => app.getByLabel(/search for a city/i),
  141 |     },
  142 |     {
  143 |       folder: 'ledger',
  144 |       // examples/ledger/app.html (TASK-20260818, ADR-0038): Ledger's pre-connect state
  145 |       // is SAMPLE MODE, not a degraded shell — the honesty is the banner saying so
  146 |       // (sample data, swap-on-connect), and the usefulness is the full dashboard alive
  147 |       // on the planted household. The DDL executing here is also the real-sql.js proof
  148 |       // for the whole schema (the Standup DEFERRABLE lesson).
  149 |       honest: async (app) =>
  150 |         expect(app.locator('[data-sample-banner]')).toContainText(/sample data/i, { timeout: 20_000 }),
  151 |       // The time machine — the hero chart renders from the seeded rows.
  152 |       shell: (app) => app.getByRole('heading', { name: /the time machine/i }),
  153 |     },
  154 |   ];
  155 | 
  156 |   for (const { folder, honest, shell } of DEGRADED) {
  157 |     test(`${folder} boots into an honest, useful pre-connect state`, async ({ page }) => {
  158 |       const app = await openStarterByName(page, folder);
  159 | 
  160 |       // HONEST: it names the provider it needs, not a shrug.
  161 |       await honest(app);
  162 |       // USEFUL: its own shell is alive before any credential exists.
  163 |       await expect(shell(app)).toBeVisible();
  164 |     });
  165 |   }
  166 | 
  167 |   test('a READ-ONLY starter route reaches nothing and writes nothing', async ({ page }) => {
  168 |     // The path the rest of the suite never takes and a real user takes first: browsing
  169 |     // the shelf and pressing a live button. A read-only starter has NO net handler at
  170 |     // all, which is a deliberate security property — browsing must reach nothing and
  171 |     // write nothing, so Settings stays empty and no declared row appears.
  172 |     const app = await openStarterByName(page, 'weather');
  173 |     await expect(app.getByLabel(/search for a city/i)).toBeVisible({ timeout: 20_000 });
  174 | 
  175 |     await page.goto('/settings');
  176 |     await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  177 |   });
  178 | });
  179 | 
  180 | /**
  181 |  * ── HUE ON THE WEB, RE-PINNED AGAINST REALITY (TASK-20260812 AC8/AC9) ──────────────
  182 |  *
  183 |  * Both tests below are MIGRATED, and the migration is the interesting part: one of
  184 |  * them could never have passed, and the suite could not tell because both are gated
  185 |  * behind `SNUG_E2E_HAS_APP`.
  186 |  *
  187 |  * WHAT CHANGED IN THE WORLD. P3 of this task's predecessor made the Hue tile
  188 |  * `desktopOnly`, which LOCKS it on web — `aria-label="open hue"` belongs
  189 |  * to a disabled button (the folder is `hue` since TASK-20260815-starter-apps-rebuild;
  190 |  * it was `hue-lights-party`). So `openStarterByName(page, 'hue')` has been
  191 |  * unclickable on web since that landed, and the old first test would have failed at
  192 |  * its first line rather than at any assertion it was written to make. It is pinned
  193 |  * here as the tile-level statement it actually is, at the surface that actually
  194 |  * renders — which is also where the honesty now lives.
  195 |  *
  196 |  * WHAT SURVIVES VERBATIM. The AC9 CLAIM — "greyed, never hidden, with the reason
  197 |  * NAMED; and no connect affordance that cannot work" — is unchanged and is asserted
  198 |  * on the tile. The claim that Hue "declares nothing" is OBSOLETE rather than lost:
  199 |  * ADR-0023 gave it an honest declaration to make, so the second test now pins that
  200 |  * installing writes the LAN row (a real connection the user can review and pair) —
  201 |  * the same underlying property, which is that the manifest gate and the install act
  202 |  * must agree. A user finding no row for an app that CAN connect would be the same
  203 |  * defect the original was written against, in mirror image.
  204 |  */
  205 | test.describe('AC8/AC9 — Hue is honestly labelled on the web', () => {
  206 |   test.skip(!hasApp, AWAITS);
  207 | 
  208 |   test('the tile is greyed with the reason named, and offers no connect that cannot work', async ({ page }) => {
  209 |     await page.goto('/');
  210 |     const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue"]');
  211 |     await expect(tile).toBeVisible({ timeout: 20_000 });
  212 | 
  213 |     // GREYED, NEVER HIDDEN — the AC9 claim, at the surface that renders it.
  214 |     await expect(tile.getByTestId('desktop-only-badge')).toBeVisible();
  215 |     await expect(tile.getByTestId('desktop-only-badge')).toContainText(/desktop app/i);
  216 |     await expect(tile.locator('.tile-card-button')).toBeDisabled();
  217 | 
  218 |     // …and NO connect affordance anywhere on the hub for it. This is the assertion
  219 |     // that stops a later refactor from "helpfully" wiring a web connect flow that
  220 |     // could not finish: the browser has no way to pair with a LAN device.
  221 |     await expect(page.getByTestId('run-connect')).toHaveCount(0);
  222 |   });
  223 | 
  224 |   test('Hue cannot be installed from the web hub at all — so no row can appear', async ({ page }) => {
  225 |     /**
  226 |      * MIGRATED from "installing Hue copies no connection row", and the migration
  227 |      * corrects a premise the original had wrong even then.
  228 |      *
  229 |      * The original clicked `starter-install`, which lives inside the RUN view — a
```