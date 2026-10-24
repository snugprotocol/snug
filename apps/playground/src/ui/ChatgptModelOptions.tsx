// ChatgptModelOptions — the `<option>`s of every model `<select>` on the ChatGPT plan, rendered ONCE
// (TASK-20261023-siwc-chatgpt-plan D6, AC8; Gate 5 ST2). Settings' default-model select, the brain
// chip's popover, the run header's per-app selector and the build page's selector all list the same
// thing — the ACCOUNT's models in the server's order by display name (never a catalogue of ours), the
// inherit option first with the ONE default label, and a chosen id the plan no longer lists kept
// visible and selected as "<id> (not on your plan)" (Rule 3: never silently "default") — and used to
// build it four times with three drifting default labels. The view comes from `chatgptModelView`; the
// `value` is the select's own, so the unlisted option appears only for the id that is actually selected.

import type { ReactElement } from 'react';

import { chatgptDefaultLabel, type ChatgptModelView } from '../state/chatgptPlan.js';

/** The inherit option's value — empty, so it can never collide with a model id. */
export const CHATGPT_DEFAULT_CHOICE = '';

export interface ChatgptModelOptionsProps {
  view: ChatgptModelView;
  /** The select's current value: a model id, or `CHATGPT_DEFAULT_CHOICE` when inheriting. */
  value: string;
}

export function ChatgptModelOptions({ view, value }: ChatgptModelOptionsProps): ReactElement {
  const unlisted = value !== CHATGPT_DEFAULT_CHOICE && !view.models.some((model) => model.id === value) ? value : undefined;
  return (
    <>
      <option value={CHATGPT_DEFAULT_CHOICE}>{chatgptDefaultLabel(view)}</option>
      {view.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
      {unlisted !== undefined ? <option value={unlisted}>{unlisted} (not on your plan)</option> : null}
    </>
  );
}
