// useBuilderChat.ts — the chat state machine shared by the Builder view and the Run
// view's chat rail. Wraps a BuilderAgent (subscription SSE or direct in-browser) and
// exposes plain message state; the artifact event is what turns a reply into a
// "run it" card.
//
// Living-apps evolution (TASK-20260803-app-context-chat):
// - Every turn carries the attached app's context (code, schema, wiki docs, history) —
//   built per turn from the user DB via buildAppTurnContext (AC4).
// - The thread→app pin is DURABLE (review F10): the thread row records the installed
//   app id; a resumed thread versions the SAME app instead of installing a duplicate.
// - The bootstrap turn — the one that produced the app's v1 artifact (review F9) — is
//   pinned in the DB and survives any pruning for the life of the app (AC5).
// - Artifact cards persist in message `meta` and re-render on rehydration.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createServerArtifactFetch } from '../state/library.js';
import { useLocalUrl, useMode, useModel, useProvider } from '../state/mode.js';
import { getUserDb } from '../state/userdb.js';
import { buildAppTurnContext } from './appContext.js';
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
  /** The app this thread is durably attached to (pin or recorded install), if any. */
  attachedAppId: string | undefined;
  /** Bumped when the app's schema or wiki docs change — refresh signal for panels. */
  knowledgeEpoch: number;
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

/** Persisted message meta shape (owned here; the DB stores it as opaque JSON). */
interface PersistedMeta {
  artifact?: { appId: string; version?: number; displayName: string };
  wireText?: string;
}

let messageSeq = 0;

function metaToArtifact(meta: unknown): ArtifactEvent | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const artifact = (meta as PersistedMeta).artifact;
  if (artifact === undefined || typeof artifact.appId !== 'string') return undefined;
  return {
    artifactId: artifact.appId,
    displayName: typeof artifact.displayName === 'string' ? artifact.displayName : 'your app',
    ...(typeof artifact.version === 'number' ? { version: artifact.version } : {}),
  };
}

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
  const [knowledgeEpoch, setKnowledgeEpoch] = useState(0);
  /** Durable thread→app pin (review F10): loaded from the thread row, set on install. */
  const [threadAppId, setThreadAppId] = useState<string | undefined>(undefined);
  const threadAppIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const streamAccumRef = useRef('');

  useEffect(() => {
    threadAppIdRef.current = threadAppId;
  }, [threadAppId]);

  const attachedAppId = pinnedAppId ?? threadAppId;

  const onInstall = useCallback(
    (appId: string): void => {
      setThreadAppId(appId);
      threadAppIdRef.current = appId;
      void getUserDb().then((db) => {
        db.upsertThread(threadId, { appId });
      });
    },
    [threadId],
  );

  const sink = useMemo(
    () =>
      createAppTargetSink({
        ...(pinnedAppId !== undefined ? { pinnedAppId } : {}),
        ...(pinnedAppId === undefined && threadAppId !== undefined ? { initialTargetId: threadAppId } : {}),
        onInstall,
      }),
    [pinnedAppId, threadId, threadAppId, onInstall],
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

  // AC4: a fresh session over the same user DB re-renders the persisted thread —
  // including artifact cards (from message meta) and the durable app pin.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setLastArtifact(undefined);
    setThreadAppId(undefined);
    threadAppIdRef.current = undefined;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const row = db.getThread(threadId);
      if (row?.appId !== undefined) {
        setThreadAppId(row.appId);
        threadAppIdRef.current = row.appId;
      }
      const persisted = db.listChatMessages(threadId);
      if (persisted.length === 0) return;
      setMessages((current) =>
        current.length > 0
          ? current
          : persisted
              .filter((m) => m.role !== 'system')
              .map((m) => {
                const artifact = metaToArtifact(m.meta);
                return {
                  id: ++messageSeq,
                  role: m.role === 'user' ? ('user' as const) : ('agent' as const),
                  displayText: m.content,
                  ...(artifact !== undefined ? { artifact } : {}),
                };
              }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

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
      const isFirstMessage = messages.length === 0;
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', displayText, wireText: wire },
        { id: agentId, role: 'agent', displayText: '', streaming: true },
      ]);
      setBusy(true);
      setActivity(mode === 'subscription' ? 'it’s thinking…' : 'warming up…');
      streamAccumRef.current = '';
      const controller = new AbortController();
      abortRef.current = controller;
      /** Per-turn state for bootstrap pinning (F9) + artifact-card persistence. */
      const turn: { userDbId?: number; artifact?: ArtifactEvent; installedV1: boolean } = { installedV1: false };
      /** Subscription-mode artifact fetch+write runs detached — awaited before the turn finalizes. */
      let artifactWork: Promise<void> = Promise.resolve();

      const noteArtifact = (event: ArtifactEvent): void => {
        turn.artifact = event;
        if (event.version === 1) turn.installedV1 = true;
        setLastArtifact(event);
        patchMessage(agentId, { artifact: event });
      };

      void (async () => {
        const db = await getUserDb();
        // Context is built BEFORE persisting this turn's user message, so history
        // holds strictly prior turns.
        const contextTarget = pinnedAppId ?? threadAppIdRef.current;
        const { contextBlock, history } = await buildAppTurnContext(db, contextTarget, threadId);
        db.upsertThread(threadId, {
          ...(pinnedAppId !== undefined ? { appId: pinnedAppId } : {}),
          ...(isFirstMessage ? { title: displayText.slice(0, 64) } : {}),
        });
        turn.userDbId = db.appendChatMessage(threadId, 'user', displayText).id;

        const result = await agent.send(
          { message: wire, ...(contextBlock !== undefined ? { contextBlock } : {}), history },
          {
            onDelta: (delta) => {
              setActivity(undefined);
              streamAccumRef.current += delta;
              patchMessage(agentId, (m) => ({ displayText: m.displayText + delta }));
            },
            onKnowledge: () => setKnowledgeEpoch((epoch) => epoch + 1),
            onArtifact: (artifact) => {
              if (mode === 'subscription') {
                // F4 client-authoritative: the hub's artifact store is a transient
                // cache — pull the HTML and write it into the user DB ourselves.
                setActivity('saving the app into your snug file…');
                artifactWork = hubArtifacts
                  .getHtml(artifact.artifactId)
                  .then(async (html) => {
                    if (html === undefined) throw new Error('artifact missing from the hub cache');
                    const written = await sink.write(html, artifact.displayName);
                    noteArtifact({ artifactId: written.id, displayName: written.displayName, version: written.version });
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
                noteArtifact(artifact);
              }
            },
            onActivity: (label) => setActivity(label),
          },
          controller.signal,
        );
        // The bootstrap pin and artifact meta need the client-authoritative write to
        // have landed (or failed) before the assistant message persists.
        await artifactWork;

        if (result.ok) {
          // A done event with empty/missing text must not wipe the streamed deltas.
          const finalText = result.text !== '' ? result.text : streamAccumRef.current;
          patchMessage(agentId, (m) => ({
            streaming: false,
            displayText: result.text !== '' ? result.text : m.displayText,
          }));
          if (finalText !== '') {
            // F9: the turn that produced v1 is the bootstrap — pin both sides of it.
            if (turn.installedV1 && turn.userDbId !== undefined) db.pinChatMessage(turn.userDbId);
            const meta: PersistedMeta | undefined =
              turn.artifact !== undefined
                ? {
                    artifact: {
                      appId: turn.artifact.artifactId,
                      displayName: turn.artifact.displayName,
                      ...(turn.artifact.version !== undefined ? { version: turn.artifact.version } : {}),
                    },
                  }
                : undefined;
            db.appendChatMessage(threadId, 'assistant', finalText, {
              ...(turn.installedV1 ? { pinned: true } : {}),
              ...(meta !== undefined ? { meta } : {}),
            });
          }
        } else {
          patchMessage(agentId, {
            streaming: false,
            error: { code: result.code, message: result.message, retryable: result.retryable },
          });
        }
      })()
        .catch(() => {
          patchMessage(agentId, {
            streaming: false,
            error: { code: 'TURN_FAILED', message: 'something went wrong preparing the turn', retryable: true },
          });
        })
        .finally(() => {
          setBusy(false);
          setActivity(undefined);
          abortRef.current = null;
        });
    },
    [agent, busy, messages.length, mode, patchMessage, pinnedAppId, sink, hubArtifacts, threadId],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Leaving the view aborts any in-flight turn — never leave a request running headless.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, busy, activity, lastArtifact, attachedAppId, knowledgeEpoch, send, stop };
}
