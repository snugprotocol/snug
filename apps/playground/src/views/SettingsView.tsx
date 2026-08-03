import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  confirmEndpoints,
  getByokKey,
  setByokKey,
  setLocalUrl,
  setMode,
  setModel,
  setProvider,
  useEndpointsNeedConfirm,
  useLocalUrl,
  useMode,
  useModel,
  useProvider,
  type ByokProvider,
} from '../state/mode.js';
import { setTheme, useTheme } from '../state/theme.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Chip } from '../ui/Chip.js';

export function SettingsView(): ReactElement {
  const mode = useMode();
  const provider = useProvider();
  const model = useModel();
  const localUrl = useLocalUrl();
  const needsConfirm = useEndpointsNeedConfirm();
  const theme = useTheme();
  const [keyDraft, setKeyDraft] = useState('');

  // Keys live in the user DB (async) — load the draft when the provider changes.
  useEffect(() => {
    let cancelled = false;
    if (mode === 'byok' && provider !== 'mock') {
      void getByokKey(provider).then((key) => {
        if (!cancelled) setKeyDraft(key ?? '');
      });
    } else {
      setKeyDraft('');
    }
    return () => {
      cancelled = true;
    };
  }, [mode, provider]);

  return (
    <div className="settings">
      <h1>settings</h1>

      {needsConfirm ? (
        <Card>
          <div className="field">
            <label>imported settings need a look</label>
            <span className="hint">
              this snug file arrived from an import or sync — its model endpoints and provider choices are
              executable config. review the values below, then confirm to re-arm the agent.
            </span>
            <Button onClick={() => confirmEndpoints()}>these settings are mine — confirm</Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="field">
          <label id="mode-label">where the agent runs</label>
          <div className="seg" role="group" aria-labelledby="mode-label">
            <button type="button" aria-pressed={mode === 'byok'} onClick={() => setMode('byok')}>
              bring your own key
            </button>
            <button type="button" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>
              local model
            </button>
            <button type="button" aria-pressed={mode === 'subscription'} onClick={() => setMode('subscription')}>
              hub subscription
            </button>
          </div>
          <span className="hint">
            {mode === 'byok'
              ? 'everything runs in this browser — your key goes straight to the provider, never to the hub.'
              : mode === 'local'
                ? 'fully on-device: the agent talks to an OpenAI-compatible endpoint on your machine (e.g. Ollama).'
                : 'requests go through the hub server (:8787) and its LLM subscription — run `pnpm dev` in apps/server.'}
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
            {provider === 'mock' ? (
              <span className="hint">no key? try the demo brain — it builds a tiny oracle, offline.</span>
            ) : null}
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
                  void setByokKey(provider, event.target.value);
                }}
              />
              <span className="hint">
                stored in your snug file on this device, sent straight to {provider} from your browser — never to the
                hub, and stripped from hub sync and default exports.
              </span>
            </div>
          ) : null}
        </Card>
      ) : null}

      {mode === 'local' ? (
        <Card>
          <div className="field">
            <label htmlFor="local-url">endpoint</label>
            <input
              id="local-url"
              type="text"
              value={localUrl}
              onChange={(event) => setLocalUrl(event.target.value)}
              placeholder="http://localhost:11434/v1"
            />
            <span className="hint">
              any OpenAI-compatible server. for Ollama, set OLLAMA_ORIGINS to allow this hub, and mind that an https
              hub cannot reach http://localhost in Safari.
            </span>
          </div>
        </Card>
      ) : null}

      {mode !== 'byok' || provider !== 'mock' ? (
        <Card>
          <div className="field">
            <label htmlFor="model-id">model</label>
            <input
              id="model-id"
              type="text"
              value={model ?? ''}
              onChange={(event) => setModel(event.target.value)}
              placeholder={
                mode === 'local' ? 'llama3.2' : provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5'
              }
            />
            <span className="hint">leave empty for the provider’s default.</span>
          </div>
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
