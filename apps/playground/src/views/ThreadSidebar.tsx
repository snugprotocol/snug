// ThreadSidebar — every conversation in the user file, on the build page
// (TASK-20260903-build-thread-continuity AC5/AC5b, ADR-0062).
//
// Before this, /build knew exactly one thread id and `listThreads()` had a single caller
// in the whole playground (RunView's picker), so a conversation you left was unreachable
// from the build page even though it survived in the DB. The list is the DB's — build
// threads and run-view threads alike — joined with the in-memory session registry for
// the live badge, and re-read whenever any turn starts or settles (a new thread gets its
// row on its first message). The ACTIVE thread may not have a row yet: it shows as a
// pending "new conversation" until something is said in it.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { isThreadBusy, resetThreadSessions, useSessionsChanged } from '../agent/threadSessions.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';

interface ThreadRow {
  threadId: string;
  label: string;
}

export interface ThreadSidebarProps {
  activeThreadId: string;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}

/** The label rule: title → the pinned app's display name → a neutral word. Never the raw id. */
function labelFor(
  db: { getApp(appId: string): { displayName: string } | undefined },
  thread: { threadId: string; appId?: string; title?: string },
): string {
  if (thread.title !== undefined && thread.title.trim() !== '') return thread.title;
  if (thread.appId !== undefined) {
    const app = db.getApp(thread.appId);
    if (app !== undefined && app.displayName !== '') return app.displayName;
  }
  return 'conversation';
}

export function ThreadSidebar({ activeThreadId, onSelect, onNew }: ThreadSidebarProps): ReactElement {
  const sessionsChanged = useSessionsChanged();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  // Collapsed by default on a phone-width viewport; the summary is hidden by CSS above
  // the mobile breakpoint, where the list is simply the left column.
  const [open, setOpen] = useState(() => (globalThis.innerWidth || 1280) > 760);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      setThreads(db.listThreads().map((thread) => ({ threadId: thread.threadId, label: labelFor(db, thread) })));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionsChanged, refresh, activeThreadId]);

  const rows: Array<ThreadRow & { pending: boolean }> = threads.some((t) => t.threadId === activeThreadId)
    ? threads.map((t) => ({ ...t, pending: false }))
    : [{ threadId: activeThreadId, label: 'new conversation', pending: true }, ...threads.map((t) => ({ ...t, pending: false }))];

  const commitRename = useCallback(
    async (threadId: string, name: string): Promise<void> => {
      const trimmed = name.trim().slice(0, 80);
      setRenaming(undefined);
      if (trimmed === '') return;
      const db = await getUserDb();
      // upsertThread COALESCEs, so a title write never clears the app pin.
      db.upsertThread(threadId, { title: trimmed });
      setRefresh((n) => n + 1);
    },
    [],
  );

  const confirmDelete = useCallback(
    async (threadId: string): Promise<void> => {
      setConfirming(undefined);
      // Drop the in-memory session first (aborting any turn still running in it), then
      // the rows. Never the app the thread is pinned to (D4).
      resetThreadSessions({ threadId });
      const db = await getUserDb();
      db.deleteThread(threadId);
      if (threadId === activeThreadId) {
        // listThreads() is newest-first; fall back to a fresh thread when nothing is left.
        const next = db.listThreads()[0];
        if (next !== undefined) onSelect(next.threadId);
        else onNew();
      }
      setRefresh((n) => n + 1);
    },
    [activeThreadId, onNew, onSelect],
  );

  return (
    <aside className="thread-sidebar" aria-label="conversations">
      <details className="thread-sidebar-details" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
        <summary className="thread-sidebar-summary">conversations · {rows.length}</summary>
        <div className="thread-sidebar-head">
          <span className="thread-sidebar-title">conversations</span>
          <Button variant="ghost" data-testid="thread-new" onClick={onNew} title="start a fresh conversation">
            + new
          </Button>
        </div>
        <ul className="thread-list" data-testid="thread-list">
          {rows.map((row) => {
            const active = row.threadId === activeThreadId;
            const busy = isThreadBusy(row.threadId);
            return (
              <li
                key={row.threadId}
                className={`thread-row${active ? ' is-active' : ''}${busy ? ' is-busy' : ''}`}
                data-testid="thread-row"
                aria-current={active ? 'true' : undefined}
              >
                {renaming === row.threadId ? (
                  <div className="thread-row-editor" role="group" aria-label={`rename ${row.label}`}>
                    <input
                      data-testid="thread-rename-input"
                      defaultValue={row.label}
                      autoFocus
                      aria-label={`new name for ${row.label}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitRename(row.threadId, (event.target as HTMLInputElement).value);
                        }
                        if (event.key === 'Escape') setRenaming(undefined);
                      }}
                      onBlur={() => setRenaming(undefined)}
                    />
                  </div>
                ) : confirming === row.threadId ? (
                  <div className="thread-row-editor" role="group" aria-label={`delete ${row.label}?`}>
                    <span className="thread-confirm-copy">delete this conversation?</span>
                    <Button variant="danger" data-testid="thread-delete-confirm" onClick={() => void confirmDelete(row.threadId)}>
                      delete
                    </Button>
                    <Button variant="ghost" data-testid="thread-delete-cancel" onClick={() => setConfirming(undefined)}>
                      keep
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="thread-open"
                      data-testid="thread-open"
                      onClick={() => onSelect(row.threadId)}
                      title={row.label}
                    >
                      {busy ? <span className="thread-busy" data-testid="thread-busy" aria-label="building" title="building…" /> : null}
                      <span className="thread-label">{row.label}</span>
                    </button>
                    {!row.pending ? (
                      <span className="thread-row-actions">
                        <Button
                          variant="ghost"
                          data-testid="thread-rename"
                          aria-label={`rename ${row.label}`}
                          title="rename"
                          onClick={() => {
                            setConfirming(undefined);
                            setRenaming(row.threadId);
                          }}
                        >
                          ✎
                        </Button>
                        <Button
                          variant="ghost"
                          data-testid="thread-delete"
                          aria-label={`delete ${row.label}`}
                          title="delete"
                          onClick={() => {
                            setRenaming(undefined);
                            setConfirming(row.threadId);
                          }}
                        >
                          ×
                        </Button>
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </aside>
  );
}
