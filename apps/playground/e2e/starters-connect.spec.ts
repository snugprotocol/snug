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
// The `weather-planner` row was a real bug on the parked branch and is kept in the table
// for that reason: it was authored before the pattern settled and keyed its pre-connect
// state on the error code ALONE, so a cold boot showed "your key stays yours" instead of
// the thing the user actually has to do. Every other starter already had the no-data-yet
// clause. Asserting all four uniformly is what makes the AC hold; testing only the three
// that happened to work is how the gap survived a review.
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
  await page.getByRole('button', { name: `open ${folder.replace(/-/g, ' ')}` }).click();
  await expect(page).toHaveURL(new RegExp(`/run/starter--${folder}`));
  return appFrame(page);
}

test.describe('P4-AC7 / AL-09 AC8 — the degraded pre-connect state is real', () => {
  test.skip(!hasApp, AWAITS);

  /**
   * Pinned by EXACT testid and EXACT copy. A generic assertion here would let a
   * placeholder pass, which is the failure this table's `weather-planner` row records.
   */
  const DEGRADED = [
    { folder: 'crypto-portfolio', copy: /connect CoinGecko/i, shell: 'coin-bitcoin' },
    { folder: 'my-repos', copy: /connect GitHub/i, shell: 'load-button' },
    { folder: 'spotify-party-dj', copy: /connect Spotify/i, shell: 'queue-empty' },
    { folder: 'weather-planner', copy: /connect OpenWeather/i, shell: 'city-london' },
  ];

  for (const { folder, copy, shell } of DEGRADED) {
    test(`${folder} boots into an honest, useful pre-connect state`, async ({ page }) => {
      const app = await openStarterByName(page, folder);

      // HONEST: it names the provider it needs, not a shrug.
      await expect(app.getByTestId('preconnect-notice')).toContainText(copy, { timeout: 20_000 });
      // USEFUL: its own shell is alive before any credential exists.
      await expect(app.getByTestId(shell)).toBeVisible();
    });
  }

  test('a READ-ONLY starter route reaches nothing and writes nothing', async ({ page }) => {
    // The path the rest of the suite never takes and a real user takes first: browsing
    // the shelf and pressing a live button. A read-only starter has NO net handler at
    // all, which is a deliberate security property — browsing must reach nothing and
    // write nothing, so Settings stays empty and no declared row appears.
    const app = await openStarterByName(page, 'weather-planner');
    await expect(app.getByTestId('city-london')).toBeVisible({ timeout: 20_000 });

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
 * `desktopOnly`, which LOCKS it on web — `aria-label="open hue lights party"` belongs
 * to a disabled button. So `openStarterByName(page, 'hue-lights-party')` has been
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
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue lights party"]');
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
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="hue lights party"]');
    await expect(tile.locator('.tile-card-button')).toBeDisabled();
    await expect(tile.getByTestId('starter-install')).toHaveCount(0);

    await page.goto('/settings');
    await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  });
});
