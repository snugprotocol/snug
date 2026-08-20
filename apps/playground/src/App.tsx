import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';

import {
  clearOpenUserFileError,
  openUserFileConfirmStore,
  openUserFileErrorStore,
  registerPlatformOpenFile,
  resolveOpenUserFileConfirm,
} from './platform/openFile.js';
import { initDesktopFirstRun } from './desktop/firstRun.js';
import { ModeCoercionNote } from './desktop/ModeCoercionNote.js';
import { refreshAppMeta } from './state/appMeta.js';
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
import { UnlockScreen } from './vault/UnlockScreen.js';
import { Logo } from './ui/Logo.js';
import { Skeleton } from './ui/Skeleton.js';
import { BuilderView } from './views/BuilderView.js';
import { HubView } from './views/HubView.js';
import { SettingsView } from './views/SettingsView.js';
import { WebllmBanner } from './views/WebllmBanner.js';

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
      .then(() => initDesktopFirstRun());
    // AL-07: the experimental webllm flag + WebGPU probe (idempotent, flag-gated).
    void initWebllm();
    // W2b: platform-only seam — a no-op on web (no open handler).
    registerPlatformOpenFile();
    void refreshAppMeta();
    void initSync();
    void refreshAuth();
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
              do.
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
          <NavLink to="/build" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            build
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            settings
          </NavLink>
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
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        </Routes>
      </main>
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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape and on any pointer landing outside the chip+menu. Both paths
  // return focus to the trigger so keyboard users are never dropped at the top of
  // the document (AC2).
  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true)) {
        return;
      }
      close(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

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
        onClick={() => setOpen((prev) => !prev)}
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
