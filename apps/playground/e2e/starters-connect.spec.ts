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

test.describe('P4-AC7 / AL-09 AC9 — Hue is honestly greyed on the web', () => {
  test.skip(!hasApp, AWAITS);

  test('the sync control is disabled, the reason is named, and no connect path opens', async ({ page }) => {
    const app = await openStarterByName(page, 'hue-lights-party');

    // The designer is fully alive on the web — this app ships authored, not stubbed.
    await expect(app.getByTestId('scene-preview')).toBeVisible({ timeout: 20_000 });
    await app.getByTestId('scene-ocean').click();

    // …and the one thing it cannot do is greyed, not hidden, with the REASON named.
    // Copy that says only "unsupported" would fail this AC.
    await expect(app.getByTestId('apply-button')).toBeDisabled();
    await expect(app.getByTestId('desktop-only-notice')).toContainText(/home network/i);
    await expect(app.getByTestId('desktop-only-notice')).toContainText(/desktop app/i);

    // Hue declares nothing, so it must offer NO connect affordance that could not work.
    await expect(app.getByTestId('preconnect-notice')).toHaveCount(0);
    await expect(page.getByTestId('run-connect')).toHaveCount(0);
  });

  test('installing Hue copies no connection row (it has nothing to declare)', async ({ page }) => {
    // The v4 half of AC9, and the reason this test is not a pure port: P4 makes install
    // WRITE rows (AC3). Hue must be the one starter for which that writes nothing — the
    // manifest gate and the install act have to agree, or a user would find a connect
    // card in Settings for an app that can never use one.
    await openStarterByName(page, 'hue-lights-party');
    await page.getByTestId('starter-install').click();

    await page.goto('/settings');
    await expect(page.getByTestId('connection-declared-row')).toHaveCount(0);
  });
});
