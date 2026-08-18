// ModelSelect.tsx — the per-app model picker in the run header (TASK-20260817).
//
// Sits in the app's OWN header beside 🔌 connections and export .sqlite, which is where
// the owner asked for it and where the connections door already lives: the controls that
// act on THIS app belong on this app's chrome, while Settings keeps the cross-app view.
//
// Three rules shape everything below.
//
// 1. INHERITING IS A VISIBLE STATE, not a blank. The first option is always the Settings
//    default, labelled as inherited, and it is what an un-picked app shows. That is what
//    makes the control honest about which apps follow the global default (and it is the
//    only way back after pinning).
//
// 2. IT RENDERS NOTHING WHERE A CHOICE WOULD BE A LIE. Under the webllm/demo brain the
//    configured mode is overridden entirely and the engine loads its own pinned model
//    (ADR-0015); `mock` is the demo brain and names no model at all. Offering a picker in
//    those states would imply routing that cannot happen.
//
// 3. IT NEVER HIDES WHAT THE APP IS ACTUALLY RUNNING. A stored model absent from the
//    current catalog is still listed and still selected — otherwise the browser would
//    coerce the <select> to its first option and the screen would claim the app was on
//    the default while its turns still went elsewhere.

import type { ReactElement } from 'react';

import { popularModelsFor } from '@snugprotocol/adapters';

import { resolveModelForApp, setAppModel, useAppModel } from '../state/appModel.js';
import { useMode, useModel, useProvider } from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { useBrain } from '../state/webllm.js';

export interface ModelSelectProps {
  /** The library id of the app whose header this is. */
  appId: string;
}

/** Sentinel for "use my default" — empty string, so it can never collide with a model id. */
const INHERIT_CHOICE = '';

export function ModelSelect({ appId }: ModelSelectProps): ReactElement | null {
  const brain = useBrain();
  const mode = useMode();
  const provider = useProvider();
  const globalModel = useModel();
  const ollama = useOllama();
  const pinned = useAppModel(appId);

  // Rule 2. `brain.kind === 'settings'` is the only state where the configured
  // mode/provider actually decide the model (webllm and demo both override it).
  if (brain.kind !== 'settings') return null;
  if (mode === 'byok' && provider === 'mock') return null;

  // Local mode lists what the Ollama probe found — a local endpoint cannot serve a
  // frontier model, so offering one would produce a provider-side failure with nothing
  // on screen explaining it. Subscription and byok share the frontier catalog: the hub
  // server runs the same anthropic/openai adapters and already accepts a per-request
  // model override.
  const isLocal = mode === 'local';
  const detected = ollama !== 'unknown' && ollama.running ? ollama.models : [];
  const options = isLocal
    ? detected.map((id) => ({ id, label: id }))
    : popularModelsFor(provider).map((m) => ({ id: m.id, label: m.label }));

  // Rule 3: keep a stored id visible even when it is not in the list above.
  const known = options.some((o) => o.id === pinned);
  const shown = pinned !== undefined && !known ? [...options, { id: pinned, label: `${pinned} (not listed)` }] : options;

  // What the app WOULD use if nothing were pinned — shown on the inherit option so the
  // user can see what they are inheriting rather than just that they are inheriting.
  const inherited = globalModel ?? resolveModelForApp(undefined);
  const inheritLabel = inherited === undefined ? 'default (provider’s choice)' : `default (${inherited})`;

  // Local-mode honesty (the Settings precedent): running-but-empty is its OWN state —
  // the install succeeded, only a model is missing. An empty dropdown with no words is
  // exactly the ambiguity that reads as a bug.
  if (isLocal && shown.length === 0) {
    return (
      <span className="hint" data-testid="app-model-empty">
        no local models — try <code>ollama pull llama3.2</code>
      </span>
    );
  }

  return (
    <label className="app-model-select">
      <span className="visually-hidden">model for this app</span>
      <select
        data-testid="app-model-select"
        value={pinned ?? INHERIT_CHOICE}
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
