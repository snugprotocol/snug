import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  availableModes,
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
  type PlaygroundMode,
} from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { getPlatform } from '../platform/platform.js';
import { login, useAuth } from '../state/auth.js';
import {
  applyRemote,
  DROPBOX_TOKEN_SECRET,
  exportUserFile,
  importUserFile,
  pushLocal,
  setSyncOrigin,
  useSyncStatus,
  type SyncOriginKind,
} from '../state/sync.js';
import { setTheme, useTheme } from '../state/theme.js';
import { useBrain, useWebllmFlag, WEBLLM_FALLBACK_BANNER } from '../state/webllm.js';
import { UserDbCredentialStore } from '@snugprotocol/auth';
import { getUserDb } from '../state/userdb.js';
import { invalidateNetGrants } from '../state/net.js';
import { useStore } from '../state/store.js';
import { downloadBlob } from '../run/exportDb.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConnectionSlotsCard } from './ConnectionSlotsCard.js';


const MODE_LABELS: Record<PlaygroundMode, string> = {
  byok: 'bring your own key',
  local: 'local model',
  subscription: 'hub subscription',
};

/** The model select's escape hatch back to free text. */
const OTHER_MODEL_CHOICE = '__other__';

export function SettingsView(): ReactElement {
  const mode = useMode();
  const provider = useProvider();
  const model = useModel();
  const localUrl = useLocalUrl();
  const needsConfirm = useEndpointsNeedConfirm();
  const theme = useTheme();
  const ollama = useOllama();
  const [keyDraft, setKeyDraft] = useState('');
  const [modelOther, setModelOther] = useState(false);

  // AC3: detection results only ever exist where a platform probe ran (desktop) —
  // on web `ollama` stays 'unknown' and every branch below keeps today's rendering.
  const detectedModels =
    mode === 'local' && ollama !== 'unknown' && ollama.running && ollama.models.length > 0 ? ollama.models : undefined;
  const modelSelectValue =
    modelOther || (model !== undefined && detectedModels !== undefined && !detectedModels.includes(model))
      ? OTHER_MODEL_CHOICE
      : (model ?? '');
  const showModelInput = detectedModels === undefined || modelSelectValue === OTHER_MODEL_CHOICE;

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
            {/* Decision 10: the platform decides which modes exist — the desktop shell
                never offers subscription, and that is a capability, not a hidden flag. */}
            {availableModes().map((option) => (
              <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)}>
                {MODE_LABELS[option]}
              </button>
            ))}
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

      <WebllmExperimentCard />

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
            <div className="field field-gap">
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
            {ollama !== 'unknown' && !ollama.running ? (
              <span className="hint">Ollama not found — install it from ollama.com or paste an endpoint.</span>
            ) : ollama !== 'unknown' && ollama.running && ollama.models.length === 0 ? (
              /* P3 item 3 (W2b): running-but-empty is its own state — the install
                 succeeded, only a model is missing. Free text stays available. */
              <span className="hint">
                Ollama is installed but has no models yet — try: <code>ollama pull llama3.2</code>
              </span>
            ) : (
              <span className="hint">
                any OpenAI-compatible server. for Ollama, set OLLAMA_ORIGINS to allow this hub, and mind that an https
                hub cannot reach http://localhost in Safari.
              </span>
            )}
          </div>
        </Card>
      ) : null}

      {mode !== 'byok' || provider !== 'mock' ? (
        <Card>
          <div className="field">
            <label htmlFor={detectedModels !== undefined ? 'model-select' : 'model-id'}>model</label>
            {detectedModels !== undefined ? (
              <select
                id="model-select"
                value={modelSelectValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === OTHER_MODEL_CHOICE) {
                    setModelOther(true);
                    return;
                  }
                  setModelOther(false);
                  setModel(value);
                }}
              >
                <option value="">let the endpoint choose</option>
                {detectedModels.map((detected) => (
                  <option key={detected} value={detected}>
                    {detected}
                  </option>
                ))}
                <option value={OTHER_MODEL_CHOICE}>other…</option>
              </select>
            ) : null}
            {showModelInput ? (
              <input
                id="model-id"
                type="text"
                value={model ?? ''}
                onChange={(event) => setModel(event.target.value)}
                placeholder={
                  mode === 'local' ? 'llama3.2' : provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5'
                }
              />
            ) : null}
            <span className="hint">
              {detectedModels !== undefined
                ? 'these models are installed in your Ollama — pick one, or choose other… to type a name.'
                : 'leave empty for the provider’s default.'}
            </span>
          </div>
        </Card>
      ) : null}

      <AccountCard />
      <DataCard />
      {/*
        P3 (fold B1): the v4 slot-aware card replaces AL-03's app-keyed ConnectionsCard.
        One row per (app, SLOT) rather than one per app — the same provider connected in
        two apps is two independent grants, and the old card could not say so.
      */}
      <ConnectionSlotsCard />

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

    </div>
  );
}

/**
 * AL-07 experimental webllm surface — rendered ONLY while the `?webllm=1` flag is on
 * (AC1: flag-off has zero webllm footprint). Deliberately NOT a mode button: the
 * in-browser brain must not read as a first-class equal of byok/local/subscription
 * until GA (1.2). The card explains that the flag overrides the mode choice above.
 */
function WebllmExperimentCard(): ReactElement | null {
  const flagOn = useWebllmFlag();
  const brain = useBrain();
  if (!flagOn) return null;
  return (
    <Card>
      <div className="field" data-testid="webllm-experimental-card">
        <label>experimental — in-browser model</label>
        <span className="hint">
          {brain.kind === 'webllm'
            ? `the ?webllm=1 flag is on: builds and app turns run through ${brain.model} on WebGPU, inside this tab, ` +
              'overriding the choice above. the model downloads on first use (GBs, cached by the browser). ' +
              'the experiment stays on for this session even as you navigate — to leave it, reload the page ' +
              'without ?webllm=1 in the address bar.'
            : brain.kind === 'demo' && brain.reason === 'no-webgpu'
              ? `the ?webllm=1 flag is on, but ${WEBLLM_FALLBACK_BANNER}.`
              : 'the ?webllm=1 flag is on — checking whether this browser can run WebGPU…'}
        </span>
      </div>
    </Card>
  );
}

/** Hub account (living-apps child 4): optional — logged-out is fully functional, local-only. */
export function AccountCard(): ReactElement | null {
  const auth = useAuth();
  const sync = useSyncStatus();
  if (auth.state === 'unknown') return null;
  return (
    <Card>
      <div className="field">
        <label>hub account</label>
        {auth.state === 'unavailable' ? (
          <span className="hint">
            this hub is running without an account surface (static demo or a server without SNUG_AUTH) — everything
            here is local-only and fully functional. a hub with Google sign-in can keep a synced copy of your snug
            file across devices.
          </span>
        ) : auth.state === 'signed-in' ? (
          <>
            <span className="hint">
              signed in as {auth.user.name ?? auth.user.email ?? auth.user.userId} — the hub can host your snug file
              as a sync origin.
            </span>
            {sync.origin === 'none' ? (
              <div className="field-row">
                <span className="hint">your snug file isn’t syncing anywhere yet.</span>
                <Button onClick={() => void setSyncOrigin('hub')}>sync to this hub</Button>
              </div>
            ) : null}
            {/* sign out lives in the header identity menu (AC3) — reachable from every
                page there, rather than only from this card. */}
          </>
        ) : (
          <>
            <span className="hint">
              optional: sign in with Google so this hub can keep a copy of your snug file and restore it on any
              device. everything works without it.
            </span>
            <Button onClick={() => login()}>sign in with google</Button>
          </>
        )}
      </div>
    </Card>
  );
}

/** Your data (children 3/4): the single portable file — origin, export, import. */
function DataCard(): ReactElement {
  const sync = useSyncStatus();
  const [dropboxToken, setDropboxToken] = useState('');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [dataError, setDataError] = useState<string | undefined>(undefined);

  const onExport = (): void => {
    setDataError(undefined);
    // Desktop names the portable file `.snug` (Decision 8) — same sqlite bytes, same
    // magic, only the suggested name changes; the web download keeps `.sqlite`.
    const filename = getPlatform().kind === 'desktop' ? 'snug-user.snug' : 'snug-user.sqlite';
    void exportUserFile(includeSecrets)
      .then((blob) => downloadBlob(blob, filename))
      .catch((err: unknown) => setDataError(err instanceof Error ? err.message : String(err)));
  };

  const onImport = (file: File | undefined): void => {
    if (file === undefined) return;
    setDataError(undefined);
    void importUserFile(file).catch((err: unknown) =>
      setDataError(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <Card>
      <div className="field">
        <label id="origin-label">your snug file</label>
        <span className="hint">
          one SQLite file holds your apps, their data, chats, and settings. it runs from this browser and can sync to
          an origin you choose — or nowhere.
        </span>
        <div className="seg" role="group" aria-labelledby="origin-label">
          {/* Amendment 13: the hub origin only exists where the platform can reach a
              hub (relative /userdb URLs mean nothing against tauri://). */}
          {(getPlatform().capabilities.hubSyncOrigin
            ? (['none', 'hub', 'dropbox'] as SyncOriginKind[])
            : (['none', 'dropbox'] as SyncOriginKind[])
          ).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={sync.origin === kind}
              onClick={() => void setSyncOrigin(kind)}
            >
              {kind === 'none' ? 'this device only' : kind === 'hub' ? 'this hub' : 'dropbox'}
            </button>
          ))}
        </div>
        {sync.state === 'divergence' ? (
          <div className="error-note" role="alert">
            {/* detail is set by onSyncEvent and distinguishes "different copy" from
                "the origin lost its copy" — the resolver is the same either way. */}
            {sync.detail ?? 'the origin holds a different copy of your file'}. pick which one wins:
            <div className="field-row">
              <Button onClick={() => void applyRemote()}>use the origin copy</Button>
              <Button onClick={() => void pushLocal()}>keep this device’s copy</Button>
            </div>
          </div>
        ) : sync.state === 'error' ? (
          <div className="error-note" role="alert">
            sync problem — {sync.detail}
          </div>
        ) : null}
        {sync.origin === 'dropbox' ? (
          <div className="field field-gap-s">
            <label htmlFor="dropbox-token">dropbox access token</label>
            <input
              id="dropbox-token"
              type="password"
              autoComplete="off"
              value={dropboxToken}
              placeholder="paste a Dropbox access token"
              onChange={(event) => {
                setDropboxToken(event.target.value);
                void getUserDb().then((db) => {
                  const trimmed = event.target.value.trim();
                  if (trimmed === '') db.deleteSecret(DROPBOX_TOKEN_SECRET);
                  else db.setSecret(DROPBOX_TOKEN_SECRET, trimmed);
                });
              }}
            />
            <span className="hint">
              stored in your snug file on this device only — like BYOK keys, it never syncs to the hub.
            </span>
          </div>
        ) : null}
      </div>
      <div className="field field-gap">
        <label>portability</label>
        {dataError !== undefined ? (
          <div className="error-note" role="alert">
            {dataError}
          </div>
        ) : null}
        <div className="field-row field-row-wrap">
          <Button onClick={onExport}>export snug file</Button>
          <label className="check-label">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(event) => setIncludeSecrets(event.target.checked)}
            />
            include secrets
          </label>
          <label className="btn file-btn">
            import snug file
            <input
              type="file"
              accept=".sqlite,application/x-sqlite3,application/octet-stream"
              style={{ display: 'none' }}
              onChange={(event) => onImport(event.target.files?.[0])}
            />
          </label>
        </div>
        <span className="hint">
          the export is the whole file — take it to another hub, a personal origin, or a local runner. secrets stay
          out unless you opt in. imported files ask you to re-confirm model endpoints before running.
        </span>
      </div>
    </Card>
  );
}

