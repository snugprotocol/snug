import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import {
  clearOpenUserFileError,
  openUserFileConfirmStore,
  openUserFileErrorStore,
  registerPlatformOpenFile,
  resolveOpenUserFileConfirm,
} from './platform/openFile.js';
import { initDesktopFirstRun } from './desktop/firstRun.js';
import { ModeCoercionNote } from './desktop/ModeCoercionNote.js';
import { AppUpdateSurface } from './desktop/AppUpdateControls.js';
import { HelperSurface } from './desktop/HelperSurface.js';
import { initAppUpdateLaunchCheck } from './state/appUpdate.js';
import { openBuildMenu } from './state/buildThread.js';
import { refreshAppMeta } from './state/appMeta.js';
import { initDemoCallout } from './state/demoCallout.js';
import { login, refreshAuth, useAuth } from './state/auth.js';
import { initSettings } from './state/mode.js';
import { refreshOllama } from './state/ollama.js';
import { useStore } from './state/store.js';
import { initWebllm } from './state/webllm.js';
import { initSync, signOut } from './state/sync.js';
import { toggleTheme, useTheme } from './state/theme.js';
import { bootUserDb, recoverFresh, retryUserDbBoot, useUserDbStatus } from './state/userdb.js';
import { ConnectionWizardNote } from './connections/ConnectionWizardNote.js';
import { ConnectionWizardSheet } from './connections/ConnectionWizardSheet.js';
import { OAuthCallbackPage } from './connections/OAuthCallbackPage.js';
import { NetConfirmDialog } from './run/NetConfirmDialog.js';
import { OpenUrlConfirmDialog } from './run/OpenUrlConfirmDialog.js';
import { Button } from './ui/Button.js';
import { initProtectOffer } from './vault/protectOffer.js';
import { UnlockScreen } from './vault/UnlockScreen.js';
import { Logo } from './ui/Logo.js';
import { ExternalLink } from './ui/ExternalLink.js';
import { LICENSE_URL, PRIVACY_PATH, TERMS_PATH, THREAT_MODEL_URL } from './legal/legalShared.js';
import { PRIVACY } from './legal/privacy.js';
import { TERMS } from './legal/terms.js';
import { LegalPage } from './views/LegalPage.js';
import { WebsiteLink } from './ui/WebsiteLink.js';
import { FeedbackMenu } from './feedback/FeedbackMenu.js';
import { ReportErrorLink } from './feedback/ReportErrorLink.js';
import { Skeleton } from './ui/Skeleton.js';
import { useDismissableMenu } from './ui/useDismissableMenu.js';
import { BrainChip } from './views/BrainChip.js';
import { BuilderView } from './views/BuilderView.js';
import { DownloadView } from './views/DownloadView.js';
import { HubView } from './views/HubView.js';
import { SettingsView } from './views/SettingsView.js';
import { SharedLinkView } from './views/SharedLinkView.js';
import { WebllmBanner } from './views/WebllmBanner.js';
import { hydrateSharedInbox, sharedOpenRequestStore } from './share/sharedInbox.js';
import { allows } from './platform/platform.js';
import { EmptyState } from './ui/EmptyState.js';

// The Run view carries the runner + sql.js driver — code-split so the hub stays light.
const RunView = lazy(() => import('./run/RunView.js'));

export function App(): ReactElement {
  const theme = useTheme();
  const dbStatus = useUserDbStatus();

  // Boot the user DB once and hydrate settings/app-meta from it (ADR-0007), then
  // resume the configured sync origin and probe the hub's optional auth surface.
  useEffect(() => {
    bootUserDb();
    // The Ollama probe answers BEFORE settings hydrate (P3 item 2): a hydrated
    // 'subscription' mode coerces to the best available mode, and "is local
    // available" is the probe's answer. On web the probe is a synchronous no-op,
    // so this ordering changes nothing there (AC10). The first-run latch reads the
    // same settings, so it follows hydration.
    void refreshOllama()
      .then(() => initSettings())
      .then(() => initDesktopFirstRun())
      // AFTER settings hydrate: the offer latch reads its keys out of the user file,
      // so it cannot run before the file is open and read. Web AND desktop (D3) —
      // unlike the desktop-only welcome latch above.
      // The two latch inits are independent one-key reads of the hydrated file —
      // parallel on purpose (Gate-5 review): serializing them delayed the callout
      // by the protect-offer init, and a throw in one skipped the other entirely.
      .then(() => Promise.all([initProtectOffer(), initDemoCallout()]))
      // The "shared with you" shelf mirrors `sharedApp:` rows of the file (ADR-0063 §4)
      // — read after settings, like the latches, because it needs the open file.
      .then(() => hydrateSharedInbox());
    // AL-07: the experimental webllm flag + WebGPU probe (idempotent, flag-gated).
    void initWebllm();
    // W2b: platform-only seam — a no-op on web (no open handler).
    registerPlatformOpenFile();
    void refreshAppMeta();
    void initSync();
    void refreshAuth();
    // ADR-0047 §9: the shell update launch check — desktop-only, toggleable, quiet
    // about failure (pre-flip the endpoint 404s by design). Its own exported act so
    // the composition-root test can spy the seat (plan-review finding 14).
    initAppUpdateLaunchCheck();
  }, []);

  if (dbStatus.state === 'locked') {
    // Before the shell renders anything else. A protected file is healthy and waiting
    // for a secret — so this is a door, not an error screen, and the rest of the hub
    // simply does not exist until it opens.
    return <UnlockScreen />;
  }

  if (dbStatus.state === 'load-failed') {
    // P3 item 7 — the boot open REJECTED (torn/magic-less file refused by the file
    // backend). A plain full-screen truth, not a banner over a broken shell: nothing
    // was overwritten, here is the file, try again when it is back.
    return (
      <div className="shell">
        <main className="shell-main">
          <div className="error-note" role="alert" data-testid="userdb-load-failed">
            <p>
              <strong>Your Snug file couldn&apos;t be read.</strong> It has not been overwritten — it is still on your
              disk exactly as it was.
            </p>
            {dbStatus.path !== undefined ? (
              <p>
                file: <code>{dbStatus.path}</code>
              </p>
            ) : null}
            <p className="hint">{dbStatus.message}</p>
            <p className="hint">
              if you have a backup or a synced copy, put it back in place — then try again. Nothing happens until you
              do. <ReportErrorLink context={{ surface: 'boot', errorText: dbStatus.message }} />
            </p>
            <Button variant="primary" onClick={() => retryUserDbBoot()}>
              try again
            </Button>
          </div>
        </main>
        {/* Finding 5: THE state where a user double-clicks their backup. Without
            the dialog here the open event parks invisibly behind this screen. */}
        <OpenUserFileConfirmDialog />
      </div>
    );
  }

  return (
    <div className="shell">
      {dbStatus.state === 'corrupt' || dbStatus.state === 'unsupported' ? (
        <div className="error-note" role="alert" style={{ margin: 'var(--space-3)' }}>
          {dbStatus.state === 'corrupt' ? (
            <>
              your snug file was unreadable and has been quarantined ({dbStatus.quarantinedFile}) — nothing was
              overwritten.
              <div style={{ marginTop: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    // Explicit recovery decision (F6/AC12): start empty, then restore
                    // via Settings — pick a sync origin (divergence → "use the origin
                    // copy") or import an exported snug file. The quarantine stays.
                    void recoverFresh().then(async () => {
                      await initSettings();
                      await refreshAppMeta();
                      await initSync();
                    });
                  }}
                >
                  start fresh (keep the quarantined copy)
                </button>
              </div>
              then restore in settings: pick your sync origin and choose “use the origin copy”, or import a snug file.
            </>
          ) : (
            dbStatus.message
          )}
        </div>
      ) : null}
      <header className="shell-header">
        <NavLink to="/" className="brand">
          <Logo className="brand-mark" />
          <span className="brand-word">
            snug<span className="brand-dot">.</span>
          </span>
        </NavLink>
        <nav className="shell-nav" aria-label="primary">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            your apps
          </NavLink>
          {/* The menu opens a NEW conversation unless the last one is still building
              (TASK-20260903 AC12); a finished build stays one click away in the sidebar. */}
          <NavLink to="/build" onClick={openBuildMenu} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            build
          </NavLink>
          <WebsiteLink />
          {/* Icon nav item (owner calls, TASK-20260822/23): about ↗ sits with the
              text links, the gear leads the icon cluster (⚙️ 💬 ☾). Emoji
              presentation (U+2699 U+FE0F) on purpose — the text-presentation gear
              read as one more thin glyph beside the theme toggle. The accessible
              name stays "settings" via aria-label, which is what the e2e specs
              (and screen readers) address it by. */}
          <NavLink
            to="/settings"
            aria-label="settings"
            title="settings"
            className={({ isActive }) => `nav-link nav-link-icon${isActive ? ' active' : ''}`}
          >
            ⚙️
          </NavLink>
          {/* ADR-0059: the always-on "what's thinking" status chip — the demo brain is
              never active without saying so, on any route. Sits by the gear because
              the chip's menu routes to Settings for every switch that needs config. */}
          <BrainChip />
          {/* ADR-0052: the ONE persistent feedback affordance — quiet, no badge. */}
          <FeedbackMenu />
          {/* ADR-0047 §9: a header WHISPER when a shell update is in play — desktop
              only, renders nothing otherwise; the sheet it opens is the one place the
              flow may occupy the screen, and only because the user clicked. */}
          <AppUpdateSurface />
          <HelperSurface />
          <Button variant="ghost" onClick={toggleTheme} aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? '☀' : '☾'}
          </Button>
          <IdentityChip />
        </nav>
      </header>
      <WebllmBanner />
      {/* P3 item 2: the honest trace of a hydrated-subscription coercion (desktop). */}
      <ModeCoercionNote />
      <main className="shell-main">
        <Routes>
          <Route path="/" element={<HubView />} />
          <Route path="/build" element={<BuilderView />} />
          <Route
            path="/run/:id"
            element={
              <Suspense
                fallback={
                  <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                    <Skeleton height="64px" />
                    <Skeleton height="60vh" style={{ borderRadius: 'var(--radius-l)' }} />
                  </div>
                }
              >
                <RunView />
              </Suspense>
            }
          />
          {/* The share LINK receiver (ADR-0064): every platform's landing page for
              `/s/<id>#<key>`; opens the preview from memory, never writes the file. */}
          <Route
            path="/s/:id"
            element={
              allows('share') ? (
                <SharedLinkView />
              ) : (
                // The relay is unreachable from this host (P3): a pasted link lands on a
                // named refusal, never an empty main region.
                <div className="run-overlay" data-testid="shared-link-unavailable">
                  <EmptyState
                    glyph="🔗"
                    title="share links can’t open here"
                    lesson="this host can’t reach the share relay — open the link in the Snug playground or in Snug for Mac."
                    action={
                      <Link to="/" className="btn">
                        back to your apps
                      </Link>
                    }
                  />
                </div>
              )
            }
          />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/download" element={<DownloadView />} />
          <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
          {/* ADR-0055 §1: disclosure, never a gate — ordinary routes, footer-linked,
              rendered offline on the desktop shell from bundled data. */}
          <Route path={TERMS_PATH} element={<LegalPage doc={TERMS} />} />
          <Route path={PRIVACY_PATH} element={<LegalPage doc={PRIVACY} />} />
        </Routes>
      </main>
      <ShellFooter />
      {/* ONE app-level wizard mount (P3, inheriting AL-04's M9 reason): the three entry
          points — chat directive card, Settings slot row, run-header error CTA — live in
          different views, and a per-view mount would strand the minutes-lived singleton
          (and any in-flight OAuth exchange) the moment the user navigated. */}
      <ConnectionWizardSheet />
      {/* The wizard-refusal note shares the sheet's app-level mount for the same
          reason: refusals happen from every entry point, and a per-view note would be
          silent exactly where the refused click came from (F4, TASK-20260812). */}
      <ConnectionWizardNote />
      {/* Desktop .snug open-with confirm (W2b): app-level for the same reason as the
          wizard — an OS open event can arrive on any route. Renders nothing on web. */}
      <OpenUserFileConfirmDialog />
      {/* A received bundle asks to be previewed from a non-React caller (the open
          seam, the Settings picker); this navigates and clears the request (ADR-0063). */}
      <SharedOpenNavigator />
      {/* The mutating-request confirm (TASK-20260815 AC12, plan-review F3): app-level
          because the confirm gate's callers are no longer only RunView's app frame —
          a provider-lane chat turn can park a confirm from the builder view too, and a
          mount the route doesn't render is a promise that never settles. */}
      <NetConfirmDialog />
      <OpenUrlConfirmDialog />
    </div>
  );
}

/**
 * Navigates to a shared preview when something outside the tree asks for one — the
 * platform open seam after a double-clicked `.snug` bundle, the Settings "add shared
 * app" picker. One consumer, so the request cannot be double-handled; cleared on read.
 */
function SharedOpenNavigator(): null {
  const navigate = useNavigate();
  const request = useStore(sharedOpenRequestStore);
  useEffect(() => {
    if (request === null) return;
    sharedOpenRequestStore.set(null);
    navigate(`/run/shared--${request}`);
  }, [request, navigate]);
  return null;
}

/**
 * The `.snug` open-with replace prompt (TASK-20260812 Decision 8): a platform open
 * event already passed the extension + sqlite-magic gates before this parks — the
 * dialog's only job is the explicit user decision. Never a silent import.
 */
export function OpenUserFileConfirmDialog(): ReactElement | null {
  const pending = useStore(openUserFileConfirmStore);
  const error = useStore(openUserFileErrorStore);

  // The failure banner (review finding 5): BAD_IMPORT / TOO_LARGE / a restore that
  // still would not open used to reject into nothing at all, so a double-click
  // silently did nothing. It renders whether or not a confirm is parked.
  const banner =
    error === null ? null : (
      <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="that snug file could not be opened">
        <div className="net-confirm-card">
          <h2 className="net-confirm-title">that file couldn&apos;t be opened</h2>
          <p className="net-confirm-body">
            Nothing was changed — your data is exactly as it was. {error}
          </p>
          <div className="field-row net-confirm-actions">
            <Button variant="primary" onClick={() => clearOpenUserFileError()}>
              ok
            </Button>
          </div>
        </div>
      </div>
    );

  if (pending === null) return banner;

  // When the database could not be opened at all, this file is a RESCUE, not a
  // replacement — there is nothing of the user's to overwrite, and saying
  // "your current data will be overwritten" would be a lie that scares a user
  // away from the one action that fixes their problem.
  const restore = pending.needsRestore;
  return (
    <>
      {banner}
      <div
        className="net-confirm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={restore ? 'restore from this snug file' : 'replace your snug data'}
      >
        <div className="net-confirm-card">
          <h2 className="net-confirm-title">{restore ? 'restore from this file?' : 'open this snug file?'}</h2>
          <p className="net-confirm-body">
            {restore ? (
              <>
                Snug couldn&apos;t read your data, so there is nothing to lose. Use <strong>{pending.path}</strong> to
                start again from this backup?
              </>
            ) : (
              <>
                Replace your Snug data with the file <strong>{pending.path}</strong>? Your current data will be
                overwritten.
              </>
            )}
          </p>
          <div className="field-row net-confirm-actions">
            <Button variant="ghost" onClick={() => resolveOpenUserFileConfirm(false)}>
              {restore ? 'not now' : 'keep my current data'}
            </Button>
            <Button variant="primary" onClick={() => resolveOpenUserFileConfirm(true)}>
              {restore ? 'restore from this file' : 'replace'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Header identity (living-apps child 4): login state, visible on EVERY page.
 * `unavailable` (static demo / v1 server) renders nothing — logged-out stays a fully
 * working local-only hub, so we advertise sign-in only where it exists.
 *
 * Signed in, the chip is a MENU trigger (not a link): account name, a route to
 * account & sync settings, and sign out. Sign out goes through `signOut()` from
 * state/sync.js — NEVER the bare `logout()` — because the hub sync provider captures
 * the CSRF token at construction, so the loop has to be rebuilt after the cookies
 * are cleared (review F14).
 */
export function IdentityChip(): ReactElement | null {
  const auth = useAuth();
  // Escape / outside-pointer close with focus restored to the trigger (AC2) — the
  // shared contract, extracted once the third popover arrived (useDismissableMenu).
  const { open, toggle, close, triggerRef, menuRef } = useDismissableMenu();

  if (auth.state === 'unavailable') return null;
  if (auth.state === 'unknown') return <Skeleton width="72px" height="28px" />;
  if (auth.state === 'anonymous') {
    return (
      <Button variant="ghost" onClick={() => login()} title="sign in with Google — the hub can keep a synced copy of your snug file">
        sign in
      </Button>
    );
  }
  const label = auth.user.name ?? auth.user.email ?? 'account';
  return (
    <div className="identity-menu-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="identity-chip"
        aria-haspopup="true"
        aria-expanded={open}
        title={`${label} — account & sync settings`}
        onClick={toggle}
      >
        <IdentityAvatar label={label} picture={auth.user.picture} />
        <span className="identity-name">{label}</span>
      </button>
      {open ? (
        // ADVERSARIAL-REVIEW FIX (2026-08-04): this carried role="menu"/role="menuitem",
        // which promises the APG keyboard contract — focus moves into the menu on open,
        // Arrow keys move between items, Home/End jump. None of that was implemented, so
        // a screen-reader user heard "menu, 2 items" and found the documented keys inert
        // — WORSE than plain markup. AC2 asks for keyboard-reachable, which Tab already
        // satisfies natively for a link + button. Dropping the roles (rather than
        // implementing roving focus) makes the markup honest about what it does.
        // aria-haspopup="true" still announces that the trigger opens something.
        <div className="identity-menu" ref={menuRef} aria-label="account">
          <span className="identity-menu-label">{label}</span>
          <Link to="/settings" className="identity-menu-item" onClick={() => close(false)}>
            account &amp; sync settings
          </Link>
          <button
            type="button"
            className="identity-menu-item"
            onClick={() => {
              close(false);
              void signOut();
            }}
          >
            sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Avatar: the Google picture when we have one, the initial-letter circle otherwise.
 * `referrerPolicy="no-referrer"` is load-bearing — lh3.googleusercontent.com answers
 * 403 for some accounts when a referrer is sent (AC7) — and a load failure falls back
 * to the letter rather than leaving a broken image in the header (AC6).
 */
function IdentityAvatar({ label, picture }: { label: string; picture?: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [picture]);
  if (picture !== undefined && picture !== '' && !failed) {
    return (
      <img
        className="identity-avatar"
        src={picture}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="identity-avatar" aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The shell footer (ADR-0055 §1; TASK-20260823-legal-terms-privacy-eula AC4): terms ·
 * privacy · threat model · MIT, on every route EXCEPT inside a running app — the app
 * view is the product surface and its either/or mobile band is pinned at ≤1000px by
 * mobile.spec.ts — and the OAuth callback popup, where a footer is noise. Links, never a
 * gate: under Berman v. Freedom Financial a footer binds nobody, and that is fine —
 * these pages do disclosure work (the DMG's EULA is the product's one clickwrap).
 */
function ShellFooter(): ReactElement | null {
  const { pathname } = useLocation();
  if (pathname.startsWith('/run/') || pathname.startsWith('/oauth/')) return null;
  return (
    <footer className="shell-footer" aria-label="legal">
      <Link to={TERMS_PATH} data-testid="footer-terms">
        terms
      </Link>
      <Link to={PRIVACY_PATH} data-testid="footer-privacy">
        privacy
      </Link>
      <ExternalLink href={THREAT_MODEL_URL} data-testid="footer-threat-model">
        threat model
      </ExternalLink>
      <ExternalLink href={LICENSE_URL} data-testid="footer-license">
        MIT license
      </ExternalLink>
    </footer>
  );
}
