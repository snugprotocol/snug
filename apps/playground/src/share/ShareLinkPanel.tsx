// ShareLinkPanel.tsx — the link transport inside the share sheet (TASK-20260904 AC22,
// ADR-0064). Rendered ONLY when a relay origin is configured (`SHARE_RELAY_ORIGIN`); a
// build without one — self-hosters, any build before the relay is deployed — shows no
// copy-link action at all, so the attachment path never depends on a hosted surface.
//
// The flow: encrypt in this browser → upload the ciphertext → show the link in a
// read-only field with an inline copy control → say plainly what the link is (anyone
// with it can install, until the date; the link IS the key; we cannot read it). Below,
// the app's active links with "copy again" and "revoke" — revocation is best-effort
// (someone who already fetched keeps the bytes), and the copy says so.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { SHARE_RELAY_ORIGIN } from '../config/site.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import type { PreparedShare } from './exportShare.js';
import { linkForRecord, listShareLinks, mintShareLink, revokeShareLink, type ShareLinkRecord } from './shareLinks.js';

export function shareLinksAvailable(): boolean {
  return SHARE_RELAY_ORIGIN !== '';
}

export interface ShareLinkPanelProps {
  appId: string;
  prepared: PreparedShare;
  disabled: boolean;
}

function friendlyDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ShareLinkPanel({ appId, prepared, disabled }: ShareLinkPanelProps): ReactElement {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [records, setRecords] = useState<ShareLinkRecord[]>([]);

  const refreshRecords = useCallback(async () => {
    const db = await getUserDb();
    setRecords(listShareLinks(db, appId));
  }, [appId]);

  useEffect(() => {
    void refreshRecords();
  }, [refreshRecords]);

  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText?.(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const mint = useCallback(() => {
    setBusy(true);
    setError(undefined);
    void mintShareLink(appId, prepared)
      .then(({ link: url, record }) => {
        setLink({ url, expiresAt: record.expiresAt });
        copy(url);
        return refreshRecords();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [appId, prepared, copy, refreshRecords]);

  const copyAgain = useCallback(
    async (record: ShareLinkRecord) => {
      const db = await getUserDb();
      const url = linkForRecord(db, record);
      if (url === undefined) {
        setError('the key for that link is no longer in this file — revoke it and share again');
        return;
      }
      setLink({ url, expiresAt: record.expiresAt });
      copy(url);
    },
    [copy],
  );

  const revoke = useCallback(
    async (record: ShareLinkRecord) => {
      setError(undefined);
      await revokeShareLink(appId, record.id);
      if (link !== undefined && link.url.includes(`/${record.id}#`)) setLink(undefined);
      await refreshRecords();
    },
    [appId, link, refreshRecords],
  );

  return (
    <section className="share-section share-link-panel" aria-labelledby="share-link" data-testid="share-link-panel">
      <h3 id="share-link" className="release-section-title">
        share a link
      </h3>
      <p className="hint">
        the app is encrypted here, in your browser, before anything is uploaded. the link carries the key — the relay
        stores bytes it cannot read, for 30 days.
      </p>
      <div className="field-row field-row-wrap">
        <Button variant="primary" data-testid="share-copy-link" disabled={disabled || busy} onClick={mint} title="encrypt, upload, and copy a link to your clipboard">
          {busy ? 'preparing link…' : link === undefined ? 'copy link' : 'new link'}
        </Button>
        {link !== undefined ? (
          <>
            <input className="share-link-field" data-testid="share-link-url" readOnly value={link.url} aria-label="share link" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="ghost" className="btn-icon" data-testid="share-link-copy" aria-label="copy link" title="copy the link" onClick={() => copy(link.url)}>
              {copied ? '✓' : '⧉'}
            </Button>
            {copied ? <span className="hint" role="status">copied ✓</span> : null}
          </>
        ) : null}
      </div>
      {link !== undefined ? (
        <p className="hint" data-testid="share-link-terms">
          anyone with this link can install this app until {friendlyDate(link.expiresAt)}. the link is the key — we can’t
          read what’s inside.
        </p>
      ) : null}
      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}
      {records.length > 0 ? (
        <ul className="share-list share-active-links" data-testid="share-active-links" aria-label="active links for this app">
          {records.map((record) => (
            <li key={record.id} className="share-active-link">
              <span className="share-doc-meta">until {friendlyDate(record.expiresAt)}</span>
              <Button variant="ghost" aria-label={`copy link ${record.id}`} title="copy this link again" onClick={() => void copyAgain(record)}>
                copy
              </Button>
              <Button variant="ghost" aria-label={`revoke link ${record.id}`} title="revoke: the relay deletes it now (someone who already opened it keeps their copy)" onClick={() => void revoke(record)}>
                revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
