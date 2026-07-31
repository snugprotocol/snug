import { Suspense, lazy } from 'react';
import type { ReactElement } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';

import { toggleTheme, useTheme } from './state/theme.js';
import { Button } from './ui/Button.js';
import { Skeleton } from './ui/Skeleton.js';
import { BuilderView } from './views/BuilderView.js';
import { HubView } from './views/HubView.js';
import { SettingsView } from './views/SettingsView.js';

// The Run view carries the runner + sql.js driver — code-split so the hub stays light.
const RunView = lazy(() => import('./run/RunView.js'));

export function App(): ReactElement {
  const theme = useTheme();
  return (
    <div className="shell">
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
