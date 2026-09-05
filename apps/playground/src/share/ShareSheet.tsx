// ShareSheet.tsx — the sharer's sheet (TASK-20260904-app-sharing, AC10/AC11).
//
// One overlay that says exactly what travels and what stays home, lets the sharer pick
// the docs (each with its size and first line — the wiki is the app's living memory and
// `memory` in particular is defined as what the app learned about the USER, so it is
// off by default; owner Q7), shows the share scan's warnings by location, and offers the
// transports: download the `.snug`, and — only when a relay origin is configured — the
// LINK, copied or handed to the OS share sheet (ShareLinkPanel). A file never goes to the
// OS sheet (TASK-20260904-share-link-ux: Chrome refuses a .snug after canShare said yes).
//
// Through ConfirmOverlay, which PORTALS to <body>: the run header's backdrop-filter
// would otherwise confine this fixed overlay to the header's box (lesson 2026-08-26).
//
// Nothing here renders bundle content as HTML: names, blurbs, doc previews and warning
// text are text nodes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { ConfirmOverlay } from '../ui/ConfirmOverlay.js';
import { downloadShare, prepareShare, type PreparedShare } from './exportShare.js';
import { ShareLinkPanel, shareLinksAvailable } from './ShareLinkPanel.js';

export interface ShareSheetProps {
  appId: string;
  displayName: string;
  onClose: () => void;
}

interface DocChoice {
  slug: string;
  title?: string;
  bytes: number;
  firstLine: string;
  checked: boolean;
}

/** Docs on by default — everything except `memory`, which the app-doc tool defines as durable facts about the user. */
export const DOCS_OFF_BY_DEFAULT: readonly string[] = ['memory'];

function firstLineOf(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return line === undefined ? '' : line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function ShareSheet({ appId, displayName, onClose }: ShareSheetProps): ReactElement {
  const [docs, setDocs] = useState<DocChoice[] | undefined>(undefined);
  const [prepared, setPrepared] = useState<PreparedShare | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      const rows = db.listAppDocs(appId);
      setDocs(
        rows.map((doc) => ({
          slug: doc.slug,
          ...(doc.title !== undefined ? { title: doc.title } : {}),
          bytes: new TextEncoder().encode(doc.content).length,
          firstLine: firstLineOf(doc.content),
          checked: !DOCS_OFF_BY_DEFAULT.includes(doc.slug),
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const selectedSlugs = useMemo(() => (docs ?? []).filter((d) => d.checked).map((d) => d.slug), [docs]);

  // Rebuild the bundle whenever the doc selection changes: the size, the warnings and
  // the bytes that will travel all depend on it, and a stale preview is a wrong promise.
  useEffect(() => {
    if (docs === undefined) return;
    let cancelled = false;
    setError(undefined);
    prepareShare(appId, selectedSlugs)
      .then((next) => {
        if (!cancelled) setPrepared(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPrepared(undefined);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId, docs, selectedSlugs]);

  const toggleDoc = useCallback((slug: string) => {
    setDocs((current) => current?.map((d) => (d.slug === slug ? { ...d, checked: !d.checked } : d)));
  }, []);

  const warned = prepared !== undefined && prepared.warnings.length > 0;
  const blocked = warned && !acknowledged;

  const onDownload = useCallback(() => {
    if (prepared === undefined) return;
    setBusy(true);
    try {
      downloadShare(prepared);
    } finally {
      setBusy(false);
    }
  }, [prepared]);

  const bundle = prepared?.bundle;
  const connections = bundle?.connections ?? [];
  const tables = bundle?.schema?.ddl.length ?? 0;

  return (
    <ConfirmOverlay ariaLabel={`share ${displayName}`} cardClassName="release-notes-card share-sheet" data-testid="share-sheet">
      <div className="release-notes-head">
        <h2 className="net-confirm-title">share {displayName}</h2>
        <Button variant="ghost" aria-label="close share sheet" onClick={onClose}>
          ✕ close
        </Button>
      </div>
      <div className="release-notes-scroll share-sheet-body">
        <section className="share-section" aria-labelledby="share-travels">
          <h3 id="share-travels" className="release-section-title">
            what travels
          </h3>
          <ul className="share-list" data-testid="share-travels">
            <li>
              app code — {prepared !== undefined ? kb(new TextEncoder().encode(prepared.bundle.html).length) : '…'} (the
              current version only)
            </li>
            <li>
              {connections.length === 0
                ? 'no connections'
                : `${connections.length} connection ${connections.length === 1 ? 'shape' : 'shapes'} — ${connections
                    .map((c) => c.provider.name)
                    .join(', ')}: what to connect, never your keys`}
            </li>
            <li>
              {tables === 0
                ? 'no data tables'
                : `${tables} data ${tables === 1 ? 'object' : 'objects'} — structure only, no rows (reference or seed rows do not travel)`}
            </li>
            {bundle?.contract !== undefined ? <li>what it tells the AI — shown to whoever installs it, as text</li> : null}
          </ul>
        </section>

        <section className="share-section" aria-labelledby="share-docs">
          <h3 id="share-docs" className="release-section-title">
            wiki docs
          </h3>
          {docs === undefined ? (
            <p className="hint">reading docs…</p>
          ) : docs.length === 0 ? (
            <p className="hint">this app has no docs yet.</p>
          ) : (
            <>
              <ul className="share-list share-doc-list" data-testid="share-docs">
                {docs.map((doc) => (
                  <li key={doc.slug}>
                    <label className="check-label share-doc">
                      <input type="checkbox" checked={doc.checked} onChange={() => toggleDoc(doc.slug)} aria-label={`include ${doc.slug}`} />
                      <span className="share-doc-name">{doc.title ?? doc.slug}</span>
                      <span className="share-doc-meta">{kb(doc.bytes)}</span>
                      {doc.firstLine !== '' ? <span className="share-doc-preview">{doc.firstLine}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
              <p className="hint">docs may contain what this app learned about you — glance before you share.</p>
            </>
          )}
        </section>

        <section className="share-section" aria-labelledby="share-stays">
          <h3 id="share-stays" className="release-section-title">
            what stays home
          </h3>
          <p className="hint" data-testid="share-stays">
            your data, your credentials and every approved connection, chat history, version history, and your model
            pick. the connection shapes above say what to connect — never that you did, and never with what.
          </p>
        </section>

        {warned ? (
          <section className="share-section share-warning" role="alert" data-testid="share-warnings">
            <h3 className="release-section-title">looks like a credential</h3>
            <ul className="share-list">
              {prepared.warnings.map((warning) =>
                warning.hits.map((hit, index) => (
                  <li key={`${warning.where}:${hit.line}:${index}`}>
                    {warning.where === 'html' ? 'in the app code' : `in ${warning.where}`}, line {hit.line}: {hit.family} (
                    {hit.preview})
                  </li>
                )),
              )}
            </ul>
            <p className="hint">
              if that is a real key, remove it from the app before sharing — anyone who installs this could read it.
              {' '}
              <label className="check-label">
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                share anyway
              </label>
            </p>
          </section>
        ) : null}

        {error !== undefined ? (
          <div className="error-note" role="alert">
            {error}
          </div>
        ) : null}

        {shareLinksAvailable() && prepared !== undefined ? (
          <ShareLinkPanel appId={appId} prepared={prepared} disabled={blocked} />
        ) : null}
      </div>
      <div className="field-row net-confirm-actions share-actions">
        <span className="hint share-size" data-testid="share-size">
          {prepared !== undefined ? `${kb(prepared.bytes)} · ${prepared.fileName}` : ''}
        </span>
        <Button
          variant="primary"
          data-testid="share-download"
          disabled={prepared === undefined || blocked || busy}
          onClick={onDownload}
          title="a .snug file you send yourself — nothing leaves this device until you do"
        >
          download .snug
        </Button>
      </div>
    </ConfirmOverlay>
  );
}
