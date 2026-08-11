// connection-wizard.spec.ts — P3-AC11 (TASK-20260810-p3-wizard, parent plan §6/§P3):
// the GRANDMA WALKTHROUGH end-to-end through the real app shell, on the v4
// `snug_connections` step machine.
//
// FOUR JOURNEYS, one per credential shape the wizard must actually carry:
//   1. api_key MULTI-FIELD — the motivating Coinbase defect: key + secret + passphrase,
//      an HMAC-signed header template, a registration walkthrough. This is the journey
//      whose absence started the rewrite.
//   2. bearer_token — the single-token shape.
//   3. basic_auth   — the two-field username/password shape.
//   4. oauth2_auth_code — register (redirect URI) → connect popup → done.
//
// `oauth2_client_creds` IS DELIBERATELY NOT A JOURNEY HERE, and that is stated rather
// than silently skipped (fold T-mn4): it is covered at the P1 EXECUTOR layer, where the
// interesting behavior lives (the mint happens host-side with no user-facing screen
// beyond a save). Adding a UX journey for it would assert nothing the P1 tests do not
// already assert, at the cost of a slow browser round-trip.
//
// STUB-HOST PATTERN, unchanged from AL-03/AL-04: the AUTHORED hosts in each requirement
// are the REAL provider hosts (api.coinbase.com and friends) — an e2e that authored
// `stub.snug.test` would prove the wizard works on a host no real app declares. What is
// reviewed and frozen is therefore the real ceiling, while resolution happens at the
// BROWSER: the connection-wizard project maps those names to 127.0.0.1 with
// `--host-resolver-rules`, and the non-default port picks the local stub's listener. No
// request leaves the machine.
//
// Journey 4's host is `idp.snug.test` rather than a real IdP, and that is a CONSTRAINT
// worth naming: an OAuth journey NAVIGATES the browser to the authorize URL and POSTs to
// the token URL, so neither can be remapped from inside the page, and both must be https
// because `connectionRequirementSchema` refuses a plaintext OAuth endpoint. A loopback
// literal is refused too (`isForbiddenNetHost`). So the fixture speaks https on a
// resolver-mapped ordinary-looking name — no guard is relaxed to make the journey run.
//
// C1 probes ride journeys 1 and 3: the pasted secrets must appear NOWHERE in the page
// after the wizard closes, and the app must see the scrubbed form only.
import { expect, test, type Page } from '@playwright/test';

// `=== '1'`, matching every sibling spec in this directory. The config sets '' when the
// app is absent, so `Boolean(...)` coincidentally behaved the same today — but this is a
// gate that decides whether a journey silently VANISHES, and the one spec that spells it
// differently is the one that will diverge when the config's absent-value changes.
const hasApp = process.env.SNUG_E2E_HAS_APP === '1';
const AWAITS = 'playground app not present yet — spec awaits integration';

const CB_KEY = 'e2e-cb-key-1111';
/**
 * STANDARD BASE64, and that is not cosmetic. Coinbase issues its API secret base64-encoded
 * and `hmac_sha256_b64` decodes it before signing, so a non-base64 secret is refused by the
 * template engine with "hmac_sha256_b64 secret must be standard base64" — which is exactly
 * what this journey used to hit at its final assertion, surfacing as NET_AUTH_FAILED. The
 * engine is right and the old fixture value ('e2e-cb-secret-2222') was simply not a
 * credential of the shape this provider issues. It still decodes to a recognizable canary
 * so the C1 no-leak assertions below stay meaningful.
 */
const CB_SECRET = 'ZTJlLWNiLXNlY3JldC0yMjIyLW5vdC1hLXJlYWwtc2VjcmV0';
const CB_PASSPHRASE = 'e2e-cb-passphrase-3333';
const BEARER = 'e2e-bearer-4444';
const BASIC_PASSWORD = 'e2e-basic-password-5555';

test.use({ ignoreHTTPSErrors: true });

/**
 * Build an app whose reply carries a `connection_requirement` directive of the given
 * variant, via the deterministic demo-brain seam. The P3 variants are new: the v3
 * `?demoauth=` variants emit `auth_wizard` directives and must keep working untouched
 * until their surface is deleted, so the v4 flag is separate.
 */
async function buildWithRequirement(page: Page, variant: string): Promise<void> {
  await page.goto(`/build?demoreq=${variant}`);
  const composer = page.getByRole('textbox', { name: 'describe your app' });
  await composer.fill('build my connected app');
  await composer.press('Enter');
  await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('connection-requirement-card')).toBeVisible({ timeout: 20_000 });
}

function wizard(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid="connection-wizard"]');
}

/**
 * Open the wizard from the requirement card, tolerating the card's post-declaration
 * re-render.
 *
 * THE RACE THIS FIXES (1 failure in 5 full-suite runs, never in isolation): the card
 * mounts as soon as the directive is parsed, then re-renders when the declaration is
 * finalized post-turn. A click dispatched between those two renders hits a node that is
 * detached before the event lands — "element was detached from the DOM, retrying". Playwright's
 * auto-retry usually outruns it; under full-suite scheduling it sometimes does not.
 *
 * Waiting for the BUTTON to be stable — rather than only for the card to be visible — is
 * what makes this deterministic: `toBeEnabled` resolves against the currently-attached
 * node, so the click that follows targets a node that has survived at least one settle.
 * This is a test-harness fix; it changes no product behavior and weakens no assertion.
 */
async function openWizardFromCard(page: Page): Promise<void> {
  const card = page.getByTestId('connection-requirement-card');
  await expect(card).toBeVisible();
  const connect = card.getByRole('button', { name: /connect/i });
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(wizard(page)).toBeVisible();
}

/** The custody claim, ADR-0014 clause 5 VERBATIM (fold F-M1). */
const CLAUSE_5 = /your keys never reach our servers — your file, including keys, goes only to storage you choose/i;
const FALSE_CUSTODY = /stays? in your file on this device/i;

test('journey 1 — api_key MULTI-FIELD (the Coinbase shape): review → register → three secrets → done', async ({
  page,
}) => {
  test.skip(!hasApp, AWAITS);
  await buildWithRequirement(page, 'coinbase');
  await openWizardFromCard(page);

  // ---- REVIEW: everything the requirement carries is on this screen (P3-AC2).
  const review = wizard(page);
  await expect(review).toContainText('Coinbase');
  await expect(review).toContainText(/a guess, not an authority/i);
  // The header template, verbatim, in a code box — the "exactly what will be sent" claim.
  await expect(review.getByTestId('review-header-template')).toContainText('CB-ACCESS-SIGN');
  await expect(review.getByTestId('review-header-template')).toContainText('{{request.timestamp}}');
  // The complete host list + the freeze copy.
  // `api.exchange.coinbase.com` since P4: the demo requirement moved off the bare
  // `api.coinbase.com`, which P4 pinned in the well-known registry — declaring it while
  // authoring its own fields + header template is now refused by the registry-borrow ban
  // (Guard 2b). Coinbase Exchange is a genuinely different host, so the three-field HMAC
  // journey is unchanged; only the brand it names is the one it actually dials.
  await expect(review.getByTestId('review-hosts')).toContainText('api.exchange.coinbase.com');
  await expect(review).toContainText(/freezes at approval/i);
  // Registration steps render as plain text — never a link (P3-AC5).
  await expect(review.getByTestId('review-registration-steps').locator('a')).toHaveCount(0);

  await review.getByRole('button', { name: /approve this connection/i }).click();

  // ---- REGISTER: the numbered walkthrough, copy-only console url (inference provenance).
  await expect(wizard(page).getByTestId('register-steps').locator('li')).toHaveCount(3);
  await expect(wizard(page).getByTestId('register-console').locator('a')).toHaveCount(0);
  await wizard(page).getByRole('button', { name: /i've got my credentials/i }).click();

  // ---- CREDENTIALS: one masked input per declared field, and the custody claim.
  await expect(wizard(page)).toContainText(CLAUSE_5);
  await expect(wizard(page)).not.toContainText(FALSE_CUSTODY);
  await wizard(page).getByLabel('API key').fill(CB_KEY);
  await wizard(page).getByLabel('API secret').fill(CB_SECRET);
  await wizard(page).getByLabel('Passphrase').fill(CB_PASSPHRASE);
  await wizard(page).getByRole('button', { name: /save my credentials/i }).click();

  // ---- DONE. A static kind never visits `connect`.
  await expect(wizard(page)).toContainText(/connected/i);
  await wizard(page).getByRole('button', { name: /^done$/i }).click();

  // C1 — none of the three secrets is anywhere in the page.
  const content = await page.content();
  for (const secret of [CB_KEY, CB_SECRET, CB_PASSPHRASE]) expect(content).not.toContain(secret);

  // The app runs through the REAL executor: the stub sees the SIGNED headers (the
  // template rendered host-side) and the app sees only the scrubbed body.
  await page.getByRole('link', { name: /run it/i }).click();
  await expect(page).toHaveURL(/\/run\//);
  const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
  await expect(frame.locator('#net-status')).toHaveText('ok:200', { timeout: 30_000 });
  const body = await frame.locator('#net-out').textContent();
  expect(body).toContain('"sawSignature":"***"');
  for (const secret of [CB_KEY, CB_SECRET, CB_PASSPHRASE]) expect(body).not.toContain(secret);
});

test('journey 2 — bearer_token: review → credentials (no register screen) → done', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithRequirement(page, 'bearer');
  await openWizardFromCard(page);

  // `TideGauge` since P4: this journey's subject must be a provider the registry does NOT
  // pin, or the registry supplies a walkthrough and the "register screen is SKIPPED"
  // assertion below becomes untestable. OpenWeather gained a registry entry in P4.
  await expect(wizard(page)).toContainText('TideGauge');
  await wizard(page).getByRole('button', { name: /approve this connection/i }).click();

  // No `registration` seat ⇒ the register screen is SKIPPED, not rendered empty.
  await expect(wizard(page).getByTestId('register-steps')).toHaveCount(0);
  await expect(wizard(page)).toContainText(CLAUSE_5);
  await wizard(page).getByLabel('API token').fill(BEARER);
  await wizard(page).getByRole('button', { name: /save my credentials/i }).click();
  await expect(wizard(page)).toContainText(/connected/i);

  expect(await page.content()).not.toContain(BEARER);
});

test('journey 3 — basic_auth: two fields, password masked, username not', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithRequirement(page, 'basic');
  await openWizardFromCard(page);

  await wizard(page).getByRole('button', { name: /approve this connection/i }).click();
  await expect(wizard(page)).toContainText(CLAUSE_5);

  const username = wizard(page).getByLabel('Username');
  const password = wizard(page).getByLabel('Password');
  await expect(username).toHaveAttribute('type', 'text');
  await expect(password).toHaveAttribute('type', 'password');
  await username.fill('e2e-user');
  await password.fill(BASIC_PASSWORD);
  await wizard(page).getByRole('button', { name: /save my credentials/i }).click();
  await expect(wizard(page)).toContainText(/connected/i);

  expect(await page.content()).not.toContain(BASIC_PASSWORD);
});

test('journey 4 — oauth2_auth_code: register (redirect uri) → connect popup → done', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithRequirement(page, 'oauth');
  await openWizardFromCard(page);

  await wizard(page).getByRole('button', { name: /approve this connection/i }).click();

  // The REGISTER screen carries the generated redirect URI in a code box with a copy
  // button, plus the "register once per provider" explainer — both harvested from the
  // parked AL-09 branch and rebuilt here on the new step machine (fold F-M3).
  const redirect = wizard(page).getByTestId('register-redirect-uri');
  await expect(redirect).toContainText('/oauth/callback');
  await expect(wizard(page).getByRole('button', { name: /copy/i })).toBeVisible();
  await expect(wizard(page)).toContainText(/register once per provider/i);
  await wizard(page).getByRole('button', { name: /i've got my credentials/i }).click();

  await expect(wizard(page)).toContainText(CLAUSE_5);
  await wizard(page).getByLabel('Client ID').fill('e2e-client-id');

  // The RENDERED label is `connect my ${provider.name} account`. The old selector was
  // /connect my account/i — no wildcard between "my" and "account" — so it could never
  // match and this journey was statically incapable of passing. It had never been run.
  const popupPromise = page.context().waitForEvent('page');
  await wizard(page).getByRole('button', { name: /connect my .* account/i }).click();

  // ---- CONNECT screen: the waiting state names the provider (OProject's grammar).
  await expect(wizard(page)).toContainText(/waiting for .* sign-in/i);
  const popup = await popupPromise;
  await popup.waitForURL(/\/oauth\/callback/, { timeout: 15_000 });

  await expect(wizard(page)).toContainText(/connected/i, { timeout: 15_000 });
  expect(await page.content()).not.toContain('e2e-access-token-abc');
});

test('the run surface carries NO inference affordance in any wizard session (P3-AC6, Q5)', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithRequirement(page, 'coinbase');

  // Open the wizard from the RUN surface's connect CTA — the session Q5 names.
  await page.getByRole('link', { name: /run it/i }).click();
  await expect(page).toHaveURL(/\/run\//);
  await page.getByRole('button', { name: /connect/i }).first().click();
  await expect(wizard(page)).toBeVisible();

  await expect(wizard(page).getByRole('button', { name: /infer from docs/i })).toHaveCount(0);
  await expect(wizard(page).getByLabel(/paste provider docs/i)).toHaveCount(0);
  await expect(wizard(page).locator('textarea')).toHaveCount(0);
});
