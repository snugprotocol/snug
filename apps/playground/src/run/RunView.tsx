// RunView — the star. SnugAppFrame center-stage inside the sandbox chrome:
// capability-reveal header (announce upgrades it), the Inspector rail ("watch it
// think"), a chat rail to keep talking to the agent, budget-exhausted reset, the
// navigation cutoff error state, live theme, and the .sqlite export moment.
//
// This module is the heavy chunk (runner + sql.js driver) — it loads lazily.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { AgentTurnEvent } from '@snugprotocol/adapters';
import { createDbDriver, createMemoryBackend, type SnugDbDriver } from '@snugprotocol/db';
import { FRAME_TYPES, type Frame } from '@snugprotocol/protocol';
import { SnugAppFrame, type FrameDirection, type NetHandler, type RunnerHost } from '@snugprotocol/runner';

import type { AuthWizardDirective } from '@snugprotocol/protocol';
import { createAppTransport } from '../agent/transport.js';
import { useBuilderChat } from '../agent/useBuilderChat.js';
import { createNetHandlerFor } from '../state/net.js';
import { netErrorCta, openWizard, openWizardForNetError } from '../state/wizard.js';
import { NetConfirmDialog } from './NetConfirmDialog.js';
import { getAppMeta, recordAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { useTurnMode } from '../state/webllm.js';
import { getUserDb } from '../state/userdb.js';
import { toggleTheme, useTheme } from '../state/theme.js';
import { isStarterId, listStarterApps, loadStarterHtml, starterInstallSource } from '../starter/starterApps.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Rail } from '../ui/Rail.js';
import { Sheet } from '../ui/Sheet.js';
import { Skeleton } from '../ui/Skeleton.js';
import { initialRevealState, revealReduce, type RevealState } from './capability.js';
import { DocsPanel } from './DocsPanel.js';
import { downloadBlob, exportDatabase } from './exportDb.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from './llmInspector.js';
import { ThinkPanel } from './ThinkPanel.js';
import { VersionsPanel } from './VersionsPanel.js';
import { initialInspectorState, inspectorReduce, type InspectorState } from './inspector.js';
import { useMediaQuery } from './useMediaQuery.js';
import { locateWasm } from './wasm.js';
import { ChatLog } from '../views/ChatLog.js';

type HtmlState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'missing' };

// 'inspector' is now ONE surface (AC10): the LLM round-trip section above the
// bridge/frame timeline, composed by ThinkPanel. The two FEEDS remain separate modules
// with opposite rules — llmInspector.ts renders bodies, inspector.ts is value-blind
// (AC11 locks it byte-for-byte). Only the presentation merged.
type RailTab = 'chat' | 'inspector' | 'docs' | 'versions';

/**
 * Tab chrome (AC12): a decorative glyph plus the ORIGINAL label as the accessible
 * name. `aria-label` is what a screen reader announces and what tests query by;
 * `title` is only the hover tooltip — a title alone is not an accessible name.
 */
const RAIL_TAB_ICONS: Record<RailTab, string> = {
  chat: '✎',
  inspector: '◍',
  docs: '✧',
  versions: '⧉',
};

/** How long after host-ready the header keeps shimmering before falling back to the library name. */
const ANNOUNCE_FALLBACK_MS = 1500;

export { starterInstallSource };

/** Just enough of a thread row for the main-thread rule — keeps this testable and pure. */
interface ThreadRowLike {
  threadId: string;
  appId?: string;
}

/**
 * Which thread is the app's MAIN conversation (AC19/AC20).
 *
 * The old rule was "always `app:<id>`", which is why a freshly built app opened an empty
 * chat: the build history lives in the builder's `thr-<uuid>` thread, and nothing ever
 * pointed `app:<id>` at it.
 *
 * R5 — this runs on EVERY app open, so the answer must be deterministic. `listThreads()`
 * orders by `updated_at DESC` and rows written in the same tick tie, so list order alone
 * can flip between runs (the previous task hit exactly that flake). The rule is therefore
 * a total order with an explicit final tie-break:
 *
 *   1. the thread carrying the app's PINNED BOOTSTRAP turn — the turn that produced v1
 *      (useBuilderChat pins both sides of it), i.e. the real build conversation;
 *   2. else `app:<id>` IF it actually holds messages — never regress an app whose
 *      conversation already lives there;
 *   3. else the only other thread with messages;
 *   4. else `app:<id>`, the fresh-start default.
 *
 * Ties inside (1) and (3) break on `threadId` lexicographically — a stable property of
 * the row, never its position in the list.
 */
function resolveMainThread(
  db: { listChatMessages: (threadId: string) => Array<{ pinned: boolean }> },
  appId: string,
  threads: readonly ThreadRowLike[],
): string {
  const synthetic = `app:${appId}`;
  const withMessages: string[] = [];
  const withBootstrap: string[] = [];
  for (const thread of threads) {
    const messages = db.listChatMessages(thread.threadId);
    if (messages.length === 0) continue;
    withMessages.push(thread.threadId);
    if (messages.some((message) => message.pinned)) withBootstrap.push(thread.threadId);
  }
  const first = (ids: readonly string[]): string | undefined => [...ids].sort()[0];

  // (1) the pinned bootstrap turn is the strongest signal of "this built the app".
  if (withBootstrap.includes(synthetic)) return synthetic;
  const bootstrap = first(withBootstrap);
  if (bootstrap !== undefined) return bootstrap;
  // (2) no pin anywhere — an app whose conversation already sits on app:<id> keeps it.
  if (withMessages.includes(synthetic)) return synthetic;
  // (3) otherwise the (only, or lexicographically first) thread that has anything to say.
  return first(withMessages) ?? synthetic;
}

export default function RunView(): ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const mode = useMode();
  const provider = useProvider();
  // The run-rail panels' copy depends on where turns EXECUTE — the effective turn
  // mode with the webllm brain override applied, never the raw mode (review F3).
  const turnMode = useTurnMode();
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
  // conversation with full context). A starter has NO chat tab at all (AC18) — the
  // chat rail is exactly where a starter edit used to fork a hidden app — so it opens
  // on the inspector and can never land on 'chat'.
  const [railTabRaw, setRailTab] = useState<RailTab>(isStarterId(id) ? 'inspector' : 'chat');
  // Belt and braces for AC18: even if some future path sets 'chat' for a starter (a
  // stale state across an id change, a restored tab), the starter renders the inspector.
  const railTab: RailTab = isStarterId(id) && railTabRaw === 'chat' ? 'inspector' : railTabRaw;
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 760px)');
  const controlsRef = useRef<RunnerHost | null>(null);
  /** Bumped when a chat edit or revert lands a new version — reloads html + frame. */
  const [contentEpoch, setContentEpoch] = useState(0);
  // Threads (AC19/AC20). The MAIN thread is the app's real conversation — usually the
  // builder thread that produced it (`thr-<uuid>` with app_id set), not the synthetic
  // `app:<id>`. Before this, the rail read `app:<id>` unconditionally, so a freshly
  // built app opened an EMPTY chat while its build history sat in a thread with no
  // route to it. Extra threads let the user branch without losing bootstrap context.
  const [threadOverride, setThreadOverride] = useState<string | undefined>(undefined);
  /** Resolved main thread; `undefined` until the DB answers (R5 — never guess early). */
  const [mainThreadId, setMainThreadId] = useState<string | undefined>(undefined);
  const threadId = threadOverride ?? mainThreadId ?? `app:${id}`;
  const [appThreads, setAppThreads] = useState<Array<{ threadId: string; title?: string }>>([]);
  // The LLM inspector's feed. In-memory only (AC14) — this reducer state is the ONLY
  // place round trips live, and it dies with the view.
  const [llmInspector, dispatchRoundTrip] = useReducer(llmInspectorReduce, initialLlmInspectorState as LlmInspectorState);
  const onLlmEvent = useCallback((event: AgentTurnEvent): void => dispatchRoundTrip(event), []);
  const onTurnStart = useCallback((): void => dispatchRoundTrip('reset'), []);
  const chat = useBuilderChat(threadId, {
    ...(isStarterId(id) ? {} : { pinnedAppId: id }),
    onLlmEvent,
    onTurnStart,
  });

  // Thread list for the picker AND the main-thread resolution — refreshed when the turn
  // settles (new threads get their row on the first message).
  useEffect(() => {
    if (isStarterId(id) || chat.busy) return;
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const matching = db
        .listThreads()
        .filter((thread) => thread.appId === id || thread.threadId === `app:${id}`);
      setAppThreads(
        matching.map((thread) => ({
          threadId: thread.threadId,
          ...(thread.title !== undefined ? { title: thread.title } : {}),
        })),
      );
      setMainThreadId(resolveMainThread(db, id, matching));
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
  // onLlmEvent is stable (useCallback with [] deps), so threading it here does not
  // rebuild the transport on every render. This is what makes an APP's LLM turn —
  // e.g. a Chess move — visible in the LLM surface alongside the builder's turns.
  const transport = useMemo(() => createAppTransport(mode, provider, onLlmEvent), [mode, provider, onLlmEvent]);
  // The envelope net capability (AL-03): a value-blind NetHandler the runner routes
  // net-request frames to. The executor (in state/net.ts) reads the app's frozen host
  // ceiling + credentials from the page user DB per use — the runner never sees a token.
  // Starters get no net: an uninstalled starter has no auth spec, and its ephemeral DB
  // would carry none anyway. Installed apps bind net to their own id (host-assigned).
  // AL-04 AC9: auth-repairable net errors surface a host-side connect/re-approve
  // CTA. The mapping is code-keyed (netErrorCta) — blocked/denied codes surface
  // NOTHING here (offering a connect CTA on an off-ceiling attempt would coach
  // ceiling-widening in direct response to the attack, M12).
  const [netAuthError, setNetAuthError] = useState<{ appId: string; code: string } | null>(null);
  const netHandler = useMemo(
    () =>
      isStarterId(id)
        ? undefined
        : createNetHandlerFor({
            onNetError: (appId, code) => {
              if (netErrorCta(code) !== null) setNetAuthError({ appId, code });
            },
          }),
    [id],
  );
  const netProps: { net: NetHandler; netAppId: string } | Record<string, never> =
    netHandler !== undefined ? { net: netHandler, netAppId: id } : {};
  // The db driver is the SHARED user DB's materialized face (ADR-0010) — never closed
  // here; it lives as long as the page. App data lands as native app_* tables.
  //
  // EXCEPT for a read-only starter browse (adversarial review of AL-08, finding 1):
  // an UNINSTALLED starter gets an EPHEMERAL in-memory driver instead. Browsing must
  // leave ZERO trace in the user's file — before this, playing an uninstalled starter
  // materialized orphaned `app_x<hex("starter--…")>__*` tables into the user DB (the
  // kv-orphan leak AL-01's live sweep logged), which then rode along in every export
  // with no matching `snug_apps` row. The memory backend dies with the view; Install
  // makes a real copy whose OWN uuid namespace starts fresh in the user file (the
  // pre-install play data intentionally vanishes — trying is not owning).
  const [db, setDb] = useState<SnugDbDriver | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (isStarterId(id)) {
      const ephemeral = createDbDriver({ backend: createMemoryBackend(), locateWasm });
      setDb(ephemeral);
      return () => {
        cancelled = true;
        setDb(null);
        void ephemeral.close();
      };
    }
    void getUserDb().then((userDb) => {
      if (!cancelled) setDb(userDb.driver);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // AC18: a direct /run/starter--* visit (bookmark, back button, deep link) opens the
  // user's OWN copy when they already installed it — the same install_source identity
  // the hub's shelf uses. Without this, the starter route stays reachable behind the
  // hub's Install control and the chat rail forks a hidden app off a read-only starter.
  /**
   * Install THIS starter into the user's snug file, from inside the run view. Uses the
   * same `userLibrary().save(html, name, install_source)` call the hub uses, so the
   * find-or-create dedup and the DB's partial unique index both still apply — two
   * installs of one starter can never produce two apps. The latch mirrors the hub's:
   * a double-click must not race two saves.
   */
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | undefined>(undefined);
  const installLatch = useRef(false);
  const installThisStarter = useCallback(async (): Promise<void> => {
    if (installLatch.current || !isStarterId(id)) return;
    installLatch.current = true;
    setInstalling(true);
    setInstallError(undefined);
    try {
      const html = await loadStarterHtml(id);
      if (html === undefined) throw new Error('starter not bundled');
      const name = listStarterApps().find((s) => s.id === id)?.name ?? 'starter';
      const entry = await userLibrary().save(html, name, starterInstallSource(id));
      navigate(`/run/${entry.id}`, { replace: true });
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      installLatch.current = false;
      setInstalling(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    if (!isStarterId(id)) return;
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const installed = db.getAppByInstallSource(starterInstallSource(id));
      if (installed !== undefined) navigate(`/run/${installed.appId}`, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

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
      <div className="seg seg-icons" role="group" aria-label="rail tabs" style={{ margin: '0 0 var(--space-3)' }}>
        {/* AC18: no chat tab until the starter is installed. The chat rail is where a
            starter edit forked a hidden app — a read-only starter must not offer it. */}
        {!isStarterId(id) ? <RailTabButton tab="chat" active={railTab} onSelect={setRailTab} /> : null}
        <RailTabButton tab="inspector" active={railTab} onSelect={setRailTab} />
        {!isStarterId(id) ? (
          <>
            <RailTabButton tab="docs" active={railTab} onSelect={setRailTab} />
            <RailTabButton tab="versions" active={railTab} onSelect={setRailTab} />
          </>
        ) : null}
      </div>
      {railTab === 'inspector' ? (
        <ThinkPanel llm={llmInspector} frames={inspector.entries} mode={turnMode} />
      ) : railTab === 'docs' ? (
        <DocsPanel appId={id} refreshToken={chat.knowledgeEpoch} mode={turnMode} />
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
                  // Selecting the main thread clears the override so the resolved
                  // default keeps applying — `app:<id>` is no longer that default (AC20).
                  setThreadOverride(next === (mainThreadId ?? `app:${id}`) ? undefined : next);
                }}
              >
                {appThreads.map((thread) => (
                  <option key={thread.threadId} value={thread.threadId}>
                    {/* AC20: "main thread" NAMES the resolved conversation. It used to be
                        hardcoded to `app:<id>`, so the thread actually holding the build
                        history could never be the main thread by construction. */}
                    {thread.threadId === (mainThreadId ?? `app:${id}`)
                      ? 'main thread'
                      : (thread.title ?? thread.threadId)}
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
            onDirectiveConnect={(directive) => openWizard({ source: 'directive', appId: id, directive })}
          />
        </>
      )}
    </>
  );

  return (
    <div className="run-layout" style={stageStyle}>
      <NetConfirmDialog />
      {netAuthError !== null ? (
        <div className="error-note" role="alert" data-testid="net-auth-cta">
          this app tried to use the network but its connection is not ready ({netAuthError.code}).
          <div className="field-row">
            <Button
              onClick={() => {
                if (openWizardForNetError(netAuthError.appId, netAuthError.code)) setNetAuthError(null);
              }}
            >
              {netErrorCta(netAuthError.code) === 'reapprove' ? 're-approve this connection' : 'connect this app'}
            </Button>
            <Button variant="ghost" onClick={() => setNetAuthError(null)}>
              dismiss
            </Button>
          </div>
        </div>
      ) : null}
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
            {/*
              A starter opens READ-ONLY so it can be tried before it is owned (owner:
              "it should open the starter app without installing and also show Install
              button when opened on the UI"). Installing makes a real copy in the user's
              snug file and navigates there — from that point it versions normally and
              gains the chat tab. The route redirects to the copy if one already exists,
              so this button only ever appears for a starter the user does not have.
            */}
            {isStarterId(id) && installError !== undefined ? (
              <span className="error-note" role="alert" style={{ padding: '2px 8px' }}>
                install failed — {installError}
              </span>
            ) : null}
            {isStarterId(id) ? (
              <Button
                variant="primary"
                data-testid="starter-install"
                disabled={installing}
                onClick={() => void installThisStarter()}
                title="add this starter to your snug file so you can edit it"
              >
                {installing ? 'installing…' : 'install'}
              </Button>
            ) : null}
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
              {...netProps}
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

interface RailTabButtonProps {
  tab: RailTab;
  active: RailTab;
  onSelect: (tab: RailTab) => void;
}

/**
 * One icon tab (AC12). The glyph is `aria-hidden` so a screen reader announces the
 * label ONCE, from `aria-label`; `title` carries the same text as the hover tooltip.
 * Keeping the label as the accessible name is what lets existing tests — and users of
 * assistive tech — still find "chat", "inspector", "docs", "versions".
 */
function RailTabButton({ tab, active, onSelect }: RailTabButtonProps): ReactElement {
  return (
    <button type="button" aria-pressed={active === tab} aria-label={tab} title={tab} onClick={() => onSelect(tab)}>
      <span aria-hidden="true">{RAIL_TAB_ICONS[tab]}</span>
    </button>
  );
}

interface RailChatProps {
  messages: ReturnType<typeof useBuilderChat>['messages'];
  steps: ReturnType<typeof useBuilderChat>['steps'];
  activity: string | undefined;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** AL-04 D9: directive-card mount — the run view always has an appId to attach. */
  onDirectiveConnect?: (directive: AuthWizardDirective) => void;
}

/** Compact chat inside the rail — keep talking to the agent about the app. */
function RailChat({ messages, steps, activity, busy, onSend, onStop, onDirectiveConnect }: RailChatProps): ReactElement {
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
  // The run view always works on an app that already exists, so its status copy is the
  // "adjusting" set, never the first-build one (AC10).
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minHeight: '100%' }}>
      {messages.length === 0 ? (
        <EmptyState glyph="✎" title="keep talking" lesson="ask for tweaks — the agent can rebuild the app from here." />
      ) : (
        <ChatLog messages={messages} steps={steps} activity={activity} busy={busy} phase="edit" onDirectiveConnect={onDirectiveConnect} />
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
