// SettingsView — redesigned for TASK-20260821 (AC8/AC9/AC11/AC14).
//
// STRUCTURE: Apple-Settings idiom over the app's own tokens — a hero title, then five
// labelled sections (brain · account · your file · connections · appearance), each an
// inset grouped card of rows. No new palette, no new fonts: everything derives from
// theme/tokens.css, so the page belongs to the product it configures.
//
// BEHAVIOR PINS CARRIED VERBATIM (a redesign is a re-layout, not a re-contract):
//   - the mode segment keeps its accessible name 'where the agent runs' and its three
//     labels — e2e/webllm.spec.ts locates it by role+name in a lane CI does not run;
//   - the webllm experiment card keeps its testid and copy;
//   - local mode keeps `#local-url`, `#model-select`/`#model-id`, the `other…` escape
//     hatch and every Ollama hint (desktopSettingsView.test.tsx pins all five states);
//   - the F15 imported-settings confirm, protection, data and connection cards keep
//     their strings, testids and actions.
//
// WHAT CHANGED FUNCTIONALLY (TASK-20260821): the single-provider BYOK card became the
// multi-provider section — a key row per provider with a per-provider default model,
// plus a default-provider control (auto: Anthropic when both keys exist; the user's
// explicit pick overrides) — and the standalone "model" card is GONE: its local-mode
// half lives in the local section, its subscription half in the subscription section,
// and byok defaults are per-provider now.

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { popularModelsFor } from '@snugprotocol/adapters';

import {
  availableModes,
  confirmEndpoints,
  getByokKey,
  setByokKey,
  setLocalUrl,
  setMode,
  setModel,
  setProvider,
  setProviderModel,
  useByokKeyPresence,
  useEndpointsNeedConfirm,
  useLocalUrl,
  useMode,
  useModel,
  useProvider,
  useProviderChoice,
  useProviderModels,
  KEYED_PROVIDERS,
  type ByokProvider,
  type KeyedProvider,
  type PlaygroundMode,
} from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { ProtectSetupFlow } from '../vault/ProtectSetupFlow.js';
import { disableProtection } from '../vault/enableProtection.js';
import { SETTING_PROTECTION_ENABLED, markProtectionDisabled } from '../vault/protectOffer.js';
import { allows, getPlatform, secretsUsable } from '../platform/platform.js';
import { autoCheckEnabled, checkForAppUpdate, setAutoCheckEnabled, useAppUpdate } from '../state/appUpdate.js';
import { login, useAuth } from '../state/auth.js';
import {
  applyRemote,
  DROPBOX_TOKEN_SECRET,
  exportUserFile,
  hubOriginAvailable,
  importUserFile,
  pushLocal,
  setSyncOrigin,
  useSyncStatus,
  type SyncOriginKind,
} from '../state/sync.js';
import { setTheme, useTheme } from '../state/theme.js';
import { useBrain, useWebllmFlag, WEBLLM_FALLBACK_BANNER } from '../state/webllm.js';
import { getUserDb } from '../state/userdb.js';
import { downloadBlob } from '../run/exportDb.js';
import { sniffSnugFile } from '@snugprotocol/db';
import { receiveSharedBundle, sharedOpenRequestStore } from '../share/sharedInbox.js';
import { FeedbackCard } from '../feedback/FeedbackCard.js';
import { ADAPTER_DEFAULTS, labelFor, PROVIDER_LABELS } from '../run/ModelSelect.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ExternalLink } from '../ui/ExternalLink.js';
import { EULA_TEXT } from '../legal/eula.js';
import { isLocalEndpointHost, localEndpointHostOf } from '../security/privateHost.js';
import { LICENSE_URL, PRIVACY_PATH, TERMS_PATH, THREAT_MODEL_URL } from '../legal/legalShared.js';
import { ConnectionSlotsCard } from './ConnectionSlotsCard.js';

const MODE_LABELS: Record<PlaygroundMode, string> = {
  byok: 'bring your own key',
  local: 'local model',
  subscription: 'hub subscription',
};

/** The model select's escape hatch back to free text. */
const OTHER_MODEL_CHOICE = '__other__';

/** Section shell: an eyebrow label + one inset grouped card. */
function Section({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section className="settings-section" data-testid={`settings-section-${label.replace(/\s+/g, '-')}`}>
      <h2 className="settings-section-label">{label}</h2>
      {children}
    </section>
  );
}

export function SettingsView(): ReactElement {
  const mode = useMode();
  const model = useModel();
  const localUrl = useLocalUrl();
  const needsConfirm = useEndpointsNeedConfirm();
  const theme = useTheme();
  const ollama = useOllama();
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

  return (
    <div className="settings">
      <header className="settings-hero">
        <h1>settings</h1>
        <p className="settings-hero-sub">
          {allows('brainSettings')
            ? 'your brain, your file, your connections — everything lives with you.'
            : 'your file, your apps — everything lives with you.'}
        </p>
      </header>

      {/* F15's card asks the user to confirm the FILE's endpoints — meaningless where no
          brain can be chosen (the host kit pins its own; TASK-20260905-host-kit P3). */}
      {needsConfirm && allows('brainSettings') ? (
        <Card className="settings-attention">
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

      {allows('brainSettings') ? (
        <Section label="brain">
          <Card className="settings-group">
            <div className="field settings-row">
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

            <WebllmExperimentCard />

            {mode === 'byok' ? <ByokProvidersRows /> : null}

            {mode === 'local' ? (
              <>
                <div className="field settings-row">
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
                      any OpenAI-compatible server. for Ollama, set OLLAMA_ORIGINS to allow this hub, and mind that an
                      https hub cannot reach http://localhost in Safari.
                    </span>
                  )}
                  <LocalEndpointBand url={localUrl} />
                </div>
                {/* The old standalone model card's LOCAL half, moved in-section
                    (TASK-20260821 AC11): same ids, same states, same hints. */}
                <div className="field settings-row">
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
                      placeholder="llama3.2"
                    />
                  ) : null}
                  <span className="hint">
                    {detectedModels !== undefined
                      ? 'these models are installed in your Ollama — pick one, or choose other… to type a name.'
                      : 'leave empty for the provider’s default.'}
                  </span>
                </div>
              </>
            ) : null}

            {mode === 'subscription' ? (
              /* The old model card's SUBSCRIPTION half: a free-text default-model
                 override for the hub's adapters, still the global `model` setting. */
              <div className="field settings-row">
                <label htmlFor="model-id">default model</label>
                <input
                  id="model-id"
                  type="text"
                  value={model ?? ''}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="claude-sonnet-5"
                />
                <span className="hint">leave empty for the provider’s default.</span>
              </div>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {allows('account') ? (
        <Section label="account">
          <AccountCard />
        </Section>
      ) : null}

      <Section label="your file">
        <DataCard />
        <ProtectionCard />
      </Section>

      {allows('connections') ? (
        <Section label="connections">
          {/*
            P3 (fold B1): the v4 slot-aware card replaces AL-03's app-keyed ConnectionsCard.
            One row per (app, SLOT) rather than one per app — the same provider connected in
            two apps is two independent grants, and the old card could not say so.
          */}
          <ConnectionSlotsCard />
        </Section>
      ) : null}

      <Section label="feedback">
        <FeedbackCard />
      </Section>

      <Section label="appearance">
        <Card className="settings-group">
          <div className="field settings-row">
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
      </Section>

      {/* ADR-0055 §1: "about" — version + update controls (desktop) or the download
          pointer (web), plus the legal links; the DMG's EULA text rendered offline on
          desktop. Renamed from "app" (TASK-20260823-legal-terms-privacy-eula AC5). */}
      <Section label="about">
        <AppVersionCard />
      </Section>
    </div>
  );
}

/**
 * The shell's own version + update controls (ADR-0047 §9, TASK-20260821 AC13/AC16).
 * Desktop: version, a manual "check for updates" whose failure is NAMED (the launch
 * check is quiet by design — pre-flip the endpoint 404s for everyone — but a click
 * is a question that deserves an answer, lessons 2026-08-17), and the auto-check
 * toggle (the launch check is a phone-home; the threat model names it, this is the
 * off switch). Web: the pointer to the /download page.
 */
function AppVersionCard(): ReactElement {
  const updates = getPlatform().appUpdates;
  const update = useAppUpdate();
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [autoCheck, setAutoCheck] = useState(() => autoCheckEnabled());
  useEffect(() => {
    let cancelled = false;
    void updates?.currentVersion().then((v) => {
      if (!cancelled) setVersion(v);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (updates === undefined) {
    return (
      <Card className="settings-group">
        <div className="field settings-row">
          <label>Snug desktop</label>
          <span className="hint">
            the free macOS app adds native networking for connected apps and keeps your file in <code>~/Snug</code>.
          </span>
          <Link to="/download" data-testid="settings-get-desktop">
            get the desktop app
          </Link>
        </div>
        <AboutLinks />
      </Card>
    );
  }

  return (
    <Card className="settings-group">
      <div className="field settings-row">
        <label>Snug desktop{version !== undefined ? ` v${version}` : ''}</label>
        <div className="field-row">
          <Button
            variant="ghost"
            data-testid="settings-check-updates"
            disabled={update.phase === 'checking' || update.phase === 'downloading'}
            onClick={() => void checkForAppUpdate({ quiet: false })}
          >
            {update.phase === 'checking' ? 'checking…' : 'check for updates'}
          </Button>
          {update.phase === 'current' ? <span className="hint">you&apos;re on the latest version.</span> : null}
          {update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready-to-restart' ? (
            <span className="hint">v{update.offer.version} is available — see the chip in the header.</span>
          ) : null}
        </div>
        {update.phase === 'check-failed' ? (
          <span className="hint" role="alert" data-testid="settings-check-failed">
            couldn&apos;t check for updates: {update.message}
          </span>
        ) : null}
        <label className="field-row" style={{ gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            data-testid="settings-auto-update-check"
            checked={autoCheck}
            onChange={(event) => {
              setAutoCheck(event.target.checked);
              setAutoCheckEnabled(event.target.checked);
            }}
          />
          <span className="hint">check for updates automatically at launch (asks github.com for the latest version)</span>
        </label>
      </div>
      <AboutLinks />
      <div className="field settings-row">
        {/* The installer's license screen, word for word, from the same constant the DMG
            embeds (legal/eula.ts) — on the page, offline, because the playground never
            imports from apps/desktop and a GitHub URL needs the network (review F2). */}
        <details className="about-eula" data-testid="about-eula">
          <summary>the license agreement you accepted at install</summary>
          <pre>{EULA_TEXT}</pre>
        </details>
      </div>
    </Card>
  );
}

/** Terms · privacy · threat model · license — the same four the footer carries. */
function AboutLinks(): ReactElement {
  return (
    <div className="field settings-row">
      <label>the fine print</label>
      <div className="about-links">
        <Link to={TERMS_PATH} data-testid="about-terms">
          terms
        </Link>
        <Link to={PRIVACY_PATH} data-testid="about-privacy">
          privacy
        </Link>
        <ExternalLink href={THREAT_MODEL_URL} data-testid="about-threat-model">
          threat model
        </ExternalLink>
        <ExternalLink href={LICENSE_URL} data-testid="about-license">
          MIT license
        </ExternalLink>
      </div>
      <span className="hint">
        disclosure, not a gate: nothing here asked you to agree to anything — the desktop installer is the one
        place that did.
      </span>
    </div>
  );
}

/**
 * The multi-provider BYOK rows (TASK-20260821 AC8/AC9): one row per keyed provider —
 * key field, saved-state chip, and (once keyed) that provider's default model — plus
 * the default-provider control. The demo brain is a first-class default choice, so a
 * keyless install still says what it is running on.
 */
function ByokProvidersRows(): ReactElement {
  const provider = useProvider();
  const choice = useProviderChoice();
  const keys = useByokKeyPresence();
  const providerModels = useProviderModels();
  const [drafts, setDrafts] = useState<Record<KeyedProvider, string>>({ anthropic: '', openai: '' });

  // Keys live in the user DB (async) — load both drafts once.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(KEYED_PROVIDERS.map((p) => getByokKey(p))).then(([anthropic, openai]) => {
      if (!cancelled) setDrafts({ anthropic: anthropic ?? '', openai: openai ?? '' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultChoices: Array<{ id: ByokProvider; label: string; disabled: boolean }> = [
    { id: 'anthropic', label: 'Anthropic', disabled: !keys.anthropic },
    { id: 'openai', label: 'OpenAI', disabled: !keys.openai },
    { id: 'mock', label: 'demo brain', disabled: false },
  ];

  return (
    <>
      {KEYED_PROVIDERS.map((p) => (
        <div className="field settings-row provider-row" key={p} data-testid={`provider-row-${p}`}>
          <div className="provider-row-head">
            <label htmlFor={`byok-key-${p}`}>{PROVIDER_LABELS[p]}</label>
            <span className={`chip provider-key-chip${keys[p] ? ' is-set' : ''}`} data-testid={`provider-key-state-${p}`}>
              {keys[p] ? 'key saved' : 'no key'}
            </span>
          </div>
          <input
            id={`byok-key-${p}`}
            type="password"
            autoComplete="off"
            value={drafts[p]}
            placeholder={p === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((current) => ({ ...current, [p]: value }));
              void setByokKey(p, value);
            }}
          />
          {keys[p] ? (
            <div className="provider-model-row">
              <label htmlFor={`provider-model-${p}`} className="provider-model-label">
                default model
              </label>
              <select
                id={`provider-model-${p}`}
                data-testid={`provider-model-${p}`}
                value={providerModels[p] ?? ''}
                onChange={(event) => setProviderModel(p, event.target.value === '' ? undefined : event.target.value)}
              >
                <option value="">provider default ({labelFor(p, ADAPTER_DEFAULTS[p])})</option>
                {popularModelsFor(p).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <span className="hint">
            stored in your snug file on this device, sent straight to {PROVIDER_LABELS[p]} from your browser — never
            to the hub, and stripped from hub sync and default exports.
          </span>
          {keys[p] ? (
            /* THE BYOK BAND (ADR-0055 §3, AC6): the custody hint above says where the KEY
               goes; this says what the PROVIDER receives, under whose terms, on whose bill.
               Keys on the saved-key STATE — honest every time it renders, gone when the
               key is cleared — never on a "first time" flag the store cannot keep. */
            <div className="hint" role="note" data-testid="byok-consent-band">
              with this key saved, your prompts, the app data an app shows the model, and the results of any
              connected-service calls go straight to {PROVIDER_LABELS[p]} — under their own terms, on your own bill.
              nothing routes through us.
            </div>
          ) : null}
        </div>
      ))}

      <div className="field settings-row">
        <label id="default-provider-label">default provider</label>
        <div className="seg" role="group" aria-labelledby="default-provider-label" data-testid="default-provider-seg">
          {defaultChoices.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={provider === option.id}
              disabled={option.disabled}
              onClick={() => setProvider(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="hint">
          {choice === undefined
            ? 'picked automatically — Anthropic wins whenever both keys are saved. every app follows this unless you pin a model on its own header.'
            : 'your pick. every app follows this unless you pin a model on its own header.'}
          {provider === 'mock' ? ' no key? the demo brain builds a tiny offline oracle so you can try the flow.' : ''}
        </span>
      </div>
    </>
  );
}

/**
 * THE LOCAL-ENDPOINT BAND (ADR-0055 §3, AC7; review F7) — the private-address doctrine
 * applied to the field where the misunderstanding costs most. "local model" promises
 * nothing leaves the machine; if the URL's host is not on this machine, that promise is
 * quietly false and the user is sending prompts, app data and connected-service results
 * to a third party they did not knowingly choose. Keys on the HOST (a lookalike name
 * raises, the default localhost stays quiet); NAMES the host so the user can judge;
 * renders nothing for a half-typed URL; never disables the field — self-hosted remote
 * endpoints are legitimate and growing.
 */
function LocalEndpointBand({ url }: { url: string }): ReactElement | null {
  const host = localEndpointHostOf(url);
  if (host === undefined || isLocalEndpointHost(host)) return null;
  return (
    <div className="hint" role="note" data-testid="local-endpoint-remote-band">
      <code>{host}</code> is not on this machine — with this endpoint, your prompts, app data and connected-service
      results leave this computer to it. fine if it&apos;s your own server; make sure you recognize the address.
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
    <div className="field settings-row" data-testid="webllm-experimental-card">
      <label>experimental — in-browser model</label>
      <span className="hint">
        {brain.kind === 'webllm'
          ? `the ?webllm=1 flag is on: builds and app turns run through ${brain.model} on WebGPU, inside this tab, ` +
            'overriding the choice above. the model downloads on first use (GBs, cached by the browser). ' +
            'the experiment stays on for this session even as you navigate — to leave it, reload the page ' +
            'without ?webllm=1 in the address bar.'
          : brain.kind === 'demo' && brain.reason === 'no-webgpu'
            ? `the ?webllm=1 flag is on, but ${WEBLLM_FALLBACK_BANNER}.`
            : 'the ?webllm=1 flag is on — checking whether this browser can run WebGPU…'}{' '}
        the weights download from huggingface.co, which sees your IP address and which model you fetched.
      </span>
    </div>
  );
}

/** Hub account (living-apps child 4): optional — logged-out is fully functional, local-only. */
export function AccountCard(): ReactElement | null {
  const auth = useAuth();
  const sync = useSyncStatus();
  if (auth.state === 'unknown') return null;
  return (
    <Card className="settings-group">
      <div className="field settings-row">
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

/**
 * Protection (children 3b/4): turning the passphrase on, changing it, turning it off.
 *
 * This is the door for everyone who is not on their first run — the person who said
 * "not now", and the person who now wants out. D3 promised both, and without them the
 * feature would be reachable exactly once in a file's life.
 */
function ProtectionCard(): ReactElement {
  const [setupOpen, setSetupOpen] = useState(false);
  const [protectedNow, setProtectedNow] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    void getUserDb().then((db) => setProtectedNow(db.getSetting(SETTING_PROTECTION_ENABLED) === true));
  }, [setupOpen]);

  const turnOff = (): void => {
    setBusy(true);
    setError(undefined);
    void disableProtection()
      .then(() => {
        markProtectionDisabled();
        setProtectedNow(false);
        setConfirmOff(false);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (setupOpen) {
    return <ProtectSetupFlow startAt={2} onDone={() => setSetupOpen(false)} />;
  }

  return (
    <Card className="settings-group">
      <div className="field settings-row">
        <label>protection</label>
        {protectedNow === true ? (
          <>
            <span className="hint">
              this file is protected. it opens only with your passphrase or Recovery Key — here, and anywhere you
              carry it.
            </span>
            <div className="field-row">
              {/* Re-running setup mints a NEW Recovery Key alongside the new
                  passphrase, so the screen that shows it is the same one, with the
                  same typed acknowledgement. Nothing about a change is quieter than
                  the original decision was. */}
              <Button onClick={() => setSetupOpen(true)}>change passphrase</Button>
              <Button onClick={() => setConfirmOff(true)}>turn protection off</Button>
            </div>
            {confirmOff ? (
              <div className="error-note" role="alert">
                turning protection off writes your file back as an ordinary database — anything that can read your
                disk can read it again. your apps and data are untouched.
                <div className="field-row" style={{ marginTop: 'var(--space-2)' }}>
                  <Button variant="primary" disabled={busy} onClick={turnOff}>
                    {busy ? 'removing…' : 'yes, turn it off'}
                  </Button>
                  <Button onClick={() => setConfirmOff(false)}>keep it on</Button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <span className="hint">
              your file is not protected. anything running on this computer can read it — your apps, their data, your
              chats and your keys. a passphrase scrambles it so only you can open it.
            </span>
            <div className="field-row">
              <Button variant="primary" onClick={() => setSetupOpen(true)}>
                protect my file
              </Button>
            </div>
          </>
        )}
        {error !== undefined ? (
          <p className="error-note" role="alert">
            {error}
          </p>
        ) : null}
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
    // ONE name on every platform (AC3). The old split — `.snug` on desktop, `.sqlite`
    // on web — meant the same artifact arrived under two names, and the web import
    // picker below did not even list `.snug`, so a file exported on desktop was greyed
    // out when its owner tried to import it in a browser.
    const filename = 'snug-user.snug';
    void exportUserFile(includeSecrets)
      .then((blob) => downloadBlob(blob, filename))
      .catch((err: unknown) => setDataError(err instanceof Error ? err.message : String(err)));
  };

  // BOTH importers SNIFF (TASK-20260904 AC15, owner Q4): a `.snug` is a user file OR an
  // app bundle, told apart by its first bytes. Hand the wrong kind to either button and
  // it says so and points at the other — a bundle can never reach `importUserFile`
  // (which replaces the whole file), a user file can never land on the shared shelf.
  const onImport = (file: File | undefined): void => {
    if (file === undefined) return;
    setDataError(undefined);
    void file
      .arrayBuffer()
      .then(async (buffer) => {
        const bytes = new Uint8Array(buffer);
        if (sniffSnugFile(bytes) === 'app-bundle') {
          await addSharedFromBytes(bytes);
          setDataError('that file is a shared app, not a whole snug file — it has been added to “shared with you” on your apps page');
          return;
        }
        await importUserFile({ arrayBuffer: () => Promise.resolve(buffer) });
      })
      .catch((err: unknown) => setDataError(err instanceof Error ? err.message : String(err)));
  };

  const onAddSharedApp = (file: File | undefined): void => {
    if (file === undefined) return;
    setDataError(undefined);
    void file
      .arrayBuffer()
      .then(async (buffer) => {
        const bytes = new Uint8Array(buffer);
        if (sniffSnugFile(bytes) === 'user-file') {
          setDataError('that is a whole snug file, not a shared app — use “import snug file” to replace your data with it');
          return;
        }
        await addSharedFromBytes(bytes);
      })
      .catch((err: unknown) => setDataError(err instanceof Error ? err.message : String(err)));
  };

  /** Parse + keep on the shelf (the picker IS the explicit act) + open the preview. Throws a readable reason. */
  const addSharedFromBytes = async (bytes: Uint8Array): Promise<void> => {
    const result = await receiveSharedBundle(new TextDecoder().decode(bytes), { source: 'settings', persist: true });
    if (!result.ok) {
      throw new Error(
        result.reason === 'shelf-full'
          ? (result.detail ?? 'your shared shelf is full')
          : result.reason === 'too-large'
            ? 'that shared app file is larger than Snug accepts'
            : result.reason === 'not-a-bundle' || result.reason === 'not-json'
              ? 'that file is not a shared Snug app'
              : `that shared app file is not valid: ${result.detail ?? 'unknown issue'}`,
      );
    }
    sharedOpenRequestStore.set(result.entry.bundleId);
  };

  return (
    <Card className="settings-group">
      {/* The sync-origin picker exists only where an origin can be reached (the host kit
          inside an artifact reaches none — TASK-20260905-host-kit P3, `sync` off). */}
      {allows('sync') ? (
      <div className="field settings-row">
        <label id="origin-label">your snug file</label>
        <span className="hint">
          one SQLite file holds your apps, their data, chats, and settings. it runs from this browser and can sync to
          an origin you choose — or nowhere.
        </span>
        <div className="seg" role="group" aria-labelledby="origin-label">
          {/* Amendment 13: the hub origin only exists where the platform can reach a
              hub (relative /userdb URLs mean nothing against tauri://) — and, since
              ADR-0052 §5, where the sign-in surface exists at all (hub sync
              authenticates by session; a flag-off build offering it is a dead 401). */}
          {(hubOriginAvailable()
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
          /* THE SYNC-ORIGIN BAND (ADR-0055 §3, AC8) — ADR-0014 §2's own words. Not
             softened: this is the one place "your keys" leave the device, by design. */
          <div className="hint" role="note" data-testid="sync-origin-secrets-band">
            your whole file — including every saved key and token — is copied to that Dropbox, and re-copied for as
            long as it stays selected. anyone with access to that Dropbox holds your keys; its security is yours.
          </div>
        ) : null}
        {sync.origin === 'hub' && hubOriginAvailable() ? (
          /* The hub twin (owner Q3 guard): only where the option exists at all — a
             WARNING about app data reaching the operator, never a reassurance. */
          <div className="hint" role="note" data-testid="sync-origin-hub-band">
            your apps&apos; data — records, chats, messages — is copied to this hub&apos;s operator; your keys are
            stripped first, and only the keys.
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
      ) : null}
      <div className="field settings-row field-gap">
        <label>portability</label>
        {dataError !== undefined ? (
          <div className="error-note" role="alert">
            {dataError}
          </div>
        ) : null}
        <div className="field-row field-row-wrap">
          <Button onClick={onExport}>export snug file</Button>
          {/* Offered only where a credential has a use (C1: `secretsUsable`) — the host kit
              inside an artifact can use none, so an export from it never carries one. */}
          {secretsUsable() ? (
            <label className="check-label">
              <input
                type="checkbox"
                checked={includeSecrets}
                onChange={(event) => setIncludeSecrets(event.target.checked)}
              />
              include secrets
            </label>
          ) : null}
          <label className="btn file-btn">
            import snug file
            <input
              type="file"
              accept=".snug,.sqlite,application/x-sqlite3,application/octet-stream"
              style={{ display: 'none' }}
              onChange={(event) => onImport(event.target.files?.[0])}
            />
          </label>
          {/* The THIRD button (owner Q4): a shared app someone sent as a `.snug` attachment
              joins "shared with you" — it never replaces this file (ADR-0063 §6). */}
          <label className="btn file-btn" data-testid="add-shared-app">
            add shared app
            <input
              type="file"
              accept=".snug,application/json"
              style={{ display: 'none' }}
              onChange={(event) => onAddSharedApp(event.target.files?.[0])}
            />
          </label>
        </div>
        <span className="hint">
          the export is the whole file — every app you built, its versions, its data and its chats. this file is the
          app: take it to another hub, a personal origin, or a local runner.{' '}
          {secretsUsable()
            ? 'secrets stay out unless you opt in; with "include secrets" checked, the exported file then carries every saved key and token. imported files ask you to re-confirm model endpoints before running. '
            : 'secrets never travel with it here — this host can use none, so an imported file’s keys and tokens are left behind too. '}
          a shared app (a `.snug` someone sent you from an app’s share button) is added to your apps page to try and
          install — it never replaces this file.
        </span>
      </div>
    </Card>
  );
}
