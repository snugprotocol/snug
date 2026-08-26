// BrainChip — the always-on "what's thinking" status surface (TASK-20260826,
// ADR-0059 rules 1/2/4).
//
// A status chip, never a nag: it renders on every route, in every brain state, and
// stays useful after the user switches — its job is to keep being true. The label
// derives from the ONE live routing derivation (state/activeBrain.ts), so the
// keyed-provider-with-no-key fall-through reads "demo brain" here the moment it
// would route there. Clicking opens a small popover (the IdentityChip open/close/
// focus contract) with one honest sentence for the current brain and the switch
// affordances — "use ollama now" appears ONLY when the probe found models (the
// DesktopWelcome rule: never offer a button that cannot work).
//
// COPY IS A CONTRACT (ADR-0059 rule 4, byte-pinned in brainChip.test.tsx): the
// demo body names the mechanism; the BYOK invitation claims exactly what the code
// vouches for — the key lives in the user's file on this device and is sent only
// to the chosen provider, never to Snug's servers. It deliberately does NOT say
// "never leaves your device": the key travels to the provider, and a critical
// reader who catches an overclaim stops believing the honest claims too.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { setMode } from '../state/mode.js';
import { useActiveBrain, type ActiveBrainKind } from '../state/activeBrain.js';
import { useOllama } from '../state/ollama.js';

export const DEMO_BRAIN_BODY =
  'a tiny script inside this page fakes the AI so you can try the flow — no AI model or service is called.';

export const BYOK_HONESTY_COPY =
  'your key is saved in your Snug file on this device and sent only to the AI provider you choose — never to Snug’s servers.';

/** Chip label + popover copy per brain. The chip text is an API (tests, AT, docs). */
const BRAINS: Record<ActiveBrainKind, { label: string; aria: string; headline: string; body: string }> = {
  demo: {
    label: 'demo brain',
    aria: 'what’s thinking: demo brain — scripted, no AI service',
    headline: 'demo brain — scripted',
    body: DEMO_BRAIN_BODY,
  },
  anthropic: {
    label: 'claude',
    aria: 'what’s thinking: claude, with your key',
    headline: 'claude · your key',
    body: 'turns go browser-direct to Anthropic with your key.',
  },
  openai: {
    label: 'openai',
    aria: 'what’s thinking: openai, with your key',
    headline: 'openai · your key',
    body: 'turns go browser-direct to OpenAI with your key.',
  },
  local: {
    label: 'local',
    aria: 'what’s thinking: a local model on this computer',
    headline: 'local model',
    body: 'turns run against your local endpoint on this computer.',
  },
  webllm: {
    label: 'in-browser',
    aria: 'what’s thinking: an in-browser model on WebGPU',
    headline: 'in-browser model',
    body: 'the model thinks inside this tab on WebGPU.',
  },
  subscription: {
    label: 'hub',
    aria: 'what’s thinking: the Snug hub',
    headline: 'snug hub',
    body: 'turns run through the Snug hub server you signed into.',
  },
};

export function BrainChip(): ReactElement {
  const brain = useActiveBrain();
  const ollama = useOllama();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // The IdentityChip dismissal contract: Escape and any outside pointer close, both
  // returning focus to the trigger so keyboard users are never dropped.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (
        target !== null &&
        (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true)
      ) {
        return;
      }
      close(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  const copy = BRAINS[brain];
  const models = ollama !== 'unknown' && ollama.running ? ollama.models : [];

  return (
    <div className="identity-menu-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="brain-chip"
        data-testid="brain-chip"
        data-brain={brain}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={copy.aria}
        title={copy.aria}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="brain-dot" aria-hidden="true" />
        <span className="brain-chip-label">{copy.label}</span>
      </button>
      {open ? (
        <div className="identity-menu brain-menu" data-testid="brain-menu" ref={menuRef} aria-label="what’s thinking">
          <span className="identity-menu-label">{copy.headline}</span>
          <span className="brain-menu-body">{copy.body}</span>
          <Link
            to="/settings"
            className="identity-menu-item"
            data-testid="brain-menu-settings"
            onClick={() => close(false)}
          >
            {brain === 'demo' ? 'use your own AI key' : 'change in settings'}
          </Link>
          {brain === 'demo' && models.length > 0 ? (
            <button
              type="button"
              className="identity-menu-item"
              data-testid="brain-menu-ollama"
              onClick={() => {
                setMode('local');
                close(false);
              }}
            >
              use ollama now — {models.length} {models.length === 1 ? 'model' : 'models'} found
            </button>
          ) : null}
          {brain === 'demo' ? <span className="brain-menu-hint">{BYOK_HONESTY_COPY}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
