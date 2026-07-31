// useBuilderChat.ts — the chat state machine shared by the Builder view and the Run
// view's chat rail. Wraps a BuilderAgent (server SSE or byok in-browser) and exposes
// plain message state; the artifact event is what turns a reply into a "run it" card.

import { useCallback, useMemo, useRef, useState } from 'react';

import { byokLibrary } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { createByokBuilder, createServerBuilder, type ArtifactEvent, type BuilderAgent } from './builder.js';

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  text: string;
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
  send: (message: string) => void;
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
    (text: string): void => {
      if (busy || text.trim() === '') return;
      const userId = ++messageSeq;
      const agentId = ++messageSeq;
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', text },
        { id: agentId, role: 'agent', text: '', streaming: true },
      ]);
      setBusy(true);
      setActivity(mode === 'server' ? 'it’s thinking…' : 'warming up…');
      const controller = new AbortController();
      abortRef.current = controller;
      void agent
        .send(
          text,
          {
            onDelta: (delta) => {
              setActivity(undefined);
              patchMessage(agentId, (m) => ({ text: m.text + delta }));
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
            patchMessage(agentId, { streaming: false, text: result.text });
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

  return { messages, busy, activity, lastArtifact, send, stop };
}
