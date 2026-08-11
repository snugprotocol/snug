// connection-declaration.spec.ts — TASK-20260807-connection-reachability, T8 / T8b.
//
// THE GAP THIS PROVES CLOSED. Before this task a chat-less app could never become a
// connected app: the only non-test `putAuthSpec` lives inside the wizard, and every
// wizard entry needed a directive (which needs a build conversation), an existing row
// (Settings renders `listAuthSpecs()` — empty), or a net-error CTA that opened over no
// row and no proposal, i.e. an empty manual review. Starters were structurally excluded.
//
// T8 walks the whole journey in a real browser, because the unit tests each own one
// seam and the bug lived in the composition of three separately-correct designs:
//
//   install the starter → the app makes its OWN call → NET_NOT_APPROVED
//     → the CTA banner appears → click it → a PREFILLED STRONG review
//     → approve → a frozen row exists
//
// T8b is the cheaper Settings entry to the same review — second, not the headline,
// because the CTA path is the one that was actually broken.
//
// SPA-navigation only after the entry `goto` (an ephemeral context's OPFS does not
// survive hard reloads — lessons 2026-08-03).

import { expect, test, type Page, type FrameLocator } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

/**
 * UN-PARKED BY P4 (TASK-20260810-p4-starters) — the dependency these journeys named is
 * now satisfied, so they run.
 *
 * P3 parked them with a precise reason: the install-act channel still read
 * `llmProposalSchema`, so a chat-less starter landed no v4 `snug_connections` row, the CTA
 * had no slot to open, and the wizard had nothing to review. The honest options at the time
 * were to rewire into P4's scope, to weaken the assertions, or to park with the dependency
 * named — and parking was correct.
 *
 * P4 completed that rewire, so the premise is false and the skip had to go. Two stale
 * references had to move with it, and BOTH were the kind of drift a parked test
 * accumulates silently:
 *
 *   - `connection-declared-row` no longer exists in any component; P3 renamed it to
 *     `connection-slot-row` (`ConnectionSlotsCard.tsx`). A test parked across a rename
 *     cannot notice the rename.
 *   - the strong-review copy is now the starter-provenance line the wizard actually
 *     renders ("this connection ships with this starter, as its author wrote it"), which
 *     says the same thing the old assertion meant while matching what ships.
 *
 * Neither change weakens a journey: the assertions still walk install → the app's own call
 * → NET_NOT_APPROVED → CTA → prefilled STRONG review → approve → frozen row.
 */

const FOLDER = 'connection-demo';
const DECLARED_HOST = 'api.example.com';
/** The manifest's provider name — `examples/connection-demo/connection.json`. */
const PROVIDER = 'Example API';

const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');

const sheet = (page: Page): ReturnType<Page['locator']> => page.locator('.sheet');

/** Hub → the read-only starter → Install → the user's own copy. */
async function installDemo(page: Page): Promise<FrameLocator> {
  await page.goto('/');
  await page.getByRole('button', { name: `open ${FOLDER.replace(/-/g, ' ')}` }).click();
  await expect(page).toHaveURL(new RegExp(`/run/starter--${FOLDER}`));

  await page.getByTestId('starter-install').click();
  // The install navigates to the installed copy — a uuid route, never the starter id.
  await expect(page).toHaveURL(/\/run\/(?!starter--)[0-9a-f-]{8,}/, { timeout: 20_000 });
  return appFrame(page);
}

test.describe('T8 — a chat-less starter reaches a connection through the CTA (the headline gap)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('install → the app’s own call → NET_NOT_APPROVED → CTA → PREFILLED strong review → approve → frozen row', async ({
    page,
  }) => {
    const app = await installDemo(page);

    // 1. The app makes its OWN call. Nothing has been approved, so the host refuses at
    //    Gate 3. This is the app-timed trigger — no chat, no directive, no existing row.
    await app.getByTestId('call-button').click({ timeout: 20_000 });
    await expect(app.getByTestId('error-code')).toHaveText('NET_NOT_APPROVED', { timeout: 20_000 });

    // 2. …and the host surfaces the CTA banner. Before this task the user's journey
    //    ended here, because clicking it opened an empty manual review.
    const cta = page.getByTestId('net-auth-cta');
    await expect(cta).toBeVisible();

    // 3. Click it. The install-act declaration is resolved from the app's frozen factory
    //    HTML + its bundled manifest, so the review opens PREFILLED.
    await cta.getByRole('button', { name: /connect this app/i }).click();
    const wizard = sheet(page);
    await expect(wizard).toBeVisible();

    // 4. The STRONG, field-by-field review — never the light approve-as-is path — and the
    //    copy claims only what the install act proved.
    await expect(wizard).toContainText(/ships with this starter, as its author wrote it/i);
    await expect(wizard).not.toContainText(/you approved this at install/i);
    // The provider is RENDERED, not an editable input: P3's strong review presents the
    // declaration for judgement rather than offering it for editing, so the v3
    // `getByLabel('provider name')` field this line used to read no longer exists
    // (`ReviewScreen` renders `<h3>{requirement.provider.name}</h3>`). Asserting the
    // heading is the stronger claim anyway — it is what the user actually sees above the
    // hosts they are about to approve.
    await expect(wizard.getByRole('heading', { name: PROVIDER })).toBeVisible();

    // 5. The full host disclosure, prefilled from the manifest (AC7 — on EVERY path).
    //    `wizard-hosts` → `review-hosts`: P3's review renders the row's `allowedHosts`
    //    through `HostList`. Same guarantee, and if anything a stronger one — the list
    //    shown is the ceiling the user is about to freeze, not a restatement of what the
    //    manifest asked for.
    await expect(wizard.getByTestId('review-hosts')).toContainText(DECLARED_HOST);

    // 6. Approve. THIS is the write that was previously unreachable for a chat-less app.
    await wizard.getByRole('button', { name: /approve this connection/i }).click();

    // 7. The REGISTRATION WALKTHROUGH stands between approval and the credential prompt —
    //    the manifest declares one, and `nextStep('review')` routes to `register` whenever
    //    it does. This step is not incidental: it is where the user is told where to go and
    //    get the credential, and asserting it means the journey walks the shape a real user
    //    walks rather than the shortest path to a green tick.
    await expect(wizard.getByTestId('register-steps')).toBeVisible({ timeout: 20_000 });
    await wizard.getByRole('button', { name: /I've got my credentials/i }).click();

    // 8. Credentials only AFTER approval (B1) — reaching this step proves the row landed
    //    AND that the manifest's field list survived the whole install path. An empty field
    //    list would render the heading and the Save button with NO input, which is exactly
    //    the P4 registry-substitution defect; this assertion fails on it.
    await expect(wizard.getByLabel(/api key/i)).toBeVisible({ timeout: 20_000 });
  });

  test('a successful open consumes the CTA — and Settings is the way back', async ({ page }) => {
    // WHAT THIS TEST IS FOR, and what two earlier drafts of it got wrong.
    //
    // Draft 1 tried to prove the parked-wizard REFUSAL keeps the banner. Unreachable
    // through real UI: the wizard is a MODAL that covers the banner, so a second CTA
    // click can never be delivered. Correct product behavior; the refusal branch is
    // pinned where it IS reachable, in `wizardDeclaration.test.ts` (T4b).
    //
    // Draft 2 asserted the banner survives a SUCCESSFUL open. It does not — the CTA is
    // consumed on open, which is PRE-EXISTING deliberate behavior (`RunView.tsx`), not
    // something this task introduced; the async rework only made the dismissal
    // conditional on the awaited boolean instead of a truthy Promise.
    //
    // So this pins the behavior as it actually is, and the property that makes it
    // acceptable: closing the review unapproved is not a dead end, because Settings now
    // lists the app as declared-but-not-connected. Before this task that route did not
    // exist and the user really would have been stranded.
    const app = await installDemo(page);
    await app.getByTestId('call-button').click({ timeout: 20_000 });
    await expect(app.getByTestId('error-code')).toHaveText('NET_NOT_APPROVED', { timeout: 20_000 });

    const cta = page.getByTestId('net-auth-cta');
    await cta.getByRole('button', { name: /connect this app/i }).click();
    const wizard = sheet(page);
    await expect(wizard).toBeVisible();

    // Close without approving: the banner is gone (consumed by the open)…
    await wizard.getByRole('button', { name: /^close$/i }).click();
    await expect(wizard).toBeHidden();
    await expect(cta).toBeHidden();

    // …and the way back is Settings, which is exactly what §V2-6 exists to provide.
    await page.getByRole('link', { name: /^settings$/i }).click();
    await expect(
      page.getByTestId('connection-slot-row'),
      'closing the review must not strand the user',
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('T8b — the same review is reachable from Settings (the cheaper path)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  // The connections panel lives inside SETTINGS — there is no separate /connections
  // route (found by this test failing on its first draft, which assumed one).
  test('an installed declaring app is visible as declared-but-not-connected', async ({ page }) => {
    await installDemo(page);

    await page.getByRole('link', { name: /^settings$/i }).click();
    await expect(page).toHaveURL(/\/settings/);

    // The app is installed and declares, but has NO auth row yet — historically the
    // reason Settings could not help either (`listAuthSpecs()` returns nothing, so the
    // panel showed its empty state and the user had no route to a connection at all).
    await expect(
      page.getByTestId('connection-slot-row'),
      'a declared-but-not-connected app must be visible and actionable',
    ).toBeVisible({ timeout: 20_000 });
  });
});
