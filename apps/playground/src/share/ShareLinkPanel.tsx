// ShareLinkPanel.tsx — the link transport inside the share sheet (TASK-20260904 AC22,
// ADR-0064). Rendered ONLY when a relay origin is configured (`SHARE_RELAY_ORIGIN`); a
// build without one — self-hosters, any build before the relay is deployed — shows no
// copy-link action at all, so the attachment path never depends on a hosted surface.
//
// The flow: pick a lifetime (24 hours / 1 week / 1 month, default a week —
// TASK-20260904-share-link-ux AC5) → encrypt in this browser → upload the ciphertext →
// then EITHER copy the link (a read-only field with an inline copy control) OR hand it
// to the OS share sheet (`share…` — Messages, Mail, Notes, AirDrop; the LINK, never a
// file, AC3) → say plainly what the link is (anyone with it can install, until the date;
// the link IS the key; we cannot read it). Below, the app's active links with "copy
// again" and "revoke" — revocation is best-effort (someone who already fetched keeps the
// bytes), and the copy says so.
//
// share… uploads BEFORE it can call `navigator.share`, and browsers only honour that
// call inside a transient-activation window (~5 s). A slow upload can outlive it; the
// browser then answers NotAllowedError. That is not an error for the user: the link is
// shown and copied, with a note (AC4).

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { SHARE_RELAY_ORIGIN } from '../config/site.js';
import { getUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';
import { canShareLink, shareLinkViaOs, type PreparedShare } from './exportShare.js';
import { DEFAULT_SHARE_EXPIRY, SHARE_EXPIRY_CHOICES, type ShareExpiry } from './relayClient.js';
import { linkForRecord, listShareLinks, mintShareLink, revokeShareLink, type ShareLinkRecord } from './shareLinks.js';

const EXPIRY_VALUES: ReadonlySet<string> = new Set(SHARE_EXPIRY_CHOICES.map((c) => c.value));

function isShareExpiry(value: string): value is ShareExpiry {
  return EXPIRY_VALUES.has(value);
}

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
  const [expires, setExpires] = useState<ShareExpiry>(DEFAULT_SHARE_EXPIRY);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
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
    setNote(undefined);
    void mintShareLink(appId, prepared, expires)
      .then(({ link: url, record }) => {
        setLink({ url, expiresAt: record.expiresAt });
        copy(url);
        return refreshRecords();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [appId, prepared, expires, copy, refreshRecords]);

  const shareOs = useCallback(() => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    void mintShareLink(appId, prepared, expires)
      .then(async ({ link: url, record }) => {
        setLink({ url, expiresAt: record.expiresAt });
        await refreshRecords();
        const outcome = await shareLinkViaOs({ url, title: prepared.bundle.app.displayName });
        if (outcome === 'not-allowed') {
          copy(url);
          setNote('your browser closed the share window before the link was ready — the link is copied; paste it anywhere.');
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [appId, prepared, expires, copy, refreshRecords]);

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
        stores bytes it cannot read, for as long as you choose.
      </p>
      <div className="field-row field-row-wrap">
        <Button variant="primary" data-testid="share-copy-link" disabled={disabled || busy} onClick={mint} title="encrypt, upload, and copy a link to your clipboard">
          {busy ? 'preparing link…' : link === undefined ? 'copy link' : 'new link'}
        </Button>
        {canShareLink() ? (
          <Button variant="ghost" data-testid="share-os" disabled={disabled || busy} onClick={shareOs} title="Messages, Mail, Notes, AirDrop — wherever this device can send a link">
            share…
          </Button>
        ) : null}
        <label className="check-label share-expiry">
          <span className="share-doc-meta">link lasts</span>
          <select
            data-testid="share-expiry"
            aria-label="how long the link lasts"
            value={expires}
            disabled={busy}
            onChange={(e) => {
              if (isShareExpiry(e.target.value)) setExpires(e.target.value);
            }}
          >
            {SHARE_EXPIRY_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row field-row-wrap">
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
      {note !== undefined ? (
        <p className="hint" role="status" data-testid="share-os-note">
          {note}
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
