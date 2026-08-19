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

import { NET_ERROR_CODES, type ConnectionRequirement } from '@snugprotocol/protocol';
import { createAppTransport } from '../agent/transport.js';
import { useBuilderChat, type DataWriteCardState } from '../agent/useBuilderChat.js';
import type { ChatCardState } from '../agent/cards.js';
import { createOpenUrlHandlerFor } from '../state/openUrl.js';
import { createNetHandlerFor } from '../state/net.js';
import { startSidecarLiveForApp, type SidecarSyncState } from '../state/sidecarLive.js';
import {
  connectionWizardRevisionStore,
  isConnectionRepairableNetError,
  openConnectionWizard,
  openConnectionWizardForApp,
  openConnectionWizardForNetError,
} from '../state/connectionWizard.js';
import { useStore } from '../state/store.js';
import { AuthRepairBanner } from './AuthRepairBanner.js';
import { getAppMeta, recordAppMeta, useAppMetaMap } from '../state/appMeta.js';
import { userLibrary } from '../state/library.js';
import { useMode, useProvider } from '../state/mode.js';
import { useTurnMode } from '../state/webllm.js';
import { getUserDb } from '../state/userdb.js';
import { toggleTheme, useTheme } from '../state/theme.js';
import { toggleRailShown, useRailShown } from '../state/railLayout.js';
import { isStarterId, listStarterApps, loadStarterHtml, starterInstallSource } from '../starter/starterApps.js';
import { installStarterConnections, starterDeclarationForStarterId } from '../starter/starterDeclaration.js';
import { installStarterRuntimeContract } from '../starter/starterRuntimeContract.js';
import { installStarterDocs } from '../starter/starterDocs.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Rail } from '../ui/Rail.js';
import { RailDivider } from '../ui/RailDivider.js';
import { Sheet } from '../ui/Sheet.js';
import { Skeleton } from '../ui/Skeleton.js';
import { initialRevealState, revealReduce, type RevealState } from './capability.js';
import { DocsPanel } from './DocsPanel.js';
import { downloadBlob, exportDatabase } from './exportDb.js';
import { RunHeaderActions } from './RunHeaderActions.js';
import { initialLlmInspectorState, llmInspectorReduce, type LlmInspectorState } from './llmInspector.js';
import { ThinkPanel } from './ThinkPanel.js';
import { VersionsPanel } from './VersionsPanel.js';
import { initialInspectorState, inspectorReduce, type InspectorState } from './inspector.js';
import { useMediaQuery } from './useMediaQuery.js';
import { locateWasm } from './wasm.js';
import { ChatLog } from '../views/ChatLog.js';

type HtmlState = { phase: 'loading' } | { phase: 'ready'; html: string } | { phase: 'missing' };

// 'inspector' is the LLM round-trip surface, composed by ThinkPanel. It briefly also
// showed an app↔host frame timeline; TASK-20260813 AC11 removed that view as noise
// (structure-only rows with no values read as neither debugging nor narrative).
//
// The frame FEED (inspector.ts, value-blind and byte-locked) is still wired below and
// must stay: `inspector.inFlight` drives the app-frame "thinking" pulse and
// `inspector.sawDbOp` gates the export button. Only its rendering was dropped.
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
  // Whether the "watch it think" rail is shown (AC6). Global, like the theme — it is a
  // workspace preference, not a property of any one app.
  const railShown = useRailShown();
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
    // Provider-lane failures reuse the SAME repairable-code CTA as app-runtime net
    // errors (TASK-20260815 AC5) — one mapping, code-keyed, M12 filter included.
    onProviderNetError: (appId, code) => {
      if (isConnectionRepairableNetError(code)) setNetAuthError({ appId, code });
    },
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

  // Linked-device history-sync state for the header indicator (ADR-0037 §4).
  const [sidecarSync, setSidecarSync] = useState<SidecarSyncState | undefined>(undefined);

  // THE LIVE PUMP (ADR-0034 §2): while THIS view has an app with an approved
  // sidecar-symbolic-host connection mounted, long-poll the helper's hint stream through
  // the governed executor and ring `notifyEvent('connection-event', …)` into the frame.
  // `controlsRef.current` is read PER EMIT, so a frame remount (frameEpoch bump) needs no
  // pump restart — the ref always points at the live host, and the destroyed host's
  // `post()` drops anything late. The pump itself is epoch-tokened, so StrictMode's
  // mount→unmount→remount never runs two loops against one cursor.
  useEffect(() => {
    if (isStarterId(id)) return; // a starter is uninstalled by definition — no connection row
    let cancelled = false;
    let stopPump: (() => void) | undefined;
    void startSidecarLiveForApp(
      id,
      (event, data) => controlsRef.current?.notifyEvent(event, data),
      // The header's sync feed (ADR-0037 §4): pump-reported, session-scoped like every
      // store write after an await — a late report from a superseded mount must not paint
      // onto the next app's header.
      (state) => {
        if (!cancelled) setSidecarSync(state);
      },
    ).then((stop) => {
      if (cancelled) stop();
      else stopPump = stop;
    });
    return () => {
      cancelled = true;
      stopPump?.();
      setSidecarSync(undefined);
    };
  }, [id]);

  // Identity seams — captured per app id (SnugAppFrame mount-captures them via key).
  // onLlmEvent is stable (useCallback with [] deps), so threading it here does not
  // rebuild the transport on every render. This is what makes an APP's LLM turn —
  // e.g. a Chess move — visible in the LLM surface alongside the builder's turns.
  // `id` is threaded so the transport can read this app's runtime contract (ADR-0018).
  // It is a memo dep for correctness on app-to-app navigation; the contract itself is
  // read PER SEND inside the transport, so an edit or revert needs no rebuild here
  // (fold F-M1 — there is no contentEpoch dependency and there does not need to be).
  const transport = useMemo(
    () => createAppTransport(mode, provider, onLlmEvent, id, onTurnStart),
    [mode, provider, onLlmEvent, id, onTurnStart],
  );
  // The envelope net capability (AL-03): a value-blind NetHandler the runner routes
  // net-request frames to. The executor (in state/net.ts) reads the app's frozen host
  // ceiling + credentials from the page user DB per use — the runner never sees a token.
  // Starters get no net: an uninstalled starter has no auth spec, and its ephemeral DB
  // would carry none anyway. Installed apps bind net to their own id (host-assigned).
  // AL-04 AC9: auth-repairable net errors surface a host-side connect/re-approve
  // CTA. The mapping is code-keyed — blocked/denied codes surface
  // NOTHING here (offering a connect CTA on an off-ceiling attempt would coach
  // ceiling-widening in direct response to the attack, M12).
  const [netAuthError, setNetAuthError] = useState<{ appId: string; code: string } | null>(null);
  const netHandler = useMemo(
    () =>
      isStarterId(id)
        ? undefined
        : createNetHandlerFor({
            onNetError: (appId, code) => {
              if (isConnectionRepairableNetError(code)) setNetAuthError({ appId, code });
            },
          }),
    [id],
  );
  const netProps: { net: NetHandler; netAppId: string } | Record<string, never> =
    netHandler !== undefined ? { net: netHandler, netAppId: id } : {};
  // The open-url capability (ADR-0038 D5): installed apps only — a read-only starter
  // keeps the flag false, so its copy-the-link fallback renders instead of a dialog a
  // browse session should never see. Host-assigned id, same rule as net.
  const openUrlHandler = useMemo(() => (isStarterId(id) ? undefined : createOpenUrlHandlerFor(id)), [id]);
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
  /**
   * What THIS starter declares, read from its bundled manifest (§V2-6). The install act
   * is the rung of the trust ladder the user performs themselves, and a rung taken
   * without knowing what it carries is a surprise rather than consent. Resolved only on
   * the read-only starter route — once the app is owned, Settings and the CTA are the
   * connection surfaces and repeating this would be noise on every load.
   */
  const [starterDeclaration, setStarterDeclaration] = useState<ConnectionRequirement | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!isStarterId(id)) {
      setStarterDeclaration(undefined);
      return;
    }
    void starterDeclarationForStarterId(id).then((found) => {
      if (!cancelled) setStarterDeclaration(found ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  /**
   * How many connection slots THIS app has (AC9) — the gate for the header's
   * "connections" control.
   *
   * Counts rows regardless of status: an app that is already connected is exactly the
   * case the owner reported as unreachable ("there is no manage-connection button once
   * the connection is established"), and a declared-but-unconnected app needs the same
   * door. Only zero rows means no control.
   *
   * Re-read on `connectionWizardRevisionStore`, which the wizard bumps on every
   * approve/revoke: without that, connecting an app for the first time would leave the
   * header showing nothing until a reload.
   */
  const wizardRevision = useStore(connectionWizardRevisionStore);
  const [connectionSlots, setConnectionSlots] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (!cancelled) setConnectionSlots(db.listConnections(id).length);
    });
    return () => {
      cancelled = true;
    };
  }, [id, wizardRevision]);

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
      // THE COPY (P4-AC3). The app row now exists, so the two-fact vouch can run and the
      // manifest can land as a `declared` row owned by the user. Deliberately AWAITED
      // before navigating: the connection surface on the next screen reads rows, and
      // racing the copy against the route change would render an installed starter as
      // declaring nothing. It writes a requirement, never a credential, and never an
      // approval — see `installStarterConnections`.
      const installedDb = await getUserDb();
      await installStarterConnections(installedDb, entry.id);
      // The starter's authored runtime contract (ADR-0018), copied onto v1 for the same
      // reason and on the same act: a starter is installed rather than built, so no
      // authoring turn ever runs to write one. Failure is a no-op — the app simply runs
      // on the lean generic layers.
      await installStarterRuntimeContract(installedDb, entry.id);
      // The starter's authoring bundle becomes the installed app's wiki seed (ADR-0035):
      // vision/requirements/plan/lessons plus the verbatim build prompt, into
      // `snug_app_docs` where the app-attached chat compounds on them. Absent slugs only —
      // a re-install never clobbers a page the user's own sessions have written. Like the
      // contract copy, every failure path is a no-op: doc-less is a supported state.
      await installStarterDocs(installedDb, entry.id);
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
        <ThinkPanel llm={llmInspector} mode={turnMode} />
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
            onDirectiveConnect={() => void openConnectionWizardForApp(id, 'directive')}
            // The v4 card opens the wizard on the EXACT persisted (appId, slot) rather
            // than re-deriving "which connection did they mean" from the app id.
            onConnectionConnect={(connection) =>
              openConnectionWizard({ appId: connection.appId, slot: connection.slot, source: 'directive' })
            }
            onApproveDataWrite={chat.approveDataWrite}
            onDeclineDataWrite={chat.declineDataWrite}
            onSelectCardOption={chat.selectCardOption}
          />
        </>
      )}
    </>
  );

  return (
    <div className="run-layout" style={stageStyle}>
      {/* NetConfirmDialog moved to the App shell (TASK-20260815 AC12): the confirm gate's
          callers now include provider-lane chat turns on other routes. */}
      {/*
        AC5 (ADR-0022 §4): a provider rejecting this app's stored credentials is now
        VISIBLE — additive to the app result (which stays ok:true/401 per contract) and
        distinct from the code-keyed net-ERROR banner below: this one fires on delivered
        401/403s where the executor injected credentials, and its CTA opens the wizard on
        the exact failing (appId, slot). The component filters on appId itself.
      */}
      <AuthRepairBanner appId={id} />
      {netAuthError !== null ? (
        // AC10: "this app wants to connect" is ORDINARY, not a failure — it was
        // arriving in the same alarm red as a rejected credential. Calm surface, ember
        // rule, one clear action. Re-approval after an import is the same shape.
        <div className="connection-note" role="alert" data-testid="net-auth-cta">
          <p className="connection-note-title">
            {netAuthError.code === NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED
              ? 'this connection came with the app — approve it to use it'
              : 'this app needs a connection to go further'}
          </p>
          <p className="connection-note-body">
            {netAuthError.code === NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED
              ? 'It arrived already set up, which is exactly why it needs your review before anything is sent. You approve it field by field.'
              : 'It just tried to reach the network and has nothing approved to reach it with. You review what it wants before any credential is stored.'}
          </p>
          <div className="connection-note-actions">
            <Button
              variant="primary"
              onClick={() => {
                // `openConnectionWizardForNetError` is async (it reads the app's
                // connection rows to pick a slot). Dismiss the banner ONLY on a real
                // open: a Promise is always truthy, so `if (open(...))` here would
                // clear the CTA even when the wizard refused — e.g. because another
                // wizard is already parked — and strand the user with no way back.
                void openConnectionWizardForNetError(netAuthError.appId, netAuthError.code).then((opened) => {
                  if (opened) setNetAuthError(null);
                });
              }}
            >
              {netAuthError.code === NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED
                ? 're-approve this connection'
                : 'connect this app'}
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
            {/*
              The per-APP controls — model, connections, export — live in one component
              so the cluster is testable without a route, a runner and an iframe. The
              theme and rail toggles below stay here: those are workspace preferences,
              not properties of this app.
            */}
            <RunHeaderActions
              appId={id}
              isStarter={isStarterId(id)}
              connectionSlots={connectionSlots}
              canExport={sawDbOp}
              syncState={sidecarSync}
              onManageConnections={() => void openConnectionWizardForApp(id, 'settings')}
              onExport={() => void onExport()}
            />
            <Button variant="ghost" onClick={toggleTheme} aria-label={`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? '☀ light' : '☾ dark'}
            </Button>
            {isMobile ? (
              <Button variant="ghost" onClick={() => setSheetOpen(true)} aria-label="open inspector">
                inspect
              </Button>
            ) : (
              /* AC6: hide/show "watch it think". On by default — the panel is the
                 feature — but it competes with the app for width, so it has to be
                 dismissible. `aria-pressed` makes it a toggle to a screen reader
                 rather than a button that appears to do nothing. */
              <Button
                variant="ghost"
                onClick={toggleRailShown}
                aria-pressed={railShown}
                data-testid="rail-toggle"
                aria-label={`${railShown ? 'hide' : 'show'} watch it think`}
                title={`${railShown ? 'hide' : 'show'} the watch it think panel`}
              >
                {railShown ? '◨ hide' : '◫ think'}
              </Button>
            )}
          </div>
        </header>
        {/*
          The install disclosure (§V2-6). Deliberately states ONLY what installing does
          and does not do: it copies the app, and it connects NOTHING. The declaration
          becomes a prefilled review the user still walks field by field — so the copy
          promises a review and must never read as "installing connects this app".
        */}
        {isStarterId(id) && starterDeclaration !== undefined ? (
          <div
            className="hint"
            data-testid="starter-install-disclosure"
            style={{ margin: 'var(--space-3) var(--space-4) 0' }}
          >
            {/*
              v4 SEATS (P4-AC5): `provider.name` replaces the deleted `providerName`, and
              `declaredApiHosts` now arrives from a strict `connectionRequirementSchema`
              parse. A disclosure still reading the v3 seats would render EMPTY on every
              migrated manifest — no provider, no host, just chrome.

              DELIBERATELY NOT RENDERED: `fields`. The v4 manifest CAN now carry credential
              field definitions, which the v3 proposal structurally could not. Showing "API
              key" here would make a pre-install teaser look like the strong field-by-field
              review and train the user to expect a credential prompt one click later. The
              review happens after approval is sought, in the wizard, with provenance copy.
            */}
            🔌 this starter ships a declared connection to <strong>{starterDeclaration.provider.name}</strong>
            {/* `?? []` since ADR-0023: a LAN-class starter declares no host until the
                user collects its device address, so the teaser names the provider alone. */}
            {(starterDeclaration.declaredApiHosts ?? []).length > 0
              ? ` (${(starterDeclaration.declaredApiHosts ?? []).join(', ')})`
              : ''}
            . installing only copies the app — nothing is connected until you review and approve it yourself.
          </div>
        ) : null}
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
              openUrl={openUrlHandler}
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
      ) : railShown ? (
        // The divider is a SIBLING of the rail, not a child: it has to sit between the
        // stage and the rail in the same flex row to be draggable at the seam (AC4).
        <>
          <RailDivider />
          <Rail title="watch it think">{railContent}</Rail>
        </>
      ) : null}
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
  /**
   * Directive-card mount — the run view always has an appId to attach. It takes NO
   * argument in v4: the requirement was persisted at build time and the card can only
   * ring the doorbell, never propose what is reviewed.
   */
  onDirectiveConnect?: () => void;
  /** The v4 connect card's mount — the persisted (appId, slot) to open the wizard on. */
  onConnectionConnect?: (connection: { appId: string; slot: string }) => void;
  /** The data-write approval card's actions (ADR-0019 D8). */
  onApproveDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
  onDeclineDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
  onSelectCardOption?: (card: ChatCardState, messageId: number, optionId: string) => void;
}

/** Compact chat inside the rail — keep talking to the agent about the app. */
function RailChat({
  messages,
  steps,
  activity,
  busy,
  onSend,
  onStop,
  onDirectiveConnect,
  onConnectionConnect,
  onApproveDataWrite,
  onDeclineDataWrite,
  onSelectCardOption,
}: RailChatProps): ReactElement {
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
        <EmptyState
          glyph="✎"
          title="keep talking"
          lesson="ask about your data (“what did I spend on food?”), change it (“add lunch on Tuesday”), or change the app itself."
        />
      ) : (
        <ChatLog
          messages={messages}
          steps={steps}
          activity={activity}
          busy={busy}
          {...(onApproveDataWrite !== undefined ? { onApproveDataWrite } : {})}
          {...(onDeclineDataWrite !== undefined ? { onDeclineDataWrite } : {})}
          {...(onSelectCardOption !== undefined ? { onSelectCardOption } : {})}
          phase="edit"
          onDirectiveConnect={onDirectiveConnect}
          onConnectionConnect={onConnectionConnect}
        />
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
