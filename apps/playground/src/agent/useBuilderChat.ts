// useBuilderChat.ts — the chat state machine shared by the Builder view and the Run
// view's chat rail. Wraps a BuilderAgent (subscription SSE or direct in-browser) and
// exposes plain message state; the artifact event is what turns a reply into a
// "run it" card.
//
// Portable-hub evolution (child 3): the thread persists in the USER DB (AC9 — a fresh
// session re-renders the full history), every artifact_write flows through an
// ArtifactSink pinned host-side (F9), and in subscription mode the client fetches the
// artifact HTML from the hub cache and writes it into the user DB itself (F4 —
// client-authoritative; the hub store is transient).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createServerArtifactFetch } from '../state/library.js';
import { useLocalUrl, useMode, useModel, useProvider } from '../state/mode.js';
import { getUserDb } from '../state/userdb.js';
import { createAppTargetSink } from './artifactSink.js';
import { createDirectBuilder, createServerBuilder, type ArtifactEvent, type BuilderAgent } from './builder.js';

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

export interface UseBuilderChatOptions {
  /** Per-app chat: every artifact_write versions THIS app (F9 pinning). */
  pinnedAppId?: string;
}

let messageSeq = 0;

export function useBuilderChat(threadId: string, options: UseBuilderChatOptions = {}): BuilderChat {
  const { pinnedAppId } = options;
  const mode = useMode();
  const provider = useProvider();
  const model = useModel();
  const localUrl = useLocalUrl();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const [lastArtifact, setLastArtifact] = useState<ArtifactEvent | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const streamAccumRef = useRef('');

  const sink = useMemo(
    () => createAppTargetSink(pinnedAppId !== undefined ? { pinnedAppId } : {}),
    [pinnedAppId, threadId],
  );
  const hubArtifacts = useMemo(() => createServerArtifactFetch(), []);

  const agent: BuilderAgent = useMemo(
    () =>
      mode === 'subscription'
        ? createServerBuilder(threadId, undefined, model)
        : createDirectBuilder({
            mode,
            provider,
            sink,
            ...(model !== undefined ? { model } : {}),
            localUrl,
          }),
    [mode, provider, model, localUrl, threadId, sink],
  );

  // AC9: a fresh session over the same user DB re-renders the persisted thread.
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const persisted = db.listChatMessages(threadId);
      if (persisted.length === 0) return;
      setMessages((current) =>
        current.length > 0
          ? current
          : persisted
              .filter((m) => m.role !== 'system')
              .map((m) => ({
                id: ++messageSeq,
                role: m.role === 'user' ? ('user' as const) : ('agent' as const),
                displayText: m.content,
              })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const persistMessage = useCallback(
    (role: 'user' | 'assistant', content: string): void => {
      if (content === '') return;
      void getUserDb().then((db) => {
        db.upsertThread(threadId, pinnedAppId !== undefined ? { appId: pinnedAppId } : {});
        db.appendChatMessage(threadId, role, content);
      });
    },
    [threadId, pinnedAppId],
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
      setActivity(mode === 'subscription' ? 'it’s thinking…' : 'warming up…');
      persistMessage('user', displayText);
      streamAccumRef.current = '';
      const controller = new AbortController();
      abortRef.current = controller;
      void agent
        .send(
          wire,
          {
            onDelta: (delta) => {
              setActivity(undefined);
              streamAccumRef.current += delta;
              patchMessage(agentId, (m) => ({ displayText: m.displayText + delta }));
            },
            onArtifact: (artifact) => {
              if (mode === 'subscription') {
                // F4 client-authoritative: the hub's artifact store is a transient
                // cache — pull the HTML and write it into the user DB ourselves.
                setActivity('saving the app into your snug file…');
                void hubArtifacts
                  .getHtml(artifact.artifactId)
                  .then(async (html) => {
                    if (html === undefined) throw new Error('artifact missing from the hub cache');
                    const written = await sink.write(html, artifact.displayName);
                    const event: ArtifactEvent = {
                      artifactId: written.id,
                      displayName: written.displayName,
                      version: written.version,
                    };
                    setLastArtifact(event);
                    patchMessage(agentId, { artifact: event });
                  })
                  .catch(() => {
                    patchMessage(agentId, (m) => ({
                      error: m.error ?? {
                        code: 'ARTIFACT_FETCH_FAILED',
                        message: 'the app was built on the hub but could not be saved into your snug file',
                        retryable: true,
                      },
                    }));
                  })
                  .finally(() => setActivity(undefined));
              } else {
                setLastArtifact(artifact);
                patchMessage(agentId, { artifact });
              }
            },
            onActivity: (label) => setActivity(label),
          },
          controller.signal,
        )
        .then((result) => {
          if (result.ok) {
            // A done event with empty/missing text must not wipe the streamed deltas.
            const finalText = result.text !== '' ? result.text : streamAccumRef.current;
            patchMessage(agentId, (m) => ({
              streaming: false,
              displayText: result.text !== '' ? result.text : m.displayText,
            }));
            persistMessage('assistant', finalText);
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
    [agent, busy, mode, patchMessage, persistMessage, sink, hubArtifacts],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Leaving the view aborts any in-flight turn — never leave a request running headless.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, busy, activity, lastArtifact, send, stop };
}
