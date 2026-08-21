// BuilderModelSelect.tsx — the build page's model selector (TASK-20260821 AC12).
//
// The owner's ask: the same control the app run header has, on the build page. Two
// states, one component:
//
//   THREAD ATTACHED TO AN APP — this IS the app's selector: the ordinary `ModelSelect`
//   over the attached app id, so a pick here and a pick on the run header are one row.
//
//   FRESH THREAD (no app yet) — a session-scoped pending pick (`state/builderModel.ts`)
//   that routes the build turns and becomes the new app's pin on install. Rendered for
//   byok only: local mode's fresh threads follow the global default (an Ollama pick is
//   already a Settings concern), subscription's provider lives hub-side, and the
//   webllm/demo brains override the mode entirely (rule 2 of ModelSelect).

import type { ReactElement } from 'react';

import { popularModelsFor } from '@snugprotocol/adapters';

import { setBuilderPick, useBuilderPick } from '../state/builderModel.js';
import {
  KEYED_PROVIDERS,
  useByokKeyPresence,
  useMode,
  useProvider,
  useProviderModels,
  type ByokProvider,
  type KeyedProvider,
} from '../state/mode.js';
import { useBrain } from '../state/webllm.js';
import { ADAPTER_DEFAULTS, labelFor, ModelSelect, PROVIDER_LABELS } from './ModelSelect.js';

const INHERIT_CHOICE = '';

export interface BuilderModelSelectProps {
  /** The app this build thread is attached to, when one exists. */
  attachedAppId?: string;
}

export function BuilderModelSelect({ attachedAppId }: BuilderModelSelectProps): ReactElement | null {
  const brain = useBrain();
  const mode = useMode();
  const provider = useProvider();
  const keys = useByokKeyPresence();
  const providerModels = useProviderModels();
  const pick = useBuilderPick();

  if (attachedAppId !== undefined) return <ModelSelect appId={attachedAppId} />;

  if (brain.kind !== 'settings') return null;
  if (mode !== 'byok' || provider === 'mock') return null;

  const defaultProvider: KeyedProvider = provider === 'openai' ? 'openai' : 'anthropic';
  const groups = KEYED_PROVIDERS.filter((p) => keys[p]).map((p) => ({
    provider: p,
    options: popularModelsFor(p).map((m) => ({ id: m.id, label: m.label })),
  }));
  if (groups.length === 0) return null;

  const inheritedModel = providerModels[defaultProvider] ?? ADAPTER_DEFAULTS[defaultProvider];
  const inheritLabel = `default (${PROVIDER_LABELS[defaultProvider]} · ${labelFor(defaultProvider, inheritedModel)})`;

  return (
    <label className="app-model-select">
      <span className="visually-hidden">model for this build</span>
      <select
        data-testid="builder-model-select"
        value={pick === undefined ? INHERIT_CHOICE : `${pick.provider}:${pick.model}`}
        title="which model builds this app — it becomes the app’s model when it installs"
        onChange={(event) => {
          const value = event.target.value;
          if (value === INHERIT_CHOICE) {
            setBuilderPick(undefined);
            return;
          }
          const split = value.indexOf(':');
          setBuilderPick({ provider: value.slice(0, split) as ByokProvider, model: value.slice(split + 1) });
        }}
      >
        <option value={INHERIT_CHOICE}>{inheritLabel}</option>
        {groups.map((group) => (
          <optgroup key={group.provider} label={PROVIDER_LABELS[group.provider]}>
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
