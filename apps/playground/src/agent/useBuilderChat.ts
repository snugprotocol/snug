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

import type { AgentTool, AgentTurnEvent } from '@snugprotocol/adapters';
import { AUTH_WIZARD_DIRECTIVE_KIND, type AuthWizardDirective, type RenderDirective } from '@snugprotocol/protocol';

import { directiveToMeta, metaToDirective, scanForRenderDirective } from './renderDirective.js';
import { createServerArtifactFetch } from '../state/library.js';
import { useLocalUrl, useMode, useModel, useProvider } from '../state/mode.js';
import { resolveTurnMode, useBrain } from '../state/webllm.js';
import { getUserDb } from '../state/userdb.js';
import { buildAppTurnContext } from './appContext.js';
import { buildIntentTurnContext } from './intentContext.js';
import { routeChatMessage, type ChatRoute } from './chatRouter.js';
import type { PendingWriteProposal } from './dataTools.js';
import { createAppTargetSink } from './artifactSink.js';
import { needsSynthesizedContract } from './runtimeContractSynthesis.js';
import { finalizeConnectionDeclaration } from './connectionPipeline.js';
import { authChoiceForPersistedRow, metaToAuthChoice, type AuthChoiceSeed } from './authChoiceCard.js';
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
  /**
   * A v4 `connection_requirement` that the post-turn pipeline actually PERSISTED (P3).
   *
   * It carries only the (appId, slot) the row lives at plus the provider NAME for the
   * card's label — never the requirement itself. That is the doorbell rule made
   * structural: the card can name what was declared and open the wizard on it, but what
   * the user REVIEWS is read from the row, so nothing on this message can influence it.
   */
  connection?: { appId: string; slot: string; providerName: string };
  /**
   * The provider offers MORE THAN ONE way in (TASK-20260812-auth-kind-choice). For a
   * registry provider this is a pointer — the card reads the pinned options itself;
   * for an unregistered one it carries the turn's validated inference alternatives,
   * re-admitted again on every read. Rendering is gated on the LIVE row, so a card
   * over a chosen/approved row shows nothing.
   */
  authChoice?: AuthChoiceSeed;
  /**
   * A STAGED data-write proposal awaiting the user's approval (ADR-0019 D8).
   *
   * Present only because `data_propose_write` successfully dry-ran it, so the card can
   * never advertise a change that was never previewed — the same rule the connection
   * card follows. `outcome` is set once the user resolves it, which is what stops the
   * card offering "apply" a second time.
   */
  dataWrite?: DataWriteCardState;
}

/** A proposal as the chat renders it: the staged change plus how it was resolved. */
export interface DataWriteCardState extends PendingWriteProposal {
  outcome?: 'applied' | 'declined' | 'drifted' | 'failed';
  /** Rows actually affected, recorded once applied. */
  executed?: number[];
  /**
   * The USER-DB row this card is persisted on, so resolving it can persist too (R-M5).
   *
   * Absent until the turn finalizes (the row does not exist while the turn is streaming)
   * and on any card whose message predates this field — resolution then stays in-memory
   * for that session, which is the pre-R-M5 behavior rather than a new failure.
   */
  messageRowId?: number;
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
  /**
   * Apply a staged data-write proposal (ADR-0019 D8). THE ONLY path from the chat to the
   * user's data, and it re-validates before executing — the model cannot reach it.
   */
  approveDataWrite: (proposal: DataWriteCardState, messageId: number) => void;
  /** Decline it. Executes nothing; the card settles as cancelled. */
  declineDataWrite: (proposal: DataWriteCardState, messageId: number) => void;
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
  /** A staged/resolved data-write proposal, so the card survives a reload (R-M5). */
  dataWrite?: DataWriteCardState;
  /** The auth-option choice seed — inference alternatives must survive a reload (AC7). */
  authChoice?: AuthChoiceSeed;
}

/**
 * Persist a resolved proposal's outcome onto its stored message (R-M5).
 *
 * Without this, approving a change and reloading re-renders the card as still pending and
 * offers "apply" a second time — and the drift guard cannot always save that, since an
 * INSERT into a table with no unique constraint re-applies cleanly.
 *
 * Best-effort by design: a card with no `messageRowId` (turn still streaming, or a message
 * that predates the field) keeps its in-memory resolution, which is exactly the behavior
 * before this fix. Failing to write an audit field must never break the surface that just
 * successfully applied the user's change.
 */
function persistResolution(
  db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  threadId: string,
  proposal: DataWriteCardState,
  resolved: DataWriteCardState,
): void {
  const rowId = proposal.messageRowId;
  if (rowId === undefined) return;
  try {
    // MERGE, never replace: the same message can also carry an artifact card or a render
    // directive, and resolving a data write must not delete them.
    const existing = db.listChatMessages(threadId).find((m) => m.id === rowId)?.meta;
    const base = typeof existing === 'object' && existing !== null ? (existing as PersistedMeta) : {};
    db.updateChatMessageMeta(rowId, { ...base, dataWrite: resolved });
  } catch {
    // The change itself already landed; an unwritable audit field is not worth a throw.
  }
}

/**
 * Rebuild a data-write card from a persisted row, or `undefined` if the row cannot be
 * trusted to render one (R-M5).
 *
 * Validated on every READ rather than on write alone, matching the artifact and directive
 * seats: these rows travel through export/import and sync, so a shape that drifted or was
 * crafted elsewhere must render as NO card rather than as a card that misrepresents what
 * the user would be approving.
 *
 * Deliberately NOT re-previewed here. The counts were computed when the proposal was
 * staged and the data may have moved since — but `executeApprovedWrite` already re-runs
 * the dry run at approve time and halts on drift, so a stale card cannot execute a stale
 * change. Re-previewing on every rehydration would mean a scratch run per render for a
 * number the execute path recomputes anyway.
 */
function metaToDataWrite(meta: unknown): DataWriteCardState | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const staged = (meta as PersistedMeta).dataWrite;
  if (staged === undefined || typeof staged !== 'object') return undefined;
  const { appId, statements, params, summary, previewed, outcome, executed } = staged;
  if (typeof appId !== 'string' || typeof summary !== 'string') return undefined;
  if (!Array.isArray(statements) || statements.length === 0) return undefined;
  if (!statements.every((sql) => typeof sql === 'string')) return undefined;
  if (!Array.isArray(previewed) || !previewed.every((n) => typeof n === 'number')) return undefined;
  return {
    appId,
    statements,
    params: Array.isArray(params) ? params : statements.map(() => []),
    summary,
    previewed,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(Array.isArray(executed) ? { executed } : {}),
  };
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
  runtime_contract_write: 'noting how the app should think at run time…',
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
  /** Message ids whose approval is mid-execution — the double-click guard's state. */
  const approvalsInFlight = useRef<Set<number>>(new Set());
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
                const dataWrite = metaToDataWrite(m.meta);
                const authChoice = metaToAuthChoice(m.meta);
                return {
                  id: ++messageSeq,
                  role: m.role === 'user' ? ('user' as const) : ('agent' as const),
                  displayText: m.content,
                  ...(artifact !== undefined ? { artifact } : {}),
                  ...(directive !== undefined && directive.kind === AUTH_WIZARD_DIRECTIVE_KIND ? { directive } : {}),
                  ...(dataWrite !== undefined ? { dataWrite } : {}),
                  ...(authChoice !== undefined ? { authChoice } : {}),
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
      /** True once this turn has staged a write proposal — one card per turn (see below). */
      // Holds the proposal itself (not just a flag) so turn finalization can persist it
      // onto the assistant message's meta — the card must survive a reload (R-M5).
      const stagedProposal: { current: DataWriteCardState | undefined } = { current: undefined };
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
        /**
         * ADR-0019 D6 — CLASSIFY FIRST, for a message beside an INSTALLED app.
         *
         * `routeChatMessage` decides the lane; `buildIntentTurnContext` then assembles
         * only what that lane needs. Everything about the ordering here is deliberate:
         *  - it runs BEFORE the user message is persisted, so the classifier's history
         *    holds strictly prior turns — the same rule the context assembler follows;
         *  - it takes THIS turn's abort signal, so stop and unmount cancel it (F-M4a);
         *  - it can only return a lane or `clarify`, never throw (F-M4c).
         *
         * Scope: byok/local with a pinned app. Subscription/webllm/demo keep today's
         * path unchanged — the data tools have no server twin and webllm is tool-free
         * (ADR-0015) — and the rail states that gap rather than hiding it.
         */
        let route: ChatRoute | undefined;
        if (contextTarget !== undefined && !serverTurn) {
          const { liveInferenceAdapter } = await import('./inferrerAdapter.js');
          const live = await liveInferenceAdapter();
          if (live.ok) {
            route = await routeChatMessage({
              db,
              appId: contextTarget,
              message: displayText,
              threadId,
              adapter: live.adapter,
              signal: controller.signal,
              ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
            });
          }
        }

        // The CLARIFY lane settles here and returns: no builder turn runs, no tool is
        // offered, and the exchange persists like any other so it survives a reload
        // (F-M4b — the placeholder must never be left spinning).
        /**
         * A CANCELLED turn is not a clarification (R-M3). The adapters collapse a user
         * abort into the same `ok:false` a model failure produces, and the router maps
         * every `ok:false` to the clarify lane — so without this check, pressing stop
         * persisted a canned assistant reply the model never produced, which then became
         * real history steering the next turn's classifier.
         *
         * Checked before the clarify branch rather than inside the router because the
         * router is a pure classification function: whether the user is still waiting for
         * an answer is the caller's knowledge, not the classifier's.
         */
        if (controller.signal.aborted) {
          patchMessage(agentId, { streaming: false });
          setBusy(false);
          setActivity(undefined);
          abortRef.current = null;
          return;
        }

        if (route?.lane === 'clarify') {
          db.upsertThread(threadId, {
            ...(pinnedAppId !== undefined ? { appId: pinnedAppId } : {}),
            ...(isFirstMessage ? { title: displayText.slice(0, 64) } : {}),
          });
          db.appendChatMessage(threadId, 'user', displayText);
          db.appendChatMessage(threadId, 'assistant', route.question);
          patchMessage(agentId, { streaming: false, displayText: route.question });
          setBusy(false);
          setActivity(undefined);
          abortRef.current = null;
          return;
        }

        const { contextBlock, history } =
          route === undefined
            ? await buildAppTurnContext(db, contextTarget, threadId)
            : await buildIntentTurnContext(db, contextTarget, route.intent, threadId);
        db.upsertThread(threadId, {
          ...(pinnedAppId !== undefined ? { appId: pinnedAppId } : {}),
          ...(isFirstMessage ? { title: displayText.slice(0, 64) } : {}),
        });
        turn.userDbId = db.appendChatMessage(threadId, 'user', displayText).id;

        /**
         * LANE-SCOPED TOOLS (ADR-0019 D9) — the second lock. The data lane gets the two
         * data tools and NOTHING that writes code (AC-F2-5); the answer lane gets none at
         * all; the feature lane keeps the builder set by passing no override.
         *
         * `data_read` also drops the write tool: a question is not permission to propose
         * a change, and the narrower set is the cheaper prompt.
         */
        let laneTools: AgentTool[] | undefined;
        if (route?.lane === 'data' && contextTarget !== undefined) {
          const { buildDataTools } = await import('./dataTools.js');
          laneTools = buildDataTools({
            appId: contextTarget,
            getDb: () => Promise.resolve(db),
            allowWrites: route.intent === 'data_write',
            /**
             * ONE PROPOSAL PER TURN (whole-surface review, 2026-08-11).
             *
             * `ChatMessage.dataWrite` is a single slot and the tool loop allows several
             * tool calls per turn, so a second `data_propose_write` used to silently
             * REPLACE the first: the earlier proposal vanished with no trace and the user
             * approved whichever the model happened to stage last. Keeping the FIRST and
             * refusing the rest makes the card and the tool result agree — the model is
             * told, in its own tool result, that the extra proposal was not staged, so it
             * can tell the user rather than believing both are pending.
             */
            onProposal: (proposal) => {
              if (stagedProposal.current !== undefined) return false;
              stagedProposal.current = proposal;
              patchMessage(agentId, { dataWrite: proposal });
              return true;
            },
          });
        } else if (route?.lane === 'answer') {
          laneTools = [];
        }

        const result = await agent.send(
          {
            message: wire,
            ...(contextBlock !== undefined ? { contextBlock } : {}),
            history,
            ...(laneTools !== undefined ? { tools: laneTools } : {}),
          },
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
          let connectionCard: { appId: string; slot: string; providerName: string } | undefined;
          let authChoice: AuthChoiceSeed | undefined;
          let recoveredAlternatives: AuthChoiceSeed['alternatives'];
          if (turn.artifact !== undefined && finalText !== '') {
            const appHtml = db.getAppHtml(turn.artifact.artifactId);
            if (appHtml !== undefined) {
              const outcome = await finalizeConnectionDeclaration(db, {
                appId: turn.artifact.artifactId,
                html: appHtml,
                reply: finalText,
                channel: 'inference',
                /**
                 * P3 (plan §6 item 5): the v2 requirement inferrer, wired in as the
                 * recovery path for a connected build that declared nothing. This is the
                 * production caller that makes P2's AC7 true on the SHIPPED path rather
                 * than by test construction — and it runs at BUILD, before any credential
                 * for the connection exists, which is what makes "inference never sees a
                 * credential" an ordering fact rather than a promise.
                 *
                 * Imported dynamically so the inference wire (and its adapter/knowledge
                 * dependencies) stays off the builder chat's hot path: this fires only in
                 * the rare undeclared-connected-build case, never on a normal turn.
                 */
                recoverRequirement: async (request) => {
                  const { runConnectionRequirementInference } = await import('./connectionInferrerAdapter.js');
                  const result = await runConnectionRequirementInference(request);
                  // An honest refusal (`requirement: null`) is NOT a recovery: it means the
                  // model declined to guess, and a declined guess must fall through to the
                  // note rather than be dressed up as an answer.
                  if (!result.ok || result.requirement === null) return undefined;
                  // Alternatives are candidates for the choice card, never rows — captured
                  // here because the persist outcome deliberately does not carry them.
                  if (result.alternatives !== undefined) recoveredAlternatives = result.alternatives;
                  return {
                    requirement: result.requirement,
                    provenance: result.provenance,
                    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
                  };
                },
              });
              if (outcome !== undefined && outcome.ok) {
                // A persisted row means there is something to connect: surface the card.
                connectionCard = {
                  appId: turn.artifact.artifactId,
                  slot: outcome.requirement.slot,
                  providerName: outcome.requirement.provider.name,
                };
                // Multi-option providers additionally surface the CHOICE card
                // (TASK-20260812-auth-kind-choice AC3): registry providers as a bare
                // pointer, unregistered ones with the turn's validated alternatives.
                authChoice = authChoiceForPersistedRow({
                  appId: turn.artifact.artifactId,
                  requirement: outcome.requirement,
                  ...(recoveredAlternatives !== undefined ? { alternatives: recoveredAlternatives } : {}),
                });
              }
              if (outcome !== undefined && !outcome.ok) {
                connectionNote =
                  outcome.reason === 'connected_html_without_requirement'
                    ? 'this app calls out to a provider but the agent declared no connection, so there is no connect card yet — ask it to declare the connection'
                    : 'the agent proposed a connection that failed validation — the app was saved without it';
              }

              /**
               * ADR-0018 D5 — the runtime-contract guarantee, on the same seam and for the
               * same reason as the connection declaration above: this is the earliest
               * moment the artifact exists AND the reply is final, and it is still
               * strictly before the app is first RUN.
               *
               * Scope (fold F-B1): only when the app's whole version lineage has no
               * contract — with copy-forward that means first build/install, never a
               * cosmetic edit, so an authored contract can never be replaced by a
               * synthesized one.
               *
               * byok/local only (fold F-M2): `liveInferenceAdapter` is the shared wire
               * ladder, and it refuses on a keyless/demo configuration. Subscription mode
               * has no server twin for this turn, so those apps simply stay
               * contract-less — a stated gap, not a silent one.
               *
               * Failure NEVER blocks the build: the app runs on the lean generic layers.
               * Imported dynamically so the synthesis wire stays off the hot path of a
               * normal turn, matching the inferrer precedent directly above.
               */
              if (needsSynthesizedContract(db, turn.artifact.artifactId, appHtml)) {
                try {
                  const [{ synthesizeRuntimeContract }, { liveInferenceAdapter }] = await Promise.all([
                    import('./runtimeContractSynthesis.js'),
                    import('./inferrerAdapter.js'),
                  ]);
                  const live = await liveInferenceAdapter();
                  if (live.ok) {
                    await synthesizeRuntimeContract({
                      db,
                      appId: turn.artifact.artifactId,
                      html: appHtml,
                      adapter: live.adapter,
                      signal: controller.signal,
                      ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
                    });
                  }
                } catch {
                  // Contract-less is a supported state (AC-F1-4). A bonus step must never
                  // fail a build the user has already completed.
                }
              }
            }
          }

          patchMessage(agentId, (m) => ({
            streaming: false,
            displayText: result.text !== '' ? result.text : m.displayText,
            ...(directive !== undefined ? { directive } : {}),
            ...(connectionCard !== undefined ? { connection: connectionCard } : {}),
            ...(authChoice !== undefined ? { authChoice } : {}),
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
              turn.artifact !== undefined ||
              directive !== undefined ||
              stagedProposal.current !== undefined ||
              authChoice !== undefined
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
                    // R-M5: the assistant's text says a change is awaiting approval, so the
                    // card it refers to has to outlive the React tree that rendered it.
                    ...(stagedProposal.current !== undefined ? { dataWrite: stagedProposal.current } : {}),
                    // AC7: inference alternatives are not re-derivable after the turn, so
                    // the choice must survive a reload; re-admitted on every read.
                    ...(authChoice !== undefined ? { authChoice } : {}),
                  }
                : undefined;
            const stored = db.appendChatMessage(threadId, 'assistant', finalText, {
              ...(turn.installedV1 ? { pinned: true } : {}),
              ...(meta !== undefined ? { meta } : {}),
            });
            // R-M5: hand the card the row it now lives on, so approve/decline can persist
            // their outcome instead of leaving a reload to re-offer an applied change.
            if (stagedProposal.current !== undefined) {
              const rowId = stored.id;
              patchMessage(agentId, (m) => ({
                dataWrite: { ...(m.dataWrite ?? stagedProposal.current!), messageRowId: rowId },
              }));
            }
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

  /**
   * Approve → execute. Deliberately in HOST code, reached only from the card's button:
   * the tool that proposed the change has no way to call this, which is what makes
   * "the LLM proposes, the human approves" structural rather than procedural.
   */
  const approveDataWrite = useCallback((proposal: DataWriteCardState, messageId: number): void => {
    // DOUBLE-CLICK GUARD (whole-surface review, 2026-08-11). `outcome` is only set after
    // several awaits — a DB open, a dynamic import, and two scratch runs — so two clicks
    // inside that window would BOTH reach `executeApprovedWrite`, and a non-idempotent
    // INSERT would land twice. Each run passes its own drift check, so the TOCTOU guard
    // cannot catch this: it is a re-entrancy problem, not a staleness one.
    if (approvalsInFlight.current.has(messageId)) return;
    approvalsInFlight.current.add(messageId);
    void (async () => {
      try {
      const db = await getUserDb();
      const { executeApprovedWrite } = await import('./dataTools.js');
      const outcome = await executeApprovedWrite(db, proposal);
      const resolved: DataWriteCardState = {
        ...proposal,
        outcome: outcome.ok ? ('applied' as const) : outcome.reason === 'drifted' ? ('drifted' as const) : ('failed' as const),
        ...(outcome.ok ? { executed: outcome.executed } : {}),
      };
      patchMessage(messageId, (m) => ({ dataWrite: { ...(m.dataWrite ?? proposal), ...resolved } }));
      persistResolution(db, threadId, proposal, resolved);
      } finally {
        approvalsInFlight.current.delete(messageId);
      }
    })();
  }, [patchMessage]);

  const declineDataWrite = useCallback((proposal: DataWriteCardState, messageId: number): void => {
    // Nothing to undo: a proposal never touched the real database.
    const resolved: DataWriteCardState = { ...proposal, outcome: 'declined' as const };
    patchMessage(messageId, (m) => ({ dataWrite: { ...(m.dataWrite ?? proposal), ...resolved } }));
    void (async () => persistResolution(await getUserDb(), threadId, proposal, resolved))();
  }, [patchMessage]);

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  // Leaving the view aborts any in-flight turn — never leave a request running headless.
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    messages,
    busy,
    activity,
    steps,
    lastArtifact,
    attachedAppId,
    knowledgeEpoch,
    send,
    stop,
    approveDataWrite,
    declineDataWrite,
  };
}
