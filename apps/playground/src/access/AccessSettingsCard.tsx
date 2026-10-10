// access/AccessSettingsCard.tsx — Settings → *access between apps* (TASK-20261010-cross-app-access
// AC19; ADR-0075 §7; Q15). One grouped card, the ScheduleSettingsCard's shape:
//
//   - EVERY access across apps, through the ONE `GrantRow` (neither side muted — no app is the
//     known one here), re-read on every access revision;
//   - the per-browser *never let apps ask to read other apps' data* switch. It writes
//     `NO_ACCESS_ASKS_KEY` — the key's ONE home is consent.ts, beside `accessAsksOff`, the global
//     mute the ask ladder reads — with the schedule card's `writeFlag` (the same `'1'`/absent
//     shape as `NO_SUGGESTIONS_KEY`). Its custody is said under it: this browser only, never the
//     file (Q15);
//   - the apps the user told to stop asking, each with *let Budget ask again*;
//   - *clear history* behind an armed inline confirm: it clears the READS from every app's
//     history; when access was allowed, stopped or paused stays on record (the db keeps them);
//   - the same creation act as the ⋈ sheet (`startUserAsk`), for the app the user picks.

import { useEffect, useId, useState, type ReactElement } from 'react';

import type { AppRecord } from '@snugprotocol/db';

import '../theme/access-sheet.css';
import { appMayUseAccess } from '../run/appCapabilityRules.js';
import { writeFlag } from '../schedule/ScheduleSettingsCard.js';
import { Switch } from '../schedule/ScheduleStates.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { NO_ACCESS_ASKS_KEY, accessAsksOff } from './consent.js';
import { SETTINGS_CARD } from './copy.js';
import { GrantRow } from './GrantRow.js';
import { accessDeps, bumpAccessRevision, grantsForApp, useAccessRevision, type LiveGrantRow } from './grants.js';
import { startUserAsk } from './userAsk.js';

interface CardData {
  apps: AppRecord[];
  rows: LiveGrantRow[];
  muted: AppRecord[];
  now: number;
}

function useCardData(): CardData | undefined {
  const revision = useAccessRevision();
  const [data, setData] = useState<CardData | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void accessDeps()
      .getDb()
      .then((db) => {
        if (cancelled) return;
        const now = accessDeps().now();
        const apps = db.listApps();
        // Every access has exactly one app that reads: the union of each app's `reads` is every access, once.
        const rows = apps.flatMap((app) => grantsForApp(db, app.appId, now).reads);
        setData({ apps, rows, muted: apps.filter((app) => db.isAccessMuted(app.appId)), now });
      })
      .catch(() => {
        // the file is not open (a swap in flight): the card shows what it last read
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return data;
}

export function AccessSettingsCard(): ReactElement {
  const data = useCardData();
  const [asksOff, setAsksOff] = useState(accessAsksOff);
  const [clearArmed, setClearArmed] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const switchLabelId = useId();
  const mutedTitleId = useId();

  const toggleAsks = (next: boolean): void => {
    writeFlag(NO_ACCESS_ASKS_KEY, next);
    setAsksOff(next);
  };

  const unmute = async (appId: string): Promise<void> => {
    const db = await accessDeps().getDb();
    db.setAccessMuted(appId, false);
    bumpAccessRevision();
  };

  const confirmClear = async (): Promise<void> => {
    setBusy(true);
    try {
      const db = await accessDeps().getDb();
      for (const app of db.listApps()) db.clearAccessLog(app.appId);
      bumpAccessRevision();
      setCleared(true);
    } finally {
      setBusy(false);
      setClearArmed(false);
    }
  };

  const creatable = (data?.apps ?? []).filter((app) => appMayUseAccess(app.appId));
  const chosen = creatable.find((app) => app.appId === picked) ?? creatable[0];

  return (
    <Card className="settings-group access-settings" data-testid="access-settings-card">
      <div className="settings-row">
        <span className="hint" data-testid="access-settings-intro">
          {SETTINGS_CARD.intro}
        </span>
      </div>

      <div className="settings-row">
        {data === undefined ? null : data.rows.length === 0 ? (
          <p className="hint" data-testid="access-settings-empty">
            {SETTINGS_CARD.empty}
          </p>
        ) : (
          <ul className="access-row-list" data-testid="access-settings-rows">
            {data.rows.map((row) => (
              <GrantRow key={row.grant.id} row={row} side="every" now={data.now} />
            ))}
          </ul>
        )}
      </div>

      {chosen !== undefined ? (
        <div className="settings-row access-settings-create">
          <select
            className="access-settings-pick"
            aria-label={SETTINGS_CARD.createPick}
            value={chosen.appId}
            onChange={(event) => setPicked(event.target.value)}
            data-testid="access-create-pick"
          >
            {creatable.map((app) => (
              <option key={app.appId} value={app.appId}>
                {app.displayName}
              </option>
            ))}
          </select>
          <Button onClick={() => void startUserAsk(chosen.appId)} data-testid="access-settings-create">
            {SETTINGS_CARD.create(chosen.displayName)}
          </Button>
        </div>
      ) : null}

      <div className="settings-row access-settings-row">
        <div className="access-settings-copy">
          <strong id={switchLabelId} data-testid="access-no-asks-label">
            {SETTINGS_CARD.neverAsk}
          </strong>
          <span className="hint" data-testid="access-no-asks-hint">
            {SETTINGS_CARD.neverAskHint}
          </span>
        </div>
        <Switch checked={asksOff} onChange={toggleAsks} labelledBy={switchLabelId} testId="access-no-asks" />
      </div>

      {data !== undefined && data.muted.length > 0 ? (
        <div className="settings-row" data-testid="access-muted">
          <h3 className="access-sheet-section-title" id={mutedTitleId}>
            {SETTINGS_CARD.mutedTitle}
          </h3>
          <ul className="access-row-list" aria-labelledby={mutedTitleId}>
            {data.muted.map((app) => (
              <li key={app.appId} className="access-muted-row">
                <Button variant="ghost" onClick={() => void unmute(app.appId)} data-testid="access-unmute">
                  {SETTINGS_CARD.unmute(app.displayName)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="settings-row access-settings-row">
        {clearArmed ? (
          <div className="access-confirm" role="group" aria-label={SETTINGS_CARD.clearHistory} data-testid="access-clear-confirm">
            <span className="hint">{SETTINGS_CARD.clearArm}</span>
            <Button variant="danger" onClick={() => void confirmClear()} disabled={busy} data-testid="access-clear-yes">
              {SETTINGS_CARD.clearConfirm}
            </Button>
            <Button variant="ghost" onClick={() => setClearArmed(false)} data-testid="access-clear-keep">
              {SETTINGS_CARD.clearKeep}
            </Button>
          </div>
        ) : (
          <>
            <div className="access-settings-copy">
              <strong>{SETTINGS_CARD.clearHistory}</strong>
              <span className="hint" data-testid="access-clear-history-hint">
                {SETTINGS_CARD.clearHistoryHint}
              </span>
              {cleared ? (
                <span className="hint" role="status" data-testid="access-cleared">
                  {SETTINGS_CARD.cleared}
                </span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setCleared(false);
                setClearArmed(true);
              }}
              data-testid="access-clear-history"
            >
              {SETTINGS_CARD.clearHistory}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
