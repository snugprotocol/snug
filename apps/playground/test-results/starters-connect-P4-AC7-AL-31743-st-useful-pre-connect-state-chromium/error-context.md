# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: starters-connect.spec.ts >> P4-AC7 / AL-09 AC8 — the degraded pre-connect state is real >> github boots into an honest, useful pre-connect state
- Location: e2e/starters-connect.spec.ts:157:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]').contentFrame().getByLabel(/repository to watch/i)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]').contentFrame().getByLabel(/repository to watch/i)

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
  - text: "Standup Your GitHub morning: the review requests, assignments, and mentions that need you, a pulse of your recent activity, and an agent briefing that ranks the queue."
  - button "install"
  - button "export .sqlite": ⤓
  - button "switch to light theme": ☀ light
  - button "hide watch it think" [pressed]: ◨ hide
  - text: 🔌 this starter ships a declared connection to
  - strong: GitHub
  - text: (api.github.com). installing only copies the app — nothing is connected until you review and approve it yourself.
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
  129 |         await expect(app.getByTestId('connect-hero')).toContainText(/spotify/i, { timeout: 20_000 });
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
> 163 |       await expect(shell(app)).toBeVisible();
      |                                ^ Error: expect(locator).toBeVisible() failed
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
  230 |      * route reached by opening the tile. A locked tile's open button is `disabled`, so
  231 |      * on the web there is no path to that button at all: the install act the old test
  232 |      * drove was already unreachable when it was written, and the empty-Settings
  233 |      * assertion it made would have passed against a broken hub just as happily as
  234 |      * against a working one (lesson 2026-08-04 — it measured a proxy).
  235 |      *
  236 |      * The OUTCOME the old test cared about is preserved exactly: no connection row
  237 |      * appears in Settings from browsing the web hub. What changed is that the reason
  238 |      * is now asserted rather than assumed — hue has a real declaration to make (the
  239 |      * LAN manifest), and what stops it reaching Settings HERE is that a browser can
  240 |      * never pair with the device, so the whole route is closed one step earlier.
  241 |      * The desktop journey is where the row is asserted positively (playground's
  242 |      * `lanWizardFlow` suite drives collect → approve → pair end to end).
  243 |      */
  244 |     await page.goto('/');
  245 |     const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue"]');
  246 |     await expect(tile.locator('.tile-card-button')).toBeDisabled();
  247 |     await expect(tile.getByTestId('starter-install')).toHaveCount(0);
  248 | 
  249 |     await page.goto('/settings');
  250 |     await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  251 |   });
  252 | 
  253 |   test('trade-copilot (Coinbase) is desktop-only too — greyed on the web, with the reason named', async ({ page }) => {
  254 |     /**
  255 |      * MIGRATED from the DEGRADED table's `crypto-portfolio` row
  256 |      * (TASK-20260815-starter-apps-rebuild). The CoinGecko starter left the shelf; its
  257 |      * Coinbase-shaped successor `trade-copilot` cannot present a degraded pre-connect
  258 |      * state on the web at all, because api.coinbase.com answers no browser CORS
  259 |      * preflight — so the tile is `desktopOnly`, the same honest posture as Hue's. The
  260 |      * shelf-honesty property the old row protected ("the app is truthful about what it
  261 |      * is missing before a credential exists") is asserted here at the surface a web
  262 |      * user actually reaches: a greyed tile that names the reason and mints no connect
  263 |      * affordance. The open-and-interact half of the old row lives on the desktop leg,
```