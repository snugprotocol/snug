import { Suspense, lazy, useEffect } from 'react';
import type { ReactElement } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';

import { refreshAppMeta } from './state/appMeta.js';
import { login, refreshAuth, useAuth } from './state/auth.js';
import { initSettings } from './state/mode.js';
import { initSync } from './state/sync.js';
import { toggleTheme, useTheme } from './state/theme.js';
import { bootUserDb, recoverFresh, useUserDbStatus } from './state/userdb.js';
import { Button } from './ui/Button.js';
import { Skeleton } from './ui/Skeleton.js';
import { BuilderView } from './views/BuilderView.js';
import { HubView } from './views/HubView.js';
import { SettingsView } from './views/SettingsView.js';

// The Run view carries the runner + sql.js driver — code-split so the hub stays light.
const RunView = lazy(() => import('./run/RunView.js'));

export function App(): ReactElement {
  const theme = useTheme();
  const dbStatus = useUserDbStatus();

  // Boot the user DB once and hydrate settings/app-meta from it (ADR-0007), then
  // resume the configured sync origin and probe the hub's optional auth surface.
  useEffect(() => {
    bootUserDb();
    void initSettings();
    void refreshAppMeta();
    void initSync();
    void refreshAuth();
  }, []);

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
          snug<span className="brand-dot">.</span>
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
        </Routes>
      </main>
    </div>
  );
}

/**
 * Header identity (living-apps child 4): login state, visible on EVERY page.
 * `unavailable` (static demo / v1 server) renders nothing — logged-out stays a fully
 * working local-only hub, so we advertise sign-in only where it exists.
 */
function IdentityChip(): ReactElement | null {
  const auth = useAuth();
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
  const initial = label.slice(0, 1).toUpperCase();
  return (
    <Link to="/settings" className="identity-chip" title={`${label} — account & sync settings`}>
      <span className="identity-avatar" aria-hidden="true">
        {initial}
      </span>
      <span className="identity-name">{label}</span>
    </Link>
  );
}
