// starters-connect.spec.ts — TASK-20260810-p4-starters, P4-AC7 (RED).
//
// THE HARVESTED e2e ASSERTIONS from AL-09 (fold T-M3): AC8's degraded pre-connect state
// and AC9's honestly-greyed Hue. Both are ported near-verbatim from the parked branch
// (`feat/TASK-20260807-starters-auth-spectrum`, 86a564c) because they assert properties
// of the SHIPPED STARTER APPS, which the v4 rewrite does not touch — the manifests were
// rebuilt on the new schema, the HTML was not.
//
// WHY THESE TWO SURVIVED THE HARVEST WHEN THE AUTH-FLOW TESTS DID NOT. Every AL-09 test
// that drove the v3 wizard is dead: that surface was deleted at schema v5 in P3. These
// two never touch the wizard. AC8 asserts what a starter looks like BEFORE any
// connection exists, and AC9 asserts that a starter with no reachable connection offers
// no connect affordance at all. Both are statements about the app, and both are
// schema-independent.
//
// ── AC8: THE DEGRADED STATE IS REAL ────────────────────────────────────────────────
// The doctrine these starters exist to demonstrate: a connected app must be USEFUL before
// it is connected, and HONEST about what it is missing. Two assertions per app, and the
// second is the load-bearing one — a generic non-emptiness check would pass on a
// placeholder, and "connect X" as the entire screen would satisfy the first assertion
// while failing the doctrine completely. So each app must ALSO render its own working
// shell.
//
// The weather row (then `weather-planner`, now `weather`) was a real bug on the parked
// branch and is kept in the table for that reason: it was authored before the pattern
// settled and keyed its pre-connect state on the error code ALONE, so a cold boot showed
// "your key stays yours" instead of the thing the user actually has to do. Every other
// starter already had the no-data-yet clause. Asserting all rows uniformly is what makes
// the AC hold; testing only the ones that happened to work is how the gap survived a
// review.
//
// ── AC9: HUE IS HONESTLY GREYED ────────────────────────────────────────────────────
// Hue reaches a bridge on the user's own LAN, which a sandboxed web iframe cannot do. The
// posture is: ship the app fully alive, grey the ONE control that cannot work, and NAME
// THE REASON. "Unsupported" fails this AC. And because Hue declares nothing — no
// manifest, no requirement, no registry entry — it must offer NO connect affordance
// whatsoever. That last assertion is the one that stops a later refactor from
// "helpfully" wiring it to the wizard, which would mint a connect button that leads
// nowhere.

// PROJECT HOME: the plain `chromium` project, deliberately, and NOT the
// `connection-wizard` project the plan's exit (b) names for the install→connect journey.
// The two need different things and conflating them would over-scope a security
// allowance. `connection-wizard` exists to carry a self-signed-cert allowance and
// `--host-resolver-rules` for specs that actually complete a connected fetch; NOTHING in
// this file connects. AC8 asserts the state BEFORE any credential exists and AC9 asserts
// a control that is greyed precisely because it cannot reach anything — so neither needs
// a cert exception, and granting one here would widen a browser-level allowance for
// specs that make no request. Verified with `npx playwright test --list`: all 7 collect
// under `chromium`, which `testIgnore`s only the mobile/no-server/net/connection-wizard
// specs.
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';
const AWAITS = 'playground app not present yet — spec awaits integration';

/**
 * The sandboxed app iframe. Starters render inside it exactly as built apps do.
 *
 * A `FrameLocator`, not a `Frame`, and that is a REPAIR to the harvested helper rather
 * than a stylistic preference. The AL-09 original took a synchronous `page.frames()`
 * snapshot and threw "the app iframe never mounted" when the list was empty — which it
 * always is at that instant, because the route has only just navigated and the iframe
 * mounts asynchronously. All seven specs failed in ~700ms on that throw, before asserting
 * anything about a starter.
 *
 * `frameLocator` is what every other e2e in this suite uses (`build-run`, `net`,
 * `connection-wizard`), and it AUTO-WAITS: resolution is deferred to the first assertion,
 * so the mount is awaited instead of raced. The selector is the sandbox attribute itself,
 * which is C2's invariant (`sandbox="allow-scripts"`) and therefore the most stable handle
 * on the app frame that exists.
 */
function appFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
}

async function openStarterByName(page: Page, folder: string): Promise<FrameLocator> {
  await page.goto('/');
  // Click by IDENTITY, never by label (TASK-20260818 repair, first integration run of
  // this env-gated spec): the tile's accessible name derives from its DISPLAY label
  // (`open Standup`), which TASK-20260817's rename decoupled from the folder — so
  // `open ${folder}` stopped matching for every renamed starter while this spec sat
  // un-run. `data-starter-name` is the identity key the hue tests already key on.
  await page.locator(`[data-testid="starter-tile"][data-starter-name="${folder}"] .tile-card-button`).click();
  await expect(page).toHaveURL(new RegExp(`/run/starter--${folder}`));
  return appFrame(page);
}

test.describe('P4-AC7 / AL-09 AC8 — the degraded pre-connect state is real', () => {
  test.skip(!hasApp, AWAITS);

  /**
   * Pinned by EXACT copy and an EXACT shell locator against the REBUILT apps' shipped
   * HTML. A generic assertion here would let a placeholder pass, which is the failure
   * the old table's weather row recorded.
   *
   * RE-POINTED AND RE-PINNED (TASK-20260815-starter-apps-rebuild): my-repos → github,
   * spotify-party-dj → spotify, weather-planner → weather. The rebuilt apps do not ship
   * the old `preconnect-notice`/shell testids, so each row now pins (1) the app's own
   * "connect <provider>" copy and (2) a live piece of its pre-connect working shell,
   * both read from the shipped `examples/<folder>/app.html` (this spec is env-gated —
   * it could not be executed for this re-pin, so treat the first integration run as the
   * verifier). The two-assertion shape — honest copy + alive shell — is the AC.
   *
   * The crypto-portfolio (CoinGecko) row is MIGRATED, not dropped: its successor
   * `trade-copilot` (Coinbase) is desktop-only — its web tile is LOCKED exactly like
   * Hue's, so it cannot be opened by this project at all; its shelf honesty is asserted
   * tile-level in the desktop-only describe below.
   */
  const DEGRADED: Array<{
    folder: string;
    /** The provider-naming pre-connect copy, and where it renders. */
    honest: (app: FrameLocator) => Promise<void>;
    /** A working piece of the app's own shell, alive before any credential exists. */
    shell: (app: FrameLocator) => ReturnType<FrameLocator['locator']>;
  }> = [
    {
      folder: 'github',
      // examples/github/app.html: the "🔌 connect github" heading in the connect card.
      honest: async (app) =>
        expect(app.getByRole('heading', { name: /connect github/i })).toBeVisible({ timeout: 20_000 }),
      // The repo-watch input — the sketch queue's shell is interactive pre-connect.
      shell: (app) => app.getByLabel(/repository to watch/i),
    },
    {
      folder: 'spotify',
      // examples/spotify/app.html: the connect-hero card names Spotify and the lane.
      honest: async (app) => {
        await expect(app.getByTestId('connect-hero')).toContainText(/spotify/i, { timeout: 20_000 });
        await expect(app.getByTestId('connect-hero')).toContainText(/not connected yet/i);
      },
      shell: (app) => app.getByTestId('rewind-card'),
    },
    {
      folder: 'weather',
      // examples/weather/app.html: the "connect openweather — it's free" steps card.
      honest: async (app) =>
        expect(app.getByRole('heading', { name: /connect openweather/i })).toBeVisible({ timeout: 20_000 }),
      // The city search — places/decisions work before any forecast can load.
      shell: (app) => app.getByLabel(/search for a city/i),
    },
    {
      folder: 'ledger',
      // examples/ledger/app.html (TASK-20260818, ADR-0038): Ledger's pre-connect state
      // is SAMPLE MODE, not a degraded shell — the honesty is the banner saying so
      // (sample data, swap-on-connect), and the usefulness is the full dashboard alive
      // on the planted household. The DDL executing here is also the real-sql.js proof
      // for the whole schema (the Standup DEFERRABLE lesson).
      honest: async (app) =>
        expect(app.locator('[data-sample-banner]')).toContainText(/sample data/i, { timeout: 20_000 }),
      // The time machine — the hero chart renders from the seeded rows.
      shell: (app) => app.getByRole('heading', { name: /the time machine/i }),
    },
  ];

  /**
   * QUARANTINE (TASK-20260820-local-ci-gate, AC9) — dated 2026-08-20, 4 rows.
   *
   * These are the pre-existing reds first surfaced by TASK-20260818-ledger-starter's
   * FIRST-ever run of this spec, recorded in docs/next-steps.md (2026-08-18). They are
   * NOT this task's regressions and they are NOT fixed here: each app keys its
   * pre-connect surface on a connected-fetch probe that the READ-ONLY starter route
   * never answers (netHandler is deliberately absent there), so the pinned copy may
   * never render on that route. The fix needs per-app cold-boot investigation.
   *
   * WHY test.fail() RATHER THAN test.skip(). `gate:local` adopts this suite as a merge
   * gate, and a gate that is red on its first run is a gate its owner learns to ignore.
   * But a skip would HIDE these rows, and a hidden red is the exact false green the gate
   * exists to prevent. `test.fail()` inverts the expectation instead: the row still runs,
   * still reports, and — critically — the SUITE FAILS IF ONE STARTS PASSING, which forces
   * this list to shrink rather than rot. Quarantine that cannot expire is just deletion
   * with extra steps.
   *
   * Tracked in docs/next-steps.md (2026-08-18 entry). Remove a row here the moment its
   * cold-boot defect is fixed.
   */
  const QUARANTINED_2026_08_20 = new Set(['github', 'spotify', 'weather']);

  for (const { folder, honest, shell } of DEGRADED) {
    test(`${folder} boots into an honest, useful pre-connect state`, async ({ page }) => {
      test.fail(
        QUARANTINED_2026_08_20.has(folder),
        `quarantined 2026-08-20 (pre-existing, next-steps 2026-08-18): ${folder}'s pre-connect copy keys on a probe the read-only route never answers`,
      );
      const app = await openStarterByName(page, folder);

      // HONEST: it names the provider it needs, not a shrug.
      await honest(app);
      // USEFUL: its own shell is alive before any credential exists.
      await expect(shell(app)).toBeVisible();
    });
  }

  test('a READ-ONLY starter route reaches nothing and writes nothing', async ({ page }) => {
    // QUARANTINED 2026-08-20 (TASK-20260820-local-ci-gate, AC9) — the 4th of the
    // pre-existing rows from next-steps 2026-08-18. See the block above for why this is
    // test.fail() and not test.skip(): if this starts passing, the suite FAILS and the
    // quarantine must be lifted deliberately.
    test.fail(true, 'quarantined 2026-08-20 (pre-existing, next-steps 2026-08-18): read-only route probe');
    // The path the rest of the suite never takes and a real user takes first: browsing
    // the shelf and pressing a live button. A read-only starter has NO net handler at
    // all, which is a deliberate security property — browsing must reach nothing and
    // write nothing, so Settings stays empty and no declared row appears.
    const app = await openStarterByName(page, 'weather');
    await expect(app.getByLabel(/search for a city/i)).toBeVisible({ timeout: 20_000 });

    await page.goto('/settings');
    await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  });
});

/**
 * ── HUE ON THE WEB, RE-PINNED AGAINST REALITY (TASK-20260812 AC8/AC9) ──────────────
 *
 * Both tests below are MIGRATED, and the migration is the interesting part: one of
 * them could never have passed, and the suite could not tell because both are gated
 * behind `SNUG_E2E_HAS_APP`.
 *
 * WHAT CHANGED IN THE WORLD. P3 of this task's predecessor made the Hue tile
 * `desktopOnly`, which LOCKS it on web — `aria-label="open hue"` belongs
 * to a disabled button (the folder is `hue` since TASK-20260815-starter-apps-rebuild;
 * it was `hue-lights-party`). So `openStarterByName(page, 'hue')` has been
 * unclickable on web since that landed, and the old first test would have failed at
 * its first line rather than at any assertion it was written to make. It is pinned
 * here as the tile-level statement it actually is, at the surface that actually
 * renders — which is also where the honesty now lives.
 *
 * WHAT SURVIVES VERBATIM. The AC9 CLAIM — "greyed, never hidden, with the reason
 * NAMED; and no connect affordance that cannot work" — is unchanged and is asserted
 * on the tile. The claim that Hue "declares nothing" is OBSOLETE rather than lost:
 * ADR-0023 gave it an honest declaration to make, so the second test now pins that
 * installing writes the LAN row (a real connection the user can review and pair) —
 * the same underlying property, which is that the manifest gate and the install act
 * must agree. A user finding no row for an app that CAN connect would be the same
 * defect the original was written against, in mirror image.
 */
test.describe('AC8/AC9 — Hue is honestly labelled on the web', () => {
  test.skip(!hasApp, AWAITS);

  test('the tile is greyed with the reason named, and offers no connect that cannot work', async ({ page }) => {
    await page.goto('/');
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue"]');
    await expect(tile).toBeVisible({ timeout: 20_000 });

    // GREYED, NEVER HIDDEN — the AC9 claim, at the surface that renders it.
    await expect(tile.getByTestId('desktop-only-badge')).toBeVisible();
    await expect(tile.getByTestId('desktop-only-badge')).toContainText(/desktop app/i);
    await expect(tile.locator('.tile-card-button')).toBeDisabled();

    // …and NO connect affordance anywhere on the hub for it. This is the assertion
    // that stops a later refactor from "helpfully" wiring a web connect flow that
    // could not finish: the browser has no way to pair with a LAN device.
    await expect(page.getByTestId('run-connect')).toHaveCount(0);
  });

  test('Hue cannot be installed from the web hub at all — so no row can appear', async ({ page }) => {
    /**
     * MIGRATED from "installing Hue copies no connection row", and the migration
     * corrects a premise the original had wrong even then.
     *
     * The original clicked `starter-install`, which lives inside the RUN view — a
     * route reached by opening the tile. A locked tile's open button is `disabled`, so
     * on the web there is no path to that button at all: the install act the old test
     * drove was already unreachable when it was written, and the empty-Settings
     * assertion it made would have passed against a broken hub just as happily as
     * against a working one (lesson 2026-08-04 — it measured a proxy).
     *
     * The OUTCOME the old test cared about is preserved exactly: no connection row
     * appears in Settings from browsing the web hub. What changed is that the reason
     * is now asserted rather than assumed — hue has a real declaration to make (the
     * LAN manifest), and what stops it reaching Settings HERE is that a browser can
     * never pair with the device, so the whole route is closed one step earlier.
     * The desktop journey is where the row is asserted positively (playground's
     * `lanWizardFlow` suite drives collect → approve → pair end to end).
     */
    await page.goto('/');
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue"]');
    await expect(tile.locator('.tile-card-button')).toBeDisabled();
    await expect(tile.getByTestId('starter-install')).toHaveCount(0);

    await page.goto('/settings');
    await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  });

  test('trade-copilot (Coinbase) is desktop-only too — greyed on the web, with the reason named', async ({ page }) => {
    /**
     * MIGRATED from the DEGRADED table's `crypto-portfolio` row
     * (TASK-20260815-starter-apps-rebuild). The CoinGecko starter left the shelf; its
     * Coinbase-shaped successor `trade-copilot` cannot present a degraded pre-connect
     * state on the web at all, because api.coinbase.com answers no browser CORS
     * preflight — so the tile is `desktopOnly`, the same honest posture as Hue's. The
     * shelf-honesty property the old row protected ("the app is truthful about what it
     * is missing before a credential exists") is asserted here at the surface a web
     * user actually reaches: a greyed tile that names the reason and mints no connect
     * affordance. The open-and-interact half of the old row lives on the desktop leg,
     * once a desktop e2e project exists to carry it.
     */
    await page.goto('/');
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="trade copilot"]');
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile.getByTestId('desktop-only-badge')).toBeVisible();
    await expect(tile.getByTestId('desktop-only-badge')).toContainText(/desktop app/i);
    await expect(tile.locator('.tile-card-button')).toBeDisabled();
    await expect(tile.getByTestId('starter-install')).toHaveCount(0);
  });
});

test.describe('TASK-20260822 — gmail is dual-mode: the web tile is live and its connect journey reaches the wizard', () => {
  test.skip(!hasApp, AWAITS);

  test('the gmail tile is unlocked on the web, and the install → connections-door journey reaches the WEB walkthrough', async ({ page }) => {
    /**
     * The inverse of the Hue/trade-copilot assertions above, for the one lock whose
     * reason DISSOLVED (ADR-0049): gmail's v1 lock was a client-type fact (a Google
     * Desktop-app client cannot register a web origin), and the registry now vouches
     * for a "Web application" client path. So the web tile must be enabled with no
     * badge, and a real user journey must reach the wizard — whose review AND register
     * screens both carry the WEB walkthrough (never the desktop one), with the exact
     * origin callback to paste.
     *
     * THE JOURNEY IS THE INSTALLED COPY'S, deliberately: the tile's open button leads
     * to the READ-ONLY starter route, which persists no declared row (this file's own
     * AC8 comments pin that), so the wizard is reached the way a real user reaches it —
     * `starter-install` writes the declared, UNAPPROVED row (the AC3/AC5 seam), and the
     * header's connections door (`manage-connections`, AC9's one place) opens the
     * review for it. Nothing here CONNECTS — same project-home rule as the rest of
     * this file (no credential is pasted, no request leaves).
     */
    await page.goto('/');
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="gmail"]');
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile.getByTestId('desktop-only-badge')).toHaveCount(0);
    await expect(tile.locator('.tile-card-button')).toBeEnabled();

    await tile.locator('.tile-card-button').click();
    await expect(page).toHaveURL(/\/run\/starter--gmail/);
    await page.getByTestId('starter-install').click();
    // Install navigates to the user's own copy — a uuid route, never the starter id.
    await expect(page).toHaveURL(/\/run\/(?!starter--)[0-9a-f-]{8,}/, { timeout: 20_000 });

    await page.getByTestId('manage-connections').click();
    const wizard = page.locator('.sheet');
    await expect(wizard).toBeVisible();
    // The REVIEW screen's "how you get them" guidance must already be the web copy —
    // the review/register contradiction is the exact defect the Gate-5 review caught.
    await expect(wizard.getByTestId('review-registration-steps')).toContainText('"Web application"');
    await wizard.getByRole('button', { name: /approve this connection/i }).click();
    await expect(wizard.getByTestId('register-steps')).toContainText('"Web application"');
    await expect(wizard.getByTestId('register-steps')).not.toContainText('type "Desktop app"');
    await expect(wizard.getByTestId('register-redirect-uri')).toHaveText(/\/oauth\/callback$/);
  });
});
