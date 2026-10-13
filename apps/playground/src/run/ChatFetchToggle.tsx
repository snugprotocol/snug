// run/ChatFetchToggle.tsx — *fetch new data first*, beside the run rail's *send*
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-20 and its v2.1 answer T-D Q11; D10, F9).
//
// A `<button aria-pressed>` in RailChat's composer row, before *send*. Shown only when the chat's
// data door is open for the app (it may use access, and its chat brain is one the data lane runs
// on) and at least one live access the chat may use carries `refresh` — the access policy's own
// answer for the chat caller (`refreshableReads`), so the toggle names exactly the apps the fetch
// would ask. Its label is `CHAT_FETCH.first(names)` — the sources a fetch asks by name, the rest
// counted as not asked, every name in the title. Its own data hook re-reads on the access revision,
// on brain changes and — expiry being a clock event that moves no revision (Gate-5 fold P3-10) — at
// the nearest end of an access it read (one timer, never more than a day away). The pressed state is
// RailChat's: the next *send* carries the option, and the turn consumes it only when it opens the
// data door; a thread or app change resets it.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { CHAT_FETCH } from '../access/copy.js';
import { chatBrainRoute, chatDoorOpen } from '../access/egress.js';
import { accessDeps, readerGeneration, useAccessRevision } from '../access/grants.js';
import { refreshableReads } from '../access/service.js';
import { useAppProvider } from '../state/appModel.js';
import { useByokKeyPresence, useMode, useProvider } from '../state/mode.js';
import { useBrain } from '../state/webllm.js';
import { Button } from '../ui/Button.js';
import { appMayUseAccess } from './appCapabilityRules.js';

export interface ChatFetchToggleProps {
  appId: string;
  pressed: boolean;
  onPress: () => void;
  /** While a turn is in flight. */
  disabled?: boolean;
}

const sameNames = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name, i) => name === b[i]);

/** The longest the toggle waits before reading again — an access ending further out still gets nearer (and a timer's own limit is far below a long `until`). */
const RECHECK_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * The apps the chat beside `appId` could ask to fetch new data first, now — one name per source, in
 * the order the fetch asks them; none when the chat door is shut for the app. Re-read whenever
 * access changes or the brain the chat would use does, and when the nearest access it read ends.
 */
function useChatFetchSources(appId: string): readonly string[] {
  const revision = useAccessRevision();
  const brain = useBrain();
  const mode = useMode();
  const provider = useProvider();
  const keys = useByokKeyPresence();
  const pinned = useAppProvider(appId);
  /** Bumped by the expiry timer — the read runs again when the nearest access it read ends. */
  const [tick, setTick] = useState(0);
  const [names, setNames] = useState<readonly string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (next: readonly string[]): void => {
      if (!cancelled) setNames((current) => (sameNames(current, next) ? current : next));
    };
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        if (!appMayUseAccess(appId) || !chatDoorOpen(chatBrainRoute(db, appId))) return settle([]);
        // The chat caller as the turn will build it: the policy reads its app and the open view's generation, never the thread.
        const liveGeneration = readerGeneration(appId);
        const now = accessDeps().now();
        const rows = refreshableReads(db, { kind: 'chat', appId, threadId: '', ...(liveGeneration !== undefined ? { liveGeneration } : {}) }, now);
        const bySource = new Map<string, string>();
        for (const row of rows) if (!bySource.has(row.grant.sourceAppId)) bySource.set(row.grant.sourceAppId, row.sourceName);
        settle([...bySource.values()]);
        // ONE timer at the nearest end of an access read here: past it, the fetch would not ask that source (P3-10).
        const ends = rows.flatMap((row) => (row.expiresAt === undefined ? [] : [Date.parse(row.expiresAt) - now])).filter((left) => left > 0);
        if (ends.length > 0) timer = setTimeout(() => setTick((value) => value + 1), Math.min(RECHECK_MAX_MS, ...ends));
      })
      .catch(() => settle([])); // the file is not open (a swap in flight): nothing to offer
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [appId, revision, brain, mode, provider, keys, pinned, tick]);
  return names;
}

export function ChatFetchToggle({ appId, pressed, onPress, disabled = false }: ChatFetchToggleProps): ReactElement | null {
  const names = useChatFetchSources(appId);
  if (names.length === 0) return null;
  // Pressed reads as the solid button beside a quiet one — the state itself is `aria-pressed`.
  return (
    <Button variant={pressed ? 'default' : 'ghost'} className="chat-fetch-toggle" aria-pressed={pressed} title={CHAT_FETCH.firstNamed(names)} disabled={disabled} onClick={onPress}>
      {CHAT_FETCH.first(names)}
    </Button>
  );
}
