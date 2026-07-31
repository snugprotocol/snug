import { useState } from 'react';
import type { ReactElement } from 'react';

import {
  getByokKey,
  setByokKey,
  setMode,
  setProvider,
  useMode,
  useProvider,
  type ByokProvider,
} from '../state/mode.js';
import { setTheme, useTheme } from '../state/theme.js';
import { Card } from '../ui/Card.js';
import { Chip } from '../ui/Chip.js';

export function SettingsView(): ReactElement {
  const mode = useMode();
  const provider = useProvider();
  const theme = useTheme();
  const [keyDraft, setKeyDraft] = useState(() => getByokKey() ?? '');

  return (
    <div className="settings">
      <h1>settings</h1>

      <Card>
        <div className="field">
          <label id="mode-label">where the agent runs</label>
          <div className="seg" role="group" aria-labelledby="mode-label">
            <button type="button" aria-pressed={mode === 'server'} onClick={() => setMode('server')}>
              local server
            </button>
            <button type="button" aria-pressed={mode === 'byok'} onClick={() => setMode('byok')}>
              bring your own key
            </button>
          </div>
          <span className="hint">
            {mode === 'server'
              ? 'requests go to the reference server on :8787 — run `pnpm dev` in apps/server.'
              : 'everything runs in this browser tab. your apps live in this browser too.'}
          </span>
        </div>
      </Card>

      {mode === 'byok' ? (
        <Card>
          <div className="field">
            <label htmlFor="byok-provider">provider</label>
            <select
              id="byok-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ByokProvider)}
            >
              <option value="mock">demo brain (no key needed)</option>
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
            </select>
            {provider === 'mock' ? <span className="hint">no key? try the demo brain — it builds a tiny oracle, offline.</span> : null}
          </div>
          {provider !== 'mock' ? (
            <div className="field" style={{ marginTop: 'var(--space-4)' }}>
              <label htmlFor="byok-key">api key</label>
              <input
                id="byok-key"
                type="password"
                autoComplete="off"
                value={keyDraft}
                placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                onChange={(event) => {
                  setKeyDraft(event.target.value);
                  setByokKey(event.target.value);
                }}
              />
              <span className="hint">
                stays in this tab only (sessionStorage) — sent straight to {provider} from your browser, never to our
                server. closing the tab forgets it.
              </span>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <div className="field">
          <label id="theme-label">theme</label>
          <div className="seg" role="group" aria-labelledby="theme-label">
            <button type="button" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
              dark
            </button>
            <button type="button" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
              light
            </button>
          </div>
          <span className="hint">running apps are told live — watch the host event in the inspector.</span>
        </div>
      </Card>

      <div>
        <Chip inert>connect account — coming in v1.1</Chip>
      </div>
    </div>
  );
}
