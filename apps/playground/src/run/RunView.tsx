// RunView — the star. SnugAppFrame center-stage inside the sandbox chrome:
// capability-reveal header (announce upgrades it), the Inspector rail ("watch it
// think"), a chat rail to keep talking to the agent, budget-exhausted reset, the
// navigation cutoff error state, live theme, and the .sqlite export moment.
//
// This module is the heavy chunk (runner + sql.js driver) — it loads lazily.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AgentRoundTrip } from '@snugprotocol/adapters';
import type { SnugDbDriver } from '@snugprotocol/db';
import { FRAME_TYPES, type Frame } from '@snugprotocol/protocol';
import { SnugAppFrame, type FrameDirection, type RunnerHost } from '@snugprotocol/runner';

import { createAppTransport } from '../agent/transport.js';
import { useBuilderChat } from '../agent/useBuilderChat.js';
import { getAppMeta, recordAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { getUserDb } from '../state/userdb.js';
import { toggleTheme, useTheme } from '../state/theme.js';
import { isStarterId, listStarterApps, loadStarterHtml } from '../starter/starterApps.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Rail } from '../ui/Rail.js';
import { Sheet } from '../ui/Sheet.js';
import { Skeleton } from '../ui/Skeleton.js';
import { initialRevealState, revealReduce, type RevealState } from './capability.js';
import { DocsPanel } from './DocsPanel.js';
import { downloadBlob, exportDatabase } from './exportDb.js';
import { InspectorPanel } from './InspectorPanel.js';
import { LlmInspectorPanel } from './LlmInspectorPanel.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from './llmInspector.js';
import { VersionsPanel } from './VersionsPanel.js';
import { initialInspectorState, inspectorReduce, type InspectorState } from './inspector.js';
import { useMediaQuery } from './useMediaQuery.js';
import { locateWasm } from './wasm.js';
import { ChatLog } from '../views/ChatLog.js';

type HtmlState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'missing' };

// 'inspector' is the bridge/frame timeline (structural only); 'llm' is the round-trip
// inspector (renders prompt bodies). Two separate surfaces on purpose — see llmInspector.ts.
type RailTab = 'chat' | 'inspector' | 'llm' | 'docs' | 'versions';

/** How long after host-ready the header keeps shimmering before falling back to the library name. */
const ANNOUNCE_FALLBACK_MS = 1500;

export default function RunView(): ReactElement {
  const { id = '' } = useParams();
  const mode = useMode();
  const provider = useProvider();
  const theme = useTheme();
  useAppMetaMap(); // re-render tiles/header when meta lands

  const [htmlState, setHtmlState] = useState<HtmlState>({ phase: 'loading' });
  const [reveal, dispatchReveal] = useReducer(revealReduce, initialRevealState as RevealState);
  const [inspector, dispatchFrame] = useReducer(inspectorReduce, initialInspectorState as InspectorState);
  const [exhausted, setExhausted] = useState(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const [frameEpoch, setFrameEpoch] = useState(0);
  /** Some apps never announce — after host-ready + a grace period the header stops shimmering. */
  const [readySeen, setReadySeen] = useState(false);
  const [announceTimedOut, setAnnounceTimedOut] = useState(false);
  const [fallbackName, setFallbackName] = useState<string | undefined>(undefined);
  // The chat IS the app's workbench now: installed apps open on it (the attached
  // conversation with full context); starters keep the inspector front.
  const [railTab, setRailTab] = useState<RailTab>(isStarterId(id) ? 'inspector' : 'chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 760px)');
  const controlsRef = useRef<RunnerHost | null>(null);
  /** Bumped when a chat edit or revert lands a new version — reloads html + frame. */
  const [contentEpoch, setContentEpoch] = useState(0);
  // Threads: the stable per-app thread (`app:<id>`) is the main line; extra threads
  // (`thr-<uuid>`, app_id set on the row) let the user branch without losing the
  // bootstrap context. All of them pin artifact writes to THIS app (F9).
  const [threadOverride, setThreadOverride] = useState<string | undefined>(undefined);
  const threadId = threadOverride ?? `app:${id}`;
  const [appThreads, setAppThreads] = useState<Array<{ threadId: string; title?: string }>>([]);
  // The LLM inspector's feed. In-memory only (AC14) — this reducer state is the ONLY
  // place round trips live, and it dies with the view.
  const [llmInspector, dispatchRoundTrip] = useReducer(llmInspectorReduce, initialLlmInspectorState as LlmInspectorState);
  const onRoundTrip = useCallback((trip: AgentRoundTrip): void => dispatchRoundTrip(trip), []);
  const chat = useBuilderChat(threadId, {
    ...(isStarterId(id) ? {} : { pinnedAppId: id }),
    onRoundTrip,
  });

  // Thread list for the picker — refreshed when the turn settles (new threads get
  // their row on the first message).
  useEffect(() => {
    if (isStarterId(id) || chat.busy) return;
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const rows = db
        .listThreads()
        .filter((thread) => thread.appId === id || thread.threadId === `app:${id}`)
        .map((thread) => ({
          threadId: thread.threadId,
          ...(thread.title !== undefined ? { title: thread.title } : {}),
        }));
      setAppThreads(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [id, chat.busy, threadId]);

  // A chat edit for this app landed a new version → reload the code and remount.
  useEffect(() => {
    if (chat.lastArtifact?.artifactId === id && chat.lastArtifact.version !== undefined) {
      setContentEpoch((epoch) => epoch + 1);
      setFrameEpoch((epoch) => epoch + 1);
    }
  }, [chat.lastArtifact, id]);

  // Identity seams — captured per app id (SnugAppFrame mount-captures them via key).
  const transport = useMemo(() => createAppTransport(mode, provider), [mode, provider]);
  // The db driver is the SHARED user DB's materialized face (ADR-0010) — never closed
  // here; it lives as long as the page. App data lands as native app_* tables.
  const [db, setDb] = useState<SnugDbDriver | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((userDb) => {
      if (!cancelled) setDb(userDb.driver);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHtmlState({ phase: 'loading' });
    setReadySeen(false);
    setAnnounceTimedOut(false);
    const load = isStarterId(id) ? loadStarterHtml(id) : userLibrary().getHtml(id);
    load
      .then((html) => {
        if (cancelled) return;
        setHtmlState(html === undefined ? { phase: 'missing' } : { phase: 'ready', html });
      })
      .catch(() => {
        if (!cancelled) setHtmlState({ phase: 'missing' });
      });
    // Library display name — the header's fallback when the app never announces.
    if (isStarterId(id)) {
      setFallbackName(listStarterApps().find((starter) => starter.id === id)?.name);
    } else {
      setFallbackName(undefined);
      userLibrary()
        .list()
        .then((entries) => {
          if (!cancelled) setFallbackName(entries.find((entry) => entry.id === id)?.displayName);
        })
        .catch(() => {
          /* fallback name is best-effort */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [id, contentEpoch]);

  // Capability reveal has a floor: host-ready seen but no announce after the grace
  // period → show the library name in plain style instead of shimmering forever.
  useEffect(() => {
    if (!readySeen || reveal.phase === 'live') return;
    const timer = setTimeout(() => setAnnounceTimedOut(true), ANNOUNCE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [readySeen, reveal.phase]);

  const onFrame = useCallback((direction: FrameDirection, frame: Frame): void => {
    dispatchFrame({ direction, frame });
    if (direction === 'outbound' && frame.type === FRAME_TYPES.hostReady) setReadySeen(true);
  }, []);

  // Capability reveal → persist announce metadata for the hub's gradient tiles.
  const onAnnounce = useCallback(
    (frame: Parameters<typeof revealReduce>[1]): void => {
      dispatchReveal(frame);
      recordAppMeta(id, {
        displayName: frame.displayName,
        ...(frame.description !== undefined ? { description: frame.description } : {}),
        ...(frame.iconEmoji !== undefined ? { iconEmoji: frame.iconEmoji } : {}),
        ...(frame.iconColor !== undefined ? { iconColor: frame.iconColor } : {}),
      });
    },
    [id],
  );

  // First observed db op → remember it (gates the export button across visits).
  const sawDbOp = inspector.sawDbOp || getAppMeta(id)?.usesDb === true;
  useEffect(() => {
    if (inspector.sawDbOp) recordAppMeta(id, { usesDb: true });
  }, [inspector.sawDbOp, id]);

  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const onExport = useCallback(async (): Promise<void> => {
    if (db === null) return;
    setExportError(undefined);
    const result = await exportDatabase(db, id);
    if (!result.ok) {
      setExportError(result.message);
      return;
    }
    const name = reveal.phase === 'live' ? reveal.meta.displayName : 'snug-app';
    downloadBlob(result.blob, `${name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'snug-app'}.sqlite`);
  }, [db, id, reveal]);

  const onReset = useCallback((): void => {
    setExhausted(false);
    controlsRef.current?.reset(true);
  }, []);

  const onReload = useCallback((): void => {
    setNavigatedAway(false);
    setExhausted(false);
    setReadySeen(false);
    setAnnounceTimedOut(false);
    setFrameEpoch((epoch) => epoch + 1);
  }, []);

  const meta = reveal.phase === 'live' ? reveal.meta : undefined;
  const stageStyle = { '--app-color': meta?.iconColor ?? 'var(--ember)' } as CSSProperties;

  const railContent = (
    <>
      <div className="seg" role="group" aria-label="rail tabs" style={{ margin: '0 0 var(--space-3)' }}>
        <button type="button" aria-pressed={railTab === 'chat'} onClick={() => setRailTab('chat')}>
          chat
        </button>
        <button type="button" aria-pressed={railTab === 'inspector'} onClick={() => setRailTab('inspector')}>
          inspector
        </button>
        <button type="button" aria-pressed={railTab === 'llm'} onClick={() => setRailTab('llm')}>
          llm
        </button>
        {!isStarterId(id) ? (
          <>
            <button type="button" aria-pressed={railTab === 'docs'} onClick={() => setRailTab('docs')}>
              docs
            </button>
            <button type="button" aria-pressed={railTab === 'versions'} onClick={() => setRailTab('versions')}>
              versions
            </button>
          </>
        ) : null}
      </div>
      {railTab === 'inspector' ? (
        <InspectorPanel entries={inspector.entries} />
      ) : railTab === 'llm' ? (
        <LlmInspectorPanel state={llmInspector} />
      ) : railTab === 'docs' ? (
        <DocsPanel appId={id} refreshToken={chat.knowledgeEpoch} />
      ) : railTab === 'versions' ? (
        <VersionsPanel
          appId={id}
          refreshToken={contentEpoch}
          onReverted={() => {
            setContentEpoch((epoch) => epoch + 1);
            setFrameEpoch((epoch) => epoch + 1);
          }}
        />
      ) : (
        <>
          {!isStarterId(id) && (appThreads.length > 1 || threadOverride !== undefined) ? (
            <div className="thread-picker" role="group" aria-label="conversation threads">
              <select
                value={threadId}
                aria-label="switch thread"
                onChange={(event) => {
                  const next = event.target.value;
                  setThreadOverride(next === `app:${id}` ? undefined : next);
                }}
              >
                {appThreads.map((thread) => (
                  <option key={thread.threadId} value={thread.threadId}>
                    {thread.threadId === `app:${id}` ? 'main thread' : (thread.title ?? thread.threadId)}
                  </option>
                ))}
                {appThreads.every((thread) => thread.threadId !== threadId) ? (
                  <option value={threadId}>new thread</option>
                ) : null}
              </select>
              <Button variant="ghost" onClick={() => setThreadOverride(`thr-${crypto.randomUUID()}`)} title="start a fresh thread about this app">
                + new
              </Button>
            </div>
          ) : !isStarterId(id) ? (
            <div className="thread-picker">
              <span className="thread-picker-label">main thread</span>
              <Button variant="ghost" onClick={() => setThreadOverride(`thr-${crypto.randomUUID()}`)} title="start a fresh thread about this app">
                + new
              </Button>
            </div>
          ) : null}
          <RailChat
            messages={chat.messages}
            steps={chat.steps}
            activity={chat.activity}
            busy={chat.busy}
            onSend={chat.send}
            onStop={chat.stop}
          />
        </>
      )}
    </>
  );

  return (
    <div className="run-layout" style={stageStyle}>
      <div className="run-stage">
        <header className="run-header">
          {meta !== undefined ? (
            <div className="run-identity run-header-reveal">
              <span className="run-emoji" aria-hidden="true">
                {meta.iconEmoji ?? '⬡'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="run-name">{meta.displayName}</div>
                {meta.description !== undefined ? <div className="run-desc">{meta.description}</div> : null}
              </div>
            </div>
          ) : announceTimedOut ? (
            // The app never announced — plain library-name header, no shimmer, and no
            // reveal animation (that stays reserved for genuine announces).
            <div className="run-identity">
              <span className="run-emoji" aria-hidden="true">
                ⬡
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="run-name">{fallbackName ?? 'snug app'}</div>
              </div>
            </div>
          ) : (
            <div className="run-identity">
              <Skeleton width="40px" height="40px" />
              <div>
                <Skeleton width="140px" height="1.1rem" />
                <div className="run-desc" style={{ marginTop: 4 }}>
                  connecting…
                </div>
              </div>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {sawDbOp ? (
              <Button onClick={() => void onExport()} title="download this app’s database as a real .sqlite file">
                export .sqlite
              </Button>
            ) : null}
            <Button variant="ghost" onClick={toggleTheme} aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? '☀ light' : '☾ dark'}
            </Button>
            {isMobile ? (
              <Button variant="ghost" onClick={() => setSheetOpen(true)} aria-label="open inspector">
                inspect
              </Button>
            ) : null}
          </div>
        </header>
        {exportError !== undefined ? (
          <div className="error-note" style={{ margin: 'var(--space-3) var(--space-4) 0' }} role="alert">
            export failed — {exportError}
          </div>
        ) : null}

        <div className={`frame-wrap${inspector.inFlight > 0 ? ' thinking' : ''}`} data-testid="frame-wrap">
          {htmlState.phase === 'loading' || db === null ? (
            <div className="run-overlay">
              <Skeleton width="60%" height="1.25rem" />
              <Skeleton width="40%" height="1rem" />
            </div>
          ) : htmlState.phase === 'missing' ? (
            <div className="run-overlay">
              <EmptyState glyph="◌" title="app not found" lesson="it may live in the other mode — check settings, or build a new one." action={<Link to="/" className="btn">back to your apps</Link>} />
            </div>
          ) : (
            <SnugAppFrame
              // provider is part of the identity: a BYOK provider switch must remount
              // the frame so the mount-captured transport can't go stale (Gate-5).
              key={`${id}:${mode}:${provider}:${frameEpoch}`}
              html={htmlState.html}
              transport={transport}
              budgetKey={`app:${id}`}
              db={db}
              dbNamespace={id}
              theme={theme}
              title={meta?.displayName ?? 'Snug app'}
              controlsRef={controlsRef}
              onAnnounce={onAnnounce}
              onFrame={onFrame}
              onBudgetExhausted={() => setExhausted(true)}
              onNavigatedAway={() => setNavigatedAway(true)}
            />
          )}
          {exhausted && !navigatedAway ? (
            <div className="run-overlay">
              <EmptyState
                glyph="⌁"
                title="the agent kept answering off-script"
                lesson="three unparseable replies in a row — reset clears the strike budget and reloads the app."
                action={
                  <Button variant="primary" onClick={onReset}>
                    reset the app
                  </Button>
                }
              />
            </div>
          ) : null}
          {navigatedAway ? (
            <div className="run-overlay">
              <EmptyState
                glyph="⛌"
                title="this app tried to leave"
                lesson="it navigated away from its sandbox, so the connection was permanently cut."
                action={
                  <Button variant="primary" onClick={onReload}>
                    reload the app
                  </Button>
                }
              />
            </div>
          ) : null}
        </div>
      </div>

      {isMobile ? (
        <Sheet title="watch it think" open={sheetOpen} onClose={() => setSheetOpen(false)}>
          {railContent}
        </Sheet>
      ) : (
        <Rail title="watch it think">{railContent}</Rail>
      )}
    </div>
  );
}

interface RailChatProps {
  messages: ReturnType<typeof useBuilderChat>['messages'];
  steps: ReturnType<typeof useBuilderChat>['steps'];
  activity: string | undefined;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/** Compact chat inside the rail — keep talking to the agent about the app. */
function RailChat({ messages, steps, activity, busy, onSend, onStop }: RailChatProps): ReactElement {
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    if (draft.trim() === '') return;
    onSend(draft);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minHeight: '100%' }}>
      {messages.length === 0 ? (
        <EmptyState glyph="✎" title="keep talking" lesson="ask for tweaks — the agent can rebuild the app from here." />
      ) : (
        <ChatLog messages={messages} steps={steps} activity={activity} />
      )}
      <div className="composer" style={{ position: 'static', padding: 0, background: 'none' }}>
        <textarea
          rows={1}
          value={draft}
          placeholder="ask for a change…"
          aria-label="message the agent"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <Button variant="danger" onClick={onStop}>
            stop
          </Button>
        ) : (
          <Button variant="primary" onClick={submit} disabled={draft.trim() === ''}>
            send
          </Button>
        )}
      </div>
    </div>
  );
}
