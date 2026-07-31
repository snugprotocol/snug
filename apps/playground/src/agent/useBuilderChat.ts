// useBuilderChat.ts — the chat state machine shared by the Builder view and the Run
// view's chat rail. Wraps a BuilderAgent (server SSE or byok in-browser) and exposes
// plain message state; the artifact event is what turns a reply into a "run it" card.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { byokLibrary } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { createByokBuilder, createServerBuilder, type ArtifactEvent, type BuilderAgent } from './builder.js';

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  /** What the UI renders: the raw user idea, or the agent's (streamed) reply. */
  displayText: string;
  /** User messages only: what actually went to the transport (e.g. the KB-templated idea). */
  wireText?: string;
  streaming?: boolean;
  error?: { code: string; message: string; retryable: boolean };
  artifact?: ArtifactEvent;
}

export interface BuilderChat {
  messages: ChatMessage[];
  busy: boolean;
  /** Reasoning-pill label while the agent works ("consulting the knowledge base…"). */
  activity: string | undefined;
  lastArtifact: ArtifactEvent | undefined;
  /**
   * `displayText` is what the user's bubble shows; `wireText` (defaults to
   * `displayText`) is what the transport actually sends — internal prompt templates
   * belong in `wireText`, never on screen.
   */
  send: (displayText: string, wireText?: string) => void;
  stop: () => void;
}

let messageSeq = 0;

export function useBuilderChat(threadId: string): BuilderChat {
  const mode = useMode();
  const provider = useProvider();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const [lastArtifact, setLastArtifact] = useState<ArtifactEvent | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const agent: BuilderAgent = useMemo(
    () => (mode === 'server' ? createServerBuilder(threadId) : createByokBuilder({ provider, library: byokLibrary() })),
    [mode, provider, threadId],
  );

  const patchMessage = useCallback((id: number, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)): void => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message,
      ),
    );
  }, []);

  const send = useCallback(
    (displayText: string, wireText?: string): void => {
      const wire = wireText ?? displayText;
      if (busy || displayText.trim() === '' || wire.trim() === '') return;
      const userId = ++messageSeq;
      const agentId = ++messageSeq;
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', displayText, wireText: wire },
        { id: agentId, role: 'agent', displayText: '', streaming: true },
      ]);
      setBusy(true);
      setActivity(mode === 'server' ? 'it’s thinking…' : 'warming up…');
      const controller = new AbortController();
      abortRef.current = controller;
      void agent
        .send(
          wire,
          {
            onDelta: (delta) => {
              setActivity(undefined);
              patchMessage(agentId, (m) => ({ displayText: m.displayText + delta }));
            },
            onArtifact: (artifact) => {
              setLastArtifact(artifact);
              patchMessage(agentId, { artifact });
            },
            onActivity: (label) => setActivity(label),
          },
          controller.signal,
        )
        .then((result) => {
          if (result.ok) {
            // A done event with empty/missing text must not wipe the streamed deltas.
            patchMessage(agentId, (m) => ({
              streaming: false,
              displayText: result.text !== '' ? result.text : m.displayText,
            }));
          } else {
            patchMessage(agentId, { streaming: false, error: { code: result.code, message: result.message, retryable: result.retryable } });
          }
        })
        .finally(() => {
          setBusy(false);
          setActivity(undefined);
          abortRef.current = null;
        });
    },
    [agent, busy, mode, patchMessage],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Leaving the view aborts any in-flight turn — never leave a request running headless.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, busy, activity, lastArtifact, send, stop };
}
