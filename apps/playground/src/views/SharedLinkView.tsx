// SharedLinkView.tsx — the share LINK receiver, `/s/:id#<key>` (TASK-20260904 AC20,
// ADR-0064). The page every recipient lands on, on every platform: read the id from the
// path and the key from the fragment, STRIP the fragment from the address bar (history,
// bookmarks and history-sync must not keep the key), fetch the ciphertext from the
// relay, decrypt, validate at the boundary, and open the preview FROM MEMORY — nothing
// is written into the user file by a link visit (finding 12); "keep" and install are
// explicit acts in the preview's header.
//
// Router-aware reads only (`useParams`, `useLocation`) — never `window.location.search`
// (the HashRouter trap the desktop gate documents). This route is never mounted under
// the desktop's HashRouter: the deep-link handler there receives `snug://s/<id>#<key>`
// through the plugin's own seat and calls the same `receiveShareLink` act directly.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { EmptyState } from '../ui/EmptyState.js';
import { Skeleton } from '../ui/Skeleton.js';
import { receiveShareLink, type ShareLinkFailure } from '../share/receiveShareLink.js';
import { sharedRouteIdFor } from '../share/sharedInbox.js';

const FAILURE_COPY: Record<ShareLinkFailure, { title: string; lesson: string }> = {
  'bad-link': { title: 'this link is not a Snug share link', lesson: 'a share link looks like …/s/<id>#<key> — the key after the # is part of it. ask for it again.' },
  'no-relay': { title: 'share links are not available here', lesson: 'this build has no share relay. ask the sender for the .snug file instead — you can add it from settings.' },
  gone: { title: 'this link has expired or was revoked', lesson: 'share links live 30 days, and the sender can revoke them earlier. ask for a fresh one, or for the .snug file.' },
  unreachable: { title: 'could not reach the share relay', lesson: 'check your connection and try again. nothing was changed.' },
  'bad-key': { title: 'this link is damaged', lesson: 'the key after the # does not open what the relay holds. ask the sender to copy the link again.' },
  invalid: { title: 'this shared app cannot be opened', lesson: 'the file behind the link is not a valid Snug app, or it is newer than this version of Snug.' },
  'shelf-full': { title: 'your shared shelf is full', lesson: 'install or dismiss a shared app on your apps page, then open the link again.' },
};

export function SharedLinkView(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [failure, setFailure] = useState<ShareLinkFailure | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const key = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    // The key must not outlive this read in the address bar (finding 12).
    if (key !== '' && typeof window !== 'undefined') {
      window.history.replaceState(window.history.state, '', location.pathname);
    }
    void receiveShareLink(id ?? '', key).then((result) => {
      if (cancelled) return;
      if (result.ok) navigate(`/run/${sharedRouteIdFor(result.bundleId)}`, { replace: true });
      else setFailure(result.reason);
    });
    return () => {
      cancelled = true;
    };
    // The link is read ONCE per mount: re-running on hash changes would re-fetch after
    // the replaceState above cleared it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (failure !== undefined) {
    const copy = FAILURE_COPY[failure];
    return (
      <div className="shared-link-view" data-testid="shared-link-failure" data-reason={failure}>
        <EmptyState glyph="⌁" title={copy.title} lesson={copy.lesson} action={<Link to="/" className="btn">your apps</Link>} />
      </div>
    );
  }
  return (
    <div className="shared-link-view" data-testid="shared-link-loading" style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <Skeleton height="64px" />
      <p className="hint">opening the shared app…</p>
    </div>
  );
}
