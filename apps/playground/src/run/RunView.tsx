// RunView — the star. SnugAppFrame center-stage inside the sandbox chrome:
// capability-reveal header (announce upgrades it), the Inspector rail ("watch it
// think"), a chat rail to keep talking to the agent, budget-exhausted reset, the
// navigation cutoff error state, live theme, and the .sqlite export moment.
//
// This module is the heavy chunk (runner + sql.js driver) — it loads lazily.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { createDbDriver, type SnugDbDriver } from '@snugprotocol/db';
import { SnugAppFrame, type RunnerHost } from '@snugprotocol/runner';

import { createAppTransport } from '../agent/transport.js';
import { useBuilderChat } from '../agent/useBuilderChat.js';
import { getAppMeta, recordAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { libraryForMode } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { toggleTheme, useTheme } from '../state/theme.js';
import { isStarterId, loadStarterHtml } from '../starter/starterApps.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Rail } from '../ui/Rail.js';
import { Sheet } from '../ui/Sheet.js';
import { Skeleton } from '../ui/Skeleton.js';
import { initialRevealState, revealReduce, type RevealState } from './capability.js';
import { downloadBlob, exportDatabase } from './exportDb.js';
import { InspectorPanel } from './InspectorPanel.js';
import { initialInspectorState, inspectorReduce, type InspectorState } from './inspector.js';
import { useMediaQuery } from './useMediaQuery.js';
import { locateWasm } from './wasm.js';
import { ChatLog } from '../views/ChatLog.js';

type HtmlState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'missing' };

type RailTab = 'inspector' | 'chat';

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
  const [railTab, setRailTab] = useState<RailTab>('inspector');
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 760px)');
  const controlsRef = useRef<RunnerHost | null>(null);
  const chat = useBuilderChat(`run-${id}`);

  // Identity seams — captured per app id (SnugAppFrame mount-captures them via key).
  const transport = useMemo(() => createAppTransport(mode, provider), [mode, provider]);
  const dbRef = useRef<SnugDbDriver | null>(null);
  if (dbRef.current === null) dbRef.current = createDbDriver({ locateWasm });
  const db = dbRef.current;
  useEffect(
    () => () => {
      void dbRef.current?.close();
      dbRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setHtmlState({ phase: 'loading' });
    const load = isStarterId(id) ? loadStarterHtml(id) : libraryForMode(mode).getHtml(id);
    load
      .then((html) => {
        if (cancelled) return;
        setHtmlState(html === undefined ? { phase: 'missing' } : { phase: 'ready', html });
      })
      .catch(() => {
        if (!cancelled) setHtmlState({ phase: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

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
    setFrameEpoch((epoch) => epoch + 1);
  }, []);

  const meta = reveal.phase === 'live' ? reveal.meta : undefined;
  const stageStyle = { '--app-color': meta?.iconColor ?? 'var(--ember)' } as CSSProperties;

  const railContent = (
    <>
      <div className="seg" role="group" aria-label="rail tabs" style={{ margin: '0 0 var(--space-3)' }}>
        <button type="button" aria-pressed={railTab === 'inspector'} onClick={() => setRailTab('inspector')}>
          inspector
        </button>
        <button type="button" aria-pressed={railTab === 'chat'} onClick={() => setRailTab('chat')}>
          chat
        </button>
      </div>
      {railTab === 'inspector' ? (
        <InspectorPanel entries={inspector.entries} />
      ) : (
        <RailChat
          messages={chat.messages}
          activity={chat.activity}
          busy={chat.busy}
          onSend={chat.send}
          onStop={chat.stop}
        />
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
          {htmlState.phase === 'loading' ? (
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
              key={`${id}:${mode}:${frameEpoch}`}
              html={htmlState.html}
              transport={transport}
              budgetKey={`app:${id}`}
              db={db}
              dbNamespace={id}
              theme={theme}
              title={meta?.displayName ?? 'Snug app'}
              controlsRef={controlsRef}
              onAnnounce={onAnnounce}
              onFrame={(direction, frame) => dispatchFrame({ direction, frame })}
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
  activity: string | undefined;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/** Compact chat inside the rail — keep talking to the agent about the app. */
function RailChat({ messages, activity, busy, onSend, onStop }: RailChatProps): ReactElement {
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
        <ChatLog messages={messages} activity={activity} />
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
