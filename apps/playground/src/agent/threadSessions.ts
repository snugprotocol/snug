// threadSessions.ts — the per-thread SESSION registry (TASK-20260903, ADR-0062).
//
// A turn belongs to its thread, not to the view that started it. Before this, every piece
// of turn state — messages, busy, steps, the in-flight AbortController, the round-trip
// inspector — lived in component state inside useBuilderChat, and an unmount effect
// aborted the request ("never leave a request running headless"). React Router unmounts
// the view on every route change, so leaving /build for "your apps" killed a 30-minute
// build; the same cleanup under StrictMode's simulated unmount broke the hub→build
// handoff in dev. Now the state lives HERE, module-level, keyed by thread id, and a
// `send()` closure keeps streaming into it after every view is gone. The only abort is
// the user's explicit stop, or one of the swap seams below.
//
// IN MEMORY ONLY. Nothing in this module touches the user DB, localStorage or
// sessionStorage; the inspector state a session carries is the already-redacted reducer
// output (AC14 holds — asserted at the byte level across a navigation round trip).
//
// BOUNDED. Each session keeps the inspector's own ring buffer (60 entries / 8 MB), and
// idle sessions — not busy, no subscribed view — are evicted LRU beyond
// MAX_IDLE_SESSIONS. A busy session is never evicted: it has a live request.
//
// MODULE-GLOBAL STATE DERIVED FROM A SWAPPABLE STORE (lesson 2026-08-20): a session
// mirrors rows of the CURRENT user file, so every seam that swaps or wipes that file
// must call `resetThreadSessions`. The production seams, all next to the sidecar-identity
// reset that already lives there:
//   * state/sync.ts        afterForeignBytes   (user-file import, sync pull)
//   * state/userdb.ts      restoreUserDbFromBytes, recoverFresh, resetUserDbForTests
//   * state/library.ts     delete(appId)       → resetThreadSessions({ appId })
//   * views/ThreadSidebar  thread delete       → resetThreadSessions({ threadId })

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { AgentTurnEvent } from '@snugprotocol/adapters';

import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from '../run/llmInspector.js';
import { createStore, useStore, type Store } from '../state/store.js';
import type { ArtifactEvent } from './builder.js';
import type { BuildStepView, ChatMessage } from './useBuilderChat.js';

export interface ThreadSessionState {
  messages: ChatMessage[];
  busy: boolean;
  /** Reasoning-pill label while the agent works. */
  activity: string | undefined;
  /** Ordered build steps for the current turn — cleared when the next turn starts. */
  steps: BuildStepView[];
  lastArtifact: ArtifactEvent | undefined;
  /** Durable thread→app pin, mirrored from the thread row and set on install. */
  threadAppId: string | undefined;
  /** Bumped when the app's schema or wiki docs change. */
  knowledgeEpoch: number;
  /** True once the persisted thread has been read into `messages` (once per session). */
  hydrated: boolean;
  /** The LLM round-trip inspector for this thread — in memory, redacted, bounded. */
  llmInspector: LlmInspectorState;
}

export interface ThreadSession {
  readonly threadId: string;
  readonly store: Store<ThreadSessionState>;
  /** The in-flight turn's controller; null between turns. */
  abort: AbortController | null;
  /** Message ids whose data-write approval is mid-execution (the double-click guard). */
  readonly approvalsInFlight: Set<number>;
  /** Streamed text accumulator for the in-flight turn. */
  streamAccum: string;
  /** Recency for LRU eviction — a counter, never a clock: same-tick creations must order. */
  lastActive: number;
  /** Mounted views currently subscribed; an idle session with subscribers is not evicted. */
  subscribers: number;
}

/** Idle sessions retained beyond the busy ones — the memory bound (AC7). */
export const MAX_IDLE_SESSIONS = 8;

export function initialThreadSessionState(): ThreadSessionState {
  return {
    messages: [],
    busy: false,
    activity: undefined,
    steps: [],
    lastArtifact: undefined,
    threadAppId: undefined,
    knowledgeEpoch: 0,
    hydrated: false,
    llmInspector: initialLlmInspectorState,
  };
}

const sessions = new Map<string, ThreadSession>();
let recency = 0;

/**
 * Ticks whenever the SET of sessions or any session's busy flag changes — the thread
 * sidebar's refresh signal (a new thread gets its DB row on its first message, so the
 * list re-reads on every settle).
 */
export const sessionsChangedStore = createStore(0);
/** Ticks on every reset so a mounted hook re-resolves a FRESH session (AC8). */
export const registryEpochStore = createStore(0);

/**
 * Deferred, never synchronous: `getThreadSession` runs during render (the hook resolves
 * its session there), and notifying store subscribers mid-render is a React warning.
 */
function noteSessionsChanged(): void {
  queueMicrotask(() => sessionsChangedStore.set(sessionsChangedStore.get() + 1));
}

/**
 * Keep at most MAX_IDLE_SESSIONS idle sessions (not busy, no subscribed view), dropping
 * the least recently read. The session that triggered the sweep is the newest by
 * construction, so it is never among the victims.
 */
function evictIdle(): void {
  const idle = [...sessions.values()].filter((session) => !session.store.get().busy && session.subscribers === 0);
  if (idle.length <= MAX_IDLE_SESSIONS) return;
  idle.sort((a, b) => a.lastActive - b.lastActive);
  for (const victim of idle.slice(0, idle.length - MAX_IDLE_SESSIONS)) sessions.delete(victim.threadId);
}

/** The session for a thread — created on first read; every read refreshes its recency. */
export function getThreadSession(threadId: string): ThreadSession {
  const existing = sessions.get(threadId);
  if (existing !== undefined) {
    existing.lastActive = ++recency;
    return existing;
  }
  const created: ThreadSession = {
    threadId,
    store: createStore(initialThreadSessionState()),
    abort: null,
    approvalsInFlight: new Set(),
    streamAccum: '',
    lastActive: ++recency,
    subscribers: 0,
  };
  sessions.set(threadId, created);
  evictIdle();
  noteSessionsChanged();
  return created;
}

/** Read without creating or touching recency — for tests and the sidebar's badges. */
export function peekThreadSession(threadId: string): ThreadSession | undefined {
  return sessions.get(threadId);
}

type SessionPatch = Partial<ThreadSessionState> | ((state: ThreadSessionState) => Partial<ThreadSessionState>);

/**
 * Patch a session BY REFERENCE. A turn captures its session at send time and writes
 * through this, so a turn that outlived a reset writes into a detached store rather
 * than resurrecting a dropped thread by id.
 */
export function patchSession(session: ThreadSession, patch: SessionPatch): void {
  const previous = session.store.get();
  const next = { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) };
  session.store.set(next);
  if (previous.busy !== next.busy) noteSessionsChanged();
}

/** Patch by id — only an EXISTING session; never creates one. */
export function patchThreadSession(threadId: string, patch: SessionPatch): void {
  const session = sessions.get(threadId);
  if (session !== undefined) patchSession(session, patch);
}

/** Fold one agent-turn event (or `'reset'` at turn start) into a thread's inspector. */
export function dispatchLlmEvent(threadId: string, action: AgentTurnEvent | 'reset'): void {
  patchThreadSession(threadId, (state) => ({ llmInspector: llmInspectorReduce(state.llmInspector, action) }));
}

export function isThreadBusy(threadId: string): boolean {
  return sessions.get(threadId)?.store.get().busy === true;
}

export function listBusyThreads(): string[] {
  return [...sessions.values()].filter((session) => session.store.get().busy).map((session) => session.threadId);
}

/** The user's explicit stop — the ONE abort a view may trigger (ADR-0062). */
export function stopThread(threadId: string): void {
  sessions.get(threadId)?.abort?.abort();
}

/**
 * The swap seam. Aborts every matching in-flight turn and drops the sessions; mounted
 * hooks re-resolve fresh ones on the epoch tick. No filter → everything (a DB swap);
 * `appId` → the sessions pinned to that app (app delete); `threadId` → one thread.
 */
export function resetThreadSessions(filter: { appId?: string; threadId?: string } = {}): void {
  for (const session of [...sessions.values()]) {
    if (filter.appId !== undefined && session.store.get().threadAppId !== filter.appId) continue;
    if (filter.threadId !== undefined && session.threadId !== filter.threadId) continue;
    session.abort?.abort();
    session.abort = null;
    sessions.delete(session.threadId);
  }
  registryEpochStore.set(registryEpochStore.get() + 1);
  noteSessionsChanged();
}

/** Subscribe a view to a thread's session; re-resolves after a reset. */
export function useThreadSession(threadId: string): { session: ThreadSession; state: ThreadSessionState } {
  const epoch = useStore(registryEpochStore);
  const session = useMemo(() => getThreadSession(threadId), [threadId, epoch]);
  const subscribe = useCallback(
    (listener: () => void) => {
      session.subscribers += 1;
      const unsubscribe = session.store.subscribe(listener);
      return () => {
        session.subscribers -= 1;
        unsubscribe();
      };
    },
    [session],
  );
  const state = useSyncExternalStore(subscribe, session.store.get, session.store.get);
  return { session, state };
}

export function useSessionsChanged(): number {
  return useStore(sessionsChangedStore);
}
