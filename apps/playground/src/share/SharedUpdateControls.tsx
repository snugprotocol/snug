// SharedUpdateControls — the run header's door to a newer shared version of an
// INSTALLED shared app (TASK-20260904 AC12; Gate-5 finding 1). It is a LINK, not a
// write: the update act lives in the PREVIEW of the new bundle, because that is the
// only route where its docs and "what it tells the AI" can be read before the recipient
// hands their installed app (and every grant it holds) to new code. Renders nothing
// when no newer bundle of this lineage is on the shelf, so RunView mounts it
// unconditionally for owned apps.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { sharedUpdateStatus, type SharedUpdateStatus } from './installShared.js';
import { sharedInboxStore, sharedRouteIdFor } from './sharedInbox.js';

export interface SharedUpdateControlsProps {
  appId: string;
  refreshToken: number;
}

export function SharedUpdateControls({ appId, refreshToken }: SharedUpdateControlsProps): ReactElement | null {
  const shelf = useStore(sharedInboxStore);
  const navigate = useNavigate();
  const [status, setStatus] = useState<SharedUpdateStatus | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (!cancelled) setStatus(sharedUpdateStatus(db, appId));
    });
    return () => {
      cancelled = true;
    };
  }, [appId, refreshToken, shelf]);

  if (status === undefined) return null;

  return (
    <Button
      variant="primary"
      data-testid="shared-update"
      aria-label="review the newer shared version of this app"
      title="a newer shared version is on your shelf — read what changed, then update your copy from there"
      onClick={() => navigate(`/run/${sharedRouteIdFor(status.entry.bundleId)}`)}
    >
      newer version · review
    </Button>
  );
}
