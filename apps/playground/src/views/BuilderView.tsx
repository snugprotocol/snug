import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';

import { buildUserMessage, parseBuildPrompt } from '../agent/chips.js';
import { useBuilderChat } from '../agent/useBuilderChat.js';
import { BuilderModelSelect } from '../run/BuilderModelSelect.js';
import { LlmInspectorPanel } from '../run/LlmInspectorPanel.js';
import { mintBuildThread, setActiveBuildThread, useActiveBuildThread } from '../state/buildThread.js';
import { useMode } from '../state/mode.js';
import { openConnectionWizard, openConnectionWizardForApp } from '../state/connectionWizard.js';
import { Button } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';
import { ChatLog } from './ChatLog.js';
import { DemoBrainCallout } from './DemoBrainCallout.js';
import { ThreadSidebar } from './ThreadSidebar.js';

export function BuilderView(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const prompt = useMemo(() => parseBuildPrompt(), []);
  // Which thread this page shows (ADR-0062): a per-tab store the sidebar and the hub's
  // create bar write to. The thread→app pin is durable (F10): returning to a thread
  // resumes the SAME app; "+ new" / "new app" mint a fresh thread — the explicit escape.
  const threadId = useActiveBuildThread();
  const mode = useMode();
  // The turn state — messages, progress, AND the round-trip inspector — lives on the
  // thread's session, not in this component, so leaving for "your apps" and coming back
  // (or switching threads) finds everything still running. The inspector stays in
  // memory only (AC14); it just lives on the thread now instead of dying with the view.
  const chat = useBuilderChat(threadId);
  const startNewApp = useCallback((): void => {
    mintBuildThread();
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

  // An idea handed over from the hub's create bar starts the build immediately. Safe
  // under StrictMode's simulated unmount now (next-steps 2026-08-06): the send lives in
  // the thread session, so the re-run finds `sentInitial` set and nothing aborted.
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
    <div className="builder-layout">
      <ThreadSidebar activeThreadId={threadId} onSelect={setActiveBuildThread} onNew={startNewApp} />
      <div className="builder">
        {/* ADR-0059: the one-time demo-brain note — inline, dismissible, never a gate.
            Renders only while the demo brain is active and the file has never
            dismissed it; the header chip carries the story permanently. */}
        <DemoBrainCallout />
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
            {/* An attached app means this turn EDITS something that already works; without
                one it is a first build. The status copy differs accordingly (AC10). */}
            <ChatLog
              messages={chat.messages}
              steps={chat.steps}
              activity={chat.activity}
              busy={chat.busy}
              phase={chat.attachedAppId !== undefined ? 'edit' : 'build'}
              onSelectCardOption={chat.selectCardOption}
              // The directive card's mount — only once an app exists to attach the
              // connection to (the wizard is keyed by appId + slot, and both come from
              // the persisted row rather than from anything the card carries).
              onDirectiveConnect={
                chat.attachedAppId !== undefined
                  ? () => void openConnectionWizardForApp(chat.attachedAppId!, 'directive')
                  : undefined
              }
              // The v4 card opens the wizard on the EXACT persisted (appId, slot) rather
              // than re-deriving "which connection did they mean" from the app id.
              onConnectionConnect={(connection) =>
                openConnectionWizard({ appId: connection.appId, slot: connection.slot, source: 'directive' })
              }
            />
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

        {/* The same selector every app header carries (TASK-20260821 AC12): bound to the
            attached app when the thread has one, a session pick transferred on install
            when it does not. Sits with the other build-scope controls, above the composer. */}
        <div className="builder-toolbar">
          <BuilderModelSelect attachedAppId={chat.attachedAppId} />
        </div>

        <details className="builder-llm" data-testid="builder-llm" open={chat.llmInspector.entries.length > 0}>
          <summary>
            watch it think
            {chat.llmInspector.entries.length > 0 ? ` · ${chat.llmInspector.entries.length}` : ''}
          </summary>
          <LlmInspectorPanel state={chat.llmInspector} mode={mode} />
        </details>

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
    </div>
  );
}
