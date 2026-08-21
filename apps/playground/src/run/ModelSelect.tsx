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
// either catalog); local and subscription keep bare model ids — local has no provider
// concept, and subscription's provider lives hub-side, so neither writes a provider row.

import type { ReactElement } from 'react';

import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, popularModelsFor } from '@snugprotocol/adapters';

import { setAppModel, setAppPin, useAppModel, useAppProvider } from '../state/appModel.js';
import {
  KEYED_PROVIDERS,
  useByokKeyPresence,
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
  const pinnedModel = useAppModel(appId);
  const pinnedProvider = useAppProvider(appId);
  const keys = useByokKeyPresence();
  const providerModels = useProviderModels();

  // Rule 2. `brain.kind === 'settings'` is the only state where the configured
  // mode/provider actually decide the model (webllm and demo both override it).
  if (brain.kind !== 'settings') return null;
  if (mode === 'byok' && provider === 'mock') return null;

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
        <span className="hint" data-testid="app-model-empty">
          no local models — try <code>ollama pull llama3.2</code>
        </span>
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
    </label>
  );
}
