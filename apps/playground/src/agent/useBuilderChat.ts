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

import type { AgentTurnEvent } from '@snugprotocol/adapters';
import { AUTH_WIZARD_DIRECTIVE_KIND, type AuthWizardDirective, type RenderDirective } from '@snugprotocol/protocol';

import { directiveToMeta, metaToDirective, scanForRenderDirective } from './renderDirective.js';
import { createServerArtifactFetch } from '../state/library.js';
import { useLocalUrl, useMode, useModel, useProvider } from '../state/mode.js';
import { resolveTurnMode, useBrain } from '../state/webllm.js';
import { getUserDb } from '../state/userdb.js';
import { buildAppTurnContext } from './appContext.js';
import { createAppTargetSink } from './artifactSink.js';
import { finalizeConnectionDeclaration } from './connectionPipeline.js';
import {
  createDirectBuilder,
  createServerBuilder,
  type ArtifactEvent,
  type BuilderAgent,
  type BuildStep,
} from './builder.js';

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
  /** A VALIDATED auth_wizard render directive found in the reply (AL-04 D9). */
  directive?: AuthWizardDirective;
  /** Visible note when a claimed directive failed validation and was dropped (D9). */
  directiveNote?: string;
}

/**
 * One rendered step of the build timeline (AC9/AC10). Unlike the old single `activity`
 * slot, steps accumulate in order within a turn and carry their own completion state.
 */
export interface BuildStepView {
  /** Tool name — the timeline's identity key within a turn. */
  tool: string;
  /** Human label ("designing the app’s database…"). */
  label: string;
  /** True once the tool's result came back (AC10). */
  done: boolean;
}

export interface BuilderChat {
  messages: ChatMessage[];
  busy: boolean;
  /** Reasoning-pill label while the agent works ("consulting the knowledge base…"). */
  activity: string | undefined;
  /** Ordered, live build steps for the current turn — cleared when the next turn starts. */
  steps: BuildStepView[];
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
  /**
   * Observation sink for LLM activity (direct mode only) — the inspector's feed.
   * Carries starts as well as completions so the surface can render a call while it is
   * still running. IN-MEMORY ONLY: the hook never persists these (AC7/AC14).
   */
  onLlmEvent?: (event: AgentTurnEvent) => void;
  /**
   * Called at the START of every turn so the inspector can clear the previous turn.
   * Without it the ring buffer accumulates across a whole session rather than showing
   * one turn, and retains the largest entries by construction.
   */
  onTurnStart?: () => void;
}

/** Persisted message meta shape (owned here; the DB stores it as opaque JSON). */
interface PersistedMeta {
  artifact?: { appId: string; version?: number; displayName: string };
  wireText?: string;
  /** The VALIDATED render directive — the only directive shape that persists (M1). */
  directive?: RenderDirective;
}

let messageSeq = 0;

/**
 * Tool name → timeline label. Shared by both modes: direct mode names tools locally,
 * subscription mode gets the same names over the `step` SSE event, so one map serves
 * both. An unknown tool still gets a step (falling back to its raw name) — a new
 * server-side tool must never render as a blank row.
 */
const STEP_LABELS: Record<string, string> = {
  snug_knowledge: 'consulting the knowledge base…',
  artifact_write: 'writing the app file…',
  schema_apply: 'designing the app’s database…',
  app_doc_write: 'updating the app’s docs…',
};

const stepLabel = (tool: string): string => STEP_LABELS[tool] ?? `${tool.replace(/_/g, ' ')}…`;

/**
 * Fold one start/end step into the timeline. `start` appends (or re-opens a repeat
 * call of the same tool); `end` completes the newest open step for that tool — a tool
 * legitimately runs more than once per turn (two KB consults is the exact case that
 * used to blow the old iteration ceiling).
 */
function applyStep(current: BuildStepView[], step: BuildStep): BuildStepView[] {
  if (step.phase === 'start') {
    return [...current, { tool: step.tool, label: stepLabel(step.tool), done: false }];
  }
  // Newest open step for that tool (no findLastIndex — the lib target is ES2022).
  let index = -1;
  for (let i = current.length - 1; i >= 0; i--) {
    const entry = current[i] as BuildStepView;
    if (entry.tool === step.tool && !entry.done) {
      index = i;
      break;
    }
  }
  if (index === -1) return current;
  const next = current.slice();
  next[index] = { ...(next[index] as BuildStepView), done: true };
  return next;
}

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
  const { pinnedAppId, onLlmEvent, onTurnStart } = options;
  const mode = useMode();
  const provider = useProvider();
  const model = useModel();
  const localUrl = useLocalUrl();
  const brain = useBrain();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | undefined>(undefined);
  const [steps, setSteps] = useState<BuildStepView[]>([]);
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

  // AL-07: the experimental webllm brain overrides the configured mode entirely
  // (subscription included) — same rule as agent/transport.ts. EVERY later branch on
  // "is this a server turn?" must use serverTurn, never `mode === 'subscription'`
  // alone: with the brain overriding, the configured mode and the turn's actual path
  // disagree, and branching on the configured mode routed a demo-fallback artifact
  // through the hub fetch (found by webllmBuilderChat.test.tsx; the exact defect
  // class of lessons 2026-08-05 — switch on the call, not the stale discriminator).
  const serverTurn = resolveTurnMode(brain, mode) === 'subscription';

  const agent: BuilderAgent = useMemo(() => {
    if (brain.kind === 'webllm') return createDirectBuilder({ mode: 'webllm', provider, sink, localUrl });
    if (brain.kind === 'demo') return createDirectBuilder({ mode: 'byok', provider: 'mock', sink, localUrl });
    return mode === 'subscription'
      ? createServerBuilder(threadId, undefined, model)
      : createDirectBuilder({
          mode,
          provider,
          sink,
          ...(model !== undefined ? { model } : {}),
          localUrl,
        });
  }, [brain, mode, provider, model, localUrl, threadId, sink]);

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
                // Re-validated strictly on every read (D9): an imported row whose
                // directive grew fields renders as no card at all.
                const directive = metaToDirective(m.meta);
                return {
                  id: ++messageSeq,
                  role: m.role === 'user' ? ('user' as const) : ('agent' as const),
                  displayText: m.content,
                  ...(artifact !== undefined ? { artifact } : {}),
                  ...(directive !== undefined && directive.kind === AUTH_WIZARD_DIRECTIVE_KIND ? { directive } : {}),
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
      setActivity(serverTurn ? 'it’s thinking…' : 'warming up…');
      // The timeline is per-turn: the previous turn's steps are history, not progress.
      setSteps([]);
      // Same for the LLM inspector — without this its ring buffer accumulates across the
      // whole session and retains the largest (latest) entries by construction.
      onTurnStart?.();
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
              if (serverTurn) {
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
            onStep: (step: BuildStep) => setSteps((current) => applyStep(current, step)),
            onLlmEvent: (event) => onLlmEvent?.(event),
          },
          controller.signal,
        );
        // The bootstrap pin and artifact meta need the client-authoritative write to
        // have landed (or failed) before the assistant message persists.
        await artifactWork;

        if (result.ok) {
          // A done event with empty/missing text must not wipe the streamed deltas.
          const finalText = result.text !== '' ? result.text : streamAccumRef.current;
          // D9: validate BEFORE any UI effect. A malformed claimed directive is
          // dropped with a visible note, never partially rendered and never persisted.
          const scan = finalText !== '' ? scanForRenderDirective(finalText) : null;
          const directive: AuthWizardDirective | undefined =
            scan !== null && 'directive' in scan && scan.directive.kind === AUTH_WIZARD_DIRECTIVE_KIND ? scan.directive : undefined;
          /**
           * P2 (+ fold): the build turn's `connection_requirement` declaration lands HERE,
           * post-turn — the earliest moment the directive exists, and still strictly before
           * the app is first RUN, which is the guarantee that matters. It cannot happen at
           * the version write: `artifact_write` is a mid-turn tool call and the KB has the
           * model close its reply with the directive, so there is no reply text to scan yet.
           *
           * A refusal never unwinds the saved app — the HTML is the user's work — but it is
           * never swallowed either: it becomes a visible note, because a connected app with
           * no connect card is indistinguishable from a broken one.
           */
          let connectionNote: string | undefined;
          if (turn.artifact !== undefined && finalText !== '') {
            const appHtml = db.getAppHtml(turn.artifact.artifactId);
            if (appHtml !== undefined) {
              const outcome = await finalizeConnectionDeclaration(db, {
                appId: turn.artifact.artifactId,
                html: appHtml,
                reply: finalText,
                channel: 'inference',
              });
              if (outcome !== undefined && !outcome.ok) {
                connectionNote =
                  outcome.reason === 'connected_html_without_requirement'
                    ? 'this app calls out to a provider but the agent declared no connection, so there is no connect card yet — ask it to declare the connection'
                    : 'the agent proposed a connection that failed validation — the app was saved without it';
              }
            }
          }

          patchMessage(agentId, (m) => ({
            streaming: false,
            displayText: result.text !== '' ? result.text : m.displayText,
            ...(directive !== undefined ? { directive } : {}),
            ...(scan !== null && 'malformed' in scan
              ? { directiveNote: 'the agent proposed a connection card that failed validation — ignored' }
              : connectionNote !== undefined
                ? { directiveNote: connectionNote }
                : {}),
          }));
          if (finalText !== '') {
            // F9: the turn that produced v1 is the bootstrap — pin both sides of it.
            if (turn.installedV1 && turn.userDbId !== undefined) db.pinChatMessage(turn.userDbId);
            const meta: PersistedMeta | undefined =
              turn.artifact !== undefined || directive !== undefined
                ? {
                    ...(turn.artifact !== undefined
                      ? {
                          artifact: {
                            appId: turn.artifact.artifactId,
                            displayName: turn.artifact.displayName,
                            ...(turn.artifact.version !== undefined ? { version: turn.artifact.version } : {}),
                          },
                        }
                      : {}),
                    // M1: the persisted directive is the VALIDATED shape — evidence-free
                    // by construction (the schema has no such field).
                    ...(directive !== undefined ? directiveToMeta(directive) : {}),
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
    [agent, busy, messages.length, serverTurn, onLlmEvent, onTurnStart, patchMessage, pinnedAppId, sink, hubArtifacts, threadId],
  );

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Leaving the view aborts any in-flight turn — never leave a request running headless.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, busy, activity, steps, lastArtifact, attachedAppId, knowledgeEpoch, send, stop };
}
