import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';

import { buildUserMessage, parseBuildPrompt } from '../agent/chips.js';
import { useBuilderChat } from '../agent/useBuilderChat.js';
import { Button } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ChatLog } from './ChatLog.js';

/** Stable per-tab thread id so the server keeps conversation history. */
function threadIdForTab(): string {
  const KEY = 'snug:thread';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing !== null && existing !== '') return existing;
    const minted = `thr-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    sessionStorage.setItem(KEY, minted);
    return minted;
  } catch {
    return 'thr-ephemeral';
  }
}

export function BuilderView(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const prompt = useMemo(() => parseBuildPrompt(), []);
  // The thread→app pin is durable now (F10): returning to /build resumes the SAME
  // app. "new app" mints a fresh thread — the explicit escape hatch.
  const [threadId, setThreadId] = useState(threadIdForTab);
  const chat = useBuilderChat(threadId);
  const startNewApp = useCallback((): void => {
    const minted = `thr-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    try {
      sessionStorage.setItem('snug:thread', minted);
    } catch {
      /* per-tab continuity is best-effort */
    }
    setThreadId(minted);
    setDraft('');
  }, []);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const sentInitial = useRef(false);

  const submitIdea = useCallback(
    (idea: string): void => {
      const trimmed = idea.trim();
      if (trimmed === '') return;
      // The bubble shows the raw idea; the KB template only travels on the wire.
      chat.send(trimmed, buildUserMessage(trimmed, prompt));
      setDraft('');
    },
    [chat, prompt],
  );

  // An idea handed over from the hub's create bar starts the build immediately.
  useEffect(() => {
    const idea = searchParams.get('idea');
    if (idea !== null && idea !== '' && !sentInitial.current) {
      sentInitial.current = true;
      setSearchParams({}, { replace: true });
      submitIdea(idea);
    }
  }, [searchParams, setSearchParams, submitIdea]);

  // `/` focuses the composer from anywhere in the view.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitIdea(draft);
    }
  };

  const autogrow = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };

  return (
    <div className="builder">
      {chat.messages.length === 0 ? (
        <EmptyState
          glyph="✦"
          title="build something"
          lesson="describe the little app you want — the agent writes it and hands you a run button."
        />
      ) : (
        <>
          {chat.attachedAppId !== undefined && !chat.busy ? (
            <div className="builder-resume" role="note">
              <span>this thread keeps building the same app — its context travels with it.</span>
              <Button variant="ghost" onClick={startNewApp} title="start a fresh thread for a brand-new app">
                new app
              </Button>
            </div>
          ) : null}
          <ChatLog messages={chat.messages} steps={chat.steps} activity={chat.activity} />
        </>
      )}

      {draft === '' && !chat.busy ? (
        <div className="chip-row" aria-label="suggestions">
          {prompt.chips.map((chip) => (
            <Chip key={chip} onClick={() => submitIdea(chip)}>
              {chip}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="composer">
        <textarea
          ref={composerRef}
          value={draft}
          rows={1}
          placeholder="describe your app… (enter to build, / to focus)"
          aria-label="describe your app"
          onChange={(event) => {
            setDraft(event.target.value);
            autogrow(event.target);
          }}
          onKeyDown={onComposerKeyDown}
        />
        {chat.busy ? (
          <Button variant="danger" onClick={chat.stop}>
            stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => submitIdea(draft)} disabled={draft.trim() === ''}>
            build
          </Button>
        )}
      </div>
    </div>
  );
}
