// DocsPanel — the app's knowledge wiki inside the run rail (child 3, umbrella AC7).
// The agent maintains these pages on every change (vision/requirements/plan/lessons/
// memory/next-tasks); the user can read and hand-edit them here. Compounding memory,
// visible.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { AppDocRecord } from '@snugprotocol/db';

import { getUserDb } from '../state/userdb.js';
import type { PlaygroundMode } from '../state/mode.js';
import { Button } from '../ui/Button.js';
import { Chip } from '../ui/Chip.js';
import { EmptyState } from '../ui/EmptyState.js';

export interface DocsPanelProps {
  appId: string;
  /** Bumped by the parent whenever the agent writes a doc — triggers a reload. */
  refreshToken: number;
  /** The ACTIVE mode — the empty copy branches on this value, never on a guess (AC15, R4). */
  mode: PlaygroundMode;
}

/**
 * The honest empty state (AC15). "no wiki yet" implies waiting will fix it; in
 * subscription mode nothing ever will. `buildServerTools` (apps/server/src/tools.ts)
 * ships exactly two tools and `app_doc_write` is not one of them, so the model is never
 * offered the doc tool and no page can be written. Direct mode's `buildByokTools` does
 * ship it.
 *
 * R4: branches on the MODE VALUE — when the server gains the tool, only this switch
 * changes.
 */
function emptyCopy(mode: PlaygroundMode): { title: string; lesson: string } {
  if (mode === 'subscription') {
    return {
      title: 'no wiki in subscription mode',
      lesson:
        'the hub’s agent is not offered the doc tool, so it cannot write these pages however long you build — switch to byok or local mode in settings to get a wiki.',
    };
  }
  return {
    title: 'no wiki yet',
    lesson: 'the agent writes this app’s vision, plan, and lessons as you build — ask for a change and the pages appear.',
  };
}

export function DocsPanel({ appId, refreshToken, mode }: DocsPanelProps): ReactElement {
  const [docs, setDocs] = useState<AppDocRecord[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const loaded = db.listAppDocs(appId);
      setDocs(loaded);
      setSelected((current) => current ?? loaded[0]?.slug);
    });
    return () => {
      cancelled = true;
    };
  }, [appId, refreshToken]);

  const doc = docs.find((d) => d.slug === selected);

  const save = useCallback((): void => {
    if (doc === undefined || draft === undefined) return;
    setError(undefined);
    void getUserDb()
      .then((db) => {
        db.putAppDoc(appId, doc.slug, { content: draft, ...(doc.title !== undefined ? { title: doc.title } : {}) });
        setDocs(db.listAppDocs(appId));
        setDraft(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [appId, doc, draft]);

  if (docs.length === 0) {
    const { title, lesson } = emptyCopy(mode);
    return <EmptyState glyph="✧" title={title} lesson={lesson} />;
  }

  return (
    <div className="docs-panel">
      <div className="chip-row" role="tablist" aria-label="app docs">
        {docs.map((entry) => (
          <Chip
            key={entry.slug}
            aria-pressed={entry.slug === selected}
            className={entry.slug === selected ? 'chip-active' : undefined}
            onClick={() => {
              setSelected(entry.slug);
              setDraft(undefined);
            }}
          >
            {entry.slug}
          </Chip>
        ))}
      </div>
      {error !== undefined ? (
        <div className="error-note" role="alert">
          save failed — {error}
        </div>
      ) : null}
      {doc !== undefined ? (
        <article className="doc-page">
          <header className="doc-page-head">
            <h3>{doc.title ?? doc.slug}</h3>
            <span className="doc-updated">{new Date(doc.updatedAt).toLocaleString()}</span>
          </header>
          {draft === undefined ? (
            <>
              <pre className="doc-body">{doc.content}</pre>
              <Button onClick={() => setDraft(doc.content)}>edit</Button>
            </>
          ) : (
            <>
              <textarea
                className="doc-editor"
                value={draft}
                aria-label={`edit ${doc.slug}`}
                onChange={(event) => setDraft(event.target.value)}
                rows={12}
              />
              <div className="doc-actions">
                <Button variant="primary" onClick={save} disabled={draft.trim() === ''}>
                  save
                </Button>
                <Button variant="ghost" onClick={() => setDraft(undefined)}>
                  cancel
                </Button>
              </div>
            </>
          )}
        </article>
      ) : null}
    </div>
  );
}
