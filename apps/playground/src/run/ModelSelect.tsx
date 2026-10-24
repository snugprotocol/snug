// ModelSelect.tsx — the per-app model picker in the run header (TASK-20260817), grown
// multi-provider for TASK-20260821: with keys for both Anthropic and OpenAI saved, the
// selector lists BOTH catalogs in provider-labelled groups, and picking a model
// implicitly picks its provider for this app (owner decision 2026-08-21).
//
// Three rules shape everything below (unchanged from the original):
//
// 1. INHERITING IS A VISIBLE STATE, not a blank. The first option is always the resolved
//    default — provider AND model — labelled as inherited, and it is what an un-picked
//    app shows. It is also the only way back after pinning.
//
// 2. IT RENDERS NOTHING WHERE A CHOICE WOULD BE A LIE. Under the webllm/demo brain the
//    configured mode is overridden entirely (ADR-0015); `mock` is the demo brain and
//    names no model at all.
//
// 3. IT NEVER HIDES WHAT THE APP IS ACTUALLY RUNNING. A stored model absent from the
//    catalog is still listed and selected; a pinned provider whose KEY is gone renders
//    with a "key missing" mark instead of being silently re-routed — the pin is honored
//    by routing, so the screen must say so (appModel.ts states the honesty rationale).
//
// VALUE ENCODING: byok options carry `provider:model` (model ids contain no colon in
// either catalog); local, subscription and the ChatGPT plan keep bare model ids — local has
// no provider concept, subscription's provider lives hub-side, and the plan has one provider,
// written as the pin's family (`provider: 'chatgpt'`).
//
// A PIN HAS A FAMILY (TASK-20261023-siwc-chatgpt-plan, ADR-0078 §6): a pin routes only in a mode
// of the family that made it (appModel.ts states the rule once). A pin from another family is
// ignored for routing and SAID here — "pinned for <mode> — not used here" — while the select
// shows what actually routes, the inherited default, and never offers the foreign pin as if it
// applied (Rule 3 kept honest in the other direction).

import type { ReactElement } from 'react';

import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, popularModelsFor } from '@snugprotocol/adapters';

import { appPinFamily, pinFamilyApplies, setAppModel, setAppPin, useAppModel, useAppProvider } from '../state/appModel.js';
import { chatgptModelView, useChatgptPlan } from '../state/chatgptPlan.js';
import { CHATGPT_DEFAULT_CHOICE, ChatgptModelOptions } from '../ui/ChatgptModelOptions.js';
import {
  KEYED_PROVIDERS,
  MODE_LABELS,
  useByokKeyPresence,
  useChatgptModel,
  useMode,
  useModel,
  useProvider,
  useProviderModels,
  type ByokProvider,
  type KeyedProvider,
} from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { useBrain } from '../state/webllm.js';

export interface ModelSelectProps {
  /** The library id of the app whose header this is. */
  appId: string;
}

/** Sentinel for "use my default" — empty string, so it can never collide with a value. */
const INHERIT_CHOICE = '';

export const PROVIDER_LABELS: Record<KeyedProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };
export const ADAPTER_DEFAULTS: Record<KeyedProvider, string> = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
};

const isKeyed = (value: string | undefined): value is KeyedProvider =>
  value === 'anthropic' || value === 'openai';

/** The catalog's human label for an id, or the id itself for anything unlisted. */
export function labelFor(provider: KeyedProvider, id: string): string {
  return popularModelsFor(provider).find((m) => m.id === id)?.label ?? id;
}

export function ModelSelect({ appId }: ModelSelectProps): ReactElement | null {
  const brain = useBrain();
  const mode = useMode();
  const provider = useProvider();
  const globalModel = useModel();
  const ollama = useOllama();
  const storedModel = useAppModel(appId);
  const pinnedProvider = useAppProvider(appId);
  const keys = useByokKeyPresence();
  const providerModels = useProviderModels();
  const plan = useChatgptPlan();
  const planDefault = useChatgptModel();

  // Rule 2. `brain.kind === 'settings'` is the only state where the configured
  // mode/provider actually decide the model (webllm and demo both override it).
  if (brain.kind !== 'settings') return null;
  if (mode === 'byok' && provider === 'mock') return null;

  // The pin's family against the mode (ADR-0078 §6; the stores this reads are the ones subscribed
  // above). A foreign pin is not THIS mode's pin: the arms below see no pin and say why.
  const family = appPinFamily(appId);
  const foreign = family !== undefined && !pinFamilyApplies(family, mode) ? family : undefined;
  const pinnedModel = foreign === undefined ? storedModel : undefined;
  // The UNSCOPED family (a pin with no provider row — a legacy BYOK pin, or a local one) belongs to no
  // one mode, so it is not called "local" here (G5-C10): the note names it neutrally.
  const foreignNote =
    foreign !== undefined ? (
      <span className="hint app-model-pin-note" data-testid="app-model-pin-note">
        {foreign === 'local' ? 'pinned for another mode — not used here' : `pinned for ${MODE_LABELS[foreign]} — not used here`}
      </span>
    ) : null;

  // ---- CHATGPT PLAN: the ACCOUNT's models, server order, display names (D6) — the one option list (ST2). ----
  if (mode === 'chatgpt') {
    const view = chatgptModelView(plan, planDefault, pinnedModel);
    return (
      <label className="app-model-select">
        <span className="visually-hidden">model for this app</span>
        <select
          data-testid="app-model-select"
          value={pinnedModel ?? CHATGPT_DEFAULT_CHOICE}
          title="which model this app thinks with on your ChatGPT plan — remembered for this app"
          onChange={(event) => {
            const value = event.target.value;
            setAppPin(appId, value === CHATGPT_DEFAULT_CHOICE ? undefined : { provider: 'chatgpt', model: value });
          }}
        >
          <ChatgptModelOptions view={view} value={pinnedModel ?? CHATGPT_DEFAULT_CHOICE} />
        </select>
        {foreignNote}
      </label>
    );
  }

  // ---- LOCAL: the Ollama list, bare values, model row only (unchanged behavior). ----
  if (mode === 'local') {
    const detected = ollama !== 'unknown' && ollama.running ? ollama.models : [];
    const known = detected.some((id) => id === pinnedModel);
    const shown =
      pinnedModel !== undefined && !known
        ? [...detected.map((id) => ({ id, label: id })), { id: pinnedModel, label: `${pinnedModel} (not listed)` }]
        : detected.map((id) => ({ id, label: id }));
    if (shown.length === 0) {
      return (
        <>
          <span className="hint" data-testid="app-model-empty">
            no local models — try <code>ollama pull llama3.2</code>
          </span>
          {foreignNote}
        </>
      );
    }
    const inheritLabel = globalModel === undefined ? 'default (endpoint’s choice)' : `default (${globalModel})`;
    return (
      <label className="app-model-select">
        <span className="visually-hidden">model for this app</span>
        <select
          data-testid="app-model-select"
          value={pinnedModel ?? INHERIT_CHOICE}
          title="which model this app’s LLM calls use — remembered for this app"
          onChange={(event) => {
            const value = event.target.value;
            setAppModel(appId, value === INHERIT_CHOICE ? undefined : value);
          }}
        >
          <option value={INHERIT_CHOICE}>{inheritLabel}</option>
          {shown.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {foreignNote}
      </label>
    );
  }

  // ---- SUBSCRIPTION: single list for the active provider, bare values (unchanged) —
  //      the hub owns the provider, so a per-app provider row would claim a routing the
  //      /invoke body cannot express. ----
  if (mode === 'subscription') {
    const options = popularModelsFor(provider).map((m) => ({ id: m.id, label: m.label }));
    const known = options.some((o) => o.id === pinnedModel);
    const shown =
      pinnedModel !== undefined && !known ? [...options, { id: pinnedModel, label: `${pinnedModel} (not listed)` }] : options;
    const inherited = globalModel;
    const inheritLabel = inherited === undefined ? 'default (provider’s choice)' : `default (${inherited})`;
    return (
      <label className="app-model-select">
        <span className="visually-hidden">model for this app</span>
        <select
          data-testid="app-model-select"
          value={pinnedModel ?? INHERIT_CHOICE}
          title="which model this app’s LLM calls use — remembered for this app"
          onChange={(event) => {
            const value = event.target.value;
            setAppModel(appId, value === INHERIT_CHOICE ? undefined : value);
          }}
        >
          <option value={INHERIT_CHOICE}>{inheritLabel}</option>
          {shown.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {foreignNote}
      </label>
    );
  }

  // ---- BYOK: provider-labelled groups over every KEYED provider (AC13). ----
  // `provider` is the resolved default and is anthropic|openai here (mock returned null).
  const defaultProvider: KeyedProvider = isKeyed(provider) ? provider : 'anthropic';
  // The provider a legacy model-only pin (ADR-0036 era, no provider row) displays under:
  // the resolved default — which is exactly where its sends route.
  const pinProvider: KeyedProvider | undefined =
    pinnedModel === undefined ? undefined : isKeyed(pinnedProvider) ? pinnedProvider : defaultProvider;

  const groups = KEYED_PROVIDERS.filter((p) => keys[p] || p === pinProvider).map((p) => {
    const options = popularModelsFor(p).map((m) => ({ id: m.id, label: m.label }));
    // Rule 3: a stored id outside the catalog still shows, inside its own provider group.
    if (p === pinProvider && pinnedModel !== undefined && !options.some((o) => o.id === pinnedModel)) {
      options.push({ id: pinnedModel, label: `${pinnedModel} (not listed)` });
    }
    return { provider: p, missingKey: !keys[p], options };
  });

  const inheritedModel = providerModels[defaultProvider] ?? ADAPTER_DEFAULTS[defaultProvider];
  const inheritLabel = `default (${PROVIDER_LABELS[defaultProvider]} · ${labelFor(defaultProvider, inheritedModel)})`;

  return (
    <label className="app-model-select">
      <span className="visually-hidden">model for this app</span>
      <select
        data-testid="app-model-select"
        value={pinProvider === undefined || pinnedModel === undefined ? INHERIT_CHOICE : `${pinProvider}:${pinnedModel}`}
        title="which model this app’s LLM calls use — remembered for this app"
        onChange={(event) => {
          const value = event.target.value;
          if (value === INHERIT_CHOICE) {
            setAppPin(appId, undefined);
            return;
          }
          const split = value.indexOf(':');
          const pickProvider = value.slice(0, split) as ByokProvider;
          setAppPin(appId, { provider: pickProvider, model: value.slice(split + 1) });
        }}
      >
        <option value={INHERIT_CHOICE}>{inheritLabel}</option>
        {groups.map((group) => (
          <optgroup
            key={group.provider}
            label={group.missingKey ? `${PROVIDER_LABELS[group.provider]} (key missing)` : PROVIDER_LABELS[group.provider]}
          >
            {group.options.map((option) => (
              <option key={option.id} value={`${group.provider}:${option.id}`}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {foreignNote}
    </label>
  );
}
