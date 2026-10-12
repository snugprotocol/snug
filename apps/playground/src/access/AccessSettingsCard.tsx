// access/AccessSettingsCard.tsx — Settings → *access between apps* (TASK-20261010-cross-app-access
// AC19; ADR-0075 §7; Q15). One grouped card, the ScheduleSettingsCard's shape:
//
//   - EVERY access across apps, through the ONE `GrantRow` (neither side muted — no app is the
//     known one here), re-read on every access revision;
//   - the per-browser *never let apps ask to read other apps' data* switch. It writes
//     `NO_ACCESS_ASKS_KEY` — the key's ONE home is consent.ts, beside `accessAsksOff`, the global
//     mute the ask ladder reads — with `state/browserFlags.ts`'s `writeFlag` (the same `'1'`/absent
//     shape as `NO_SUGGESTIONS_KEY`). Its custody is said under it: this browser only, never the
//     file (Q15);
//   - the apps the user told to stop asking, each with *let Budget ask again*;
//   - *clear history* behind an armed inline confirm: it clears the READS from every app's
//     history; when access was allowed, stopped or paused — and, since TASK-20261010-host-broker
//     PR-3 (D-PR3-6/24), every change — stays on record (the db keeps them);
//   - the same creation act as the ⋈ sheet (`startUserAsk`), for the app the user picks.
//
// PR-3 (D-PR3-24; DS14, DS21) reaches this card through what it already renders: the intro and
// the *clear history* hint are copy.ts's sentences, and a write access's row carries its badge
// through the ONE `GrantRow` — nothing here is derived twice.
//
// TASK-20261010-host-broker PR-5 (D-PR5-4, D-PR5-6a; D3): *apps that could work together* — at
// most `PAIRS_MAX` pairs from `listPairSuggestions`, each *Budget could read Ledger's transactions*
// in host words with the app's purpose quoted below it, and *review…*, which starts the declared
// ask pinned to that source. The section keeps the act's settle, so its act line outlives the row
// an allow removes (the pair is no pair once Budget reads Ledger); re-read on the access and
// library revisions.

import { useEffect, useId, useState, type ReactElement } from 'react';

import type { AppRecord } from '@snugprotocol/db';

import '../theme/access.css';
import '../theme/access-sheet.css';
import { useLibraryRevision } from '../platform/signals.js';
import { appMayUseAccess } from '../run/appCapabilityRules.js';
import { writeFlag } from '../state/browserFlags.js';
import { Switch } from '../schedule/ScheduleStates.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { AccessActLine, isolateNames, useAccessAct } from './AccessActLine.js';
import { NO_ACCESS_ASKS_KEY, accessAsksOff } from './consent.js';
import { CONSENT_SHEET, SETTINGS_CARD } from './copy.js';
import { GrantRow } from './GrantRow.js';
import { accessDeps, bumpAccessRevision, grantsForApp, useAccessRevision, type LiveGrantRow } from './grants.js';
import { PAIRS_MAX, listPairSuggestions, type PairSuggestion } from './pairs.js';
import { startUserAsk } from './userAsk.js';

interface CardData {
  apps: AppRecord[];
  rows: LiveGrantRow[];
  muted: AppRecord[];
  /** PR-5 (D-PR5-4): the pairs shown, best first — at most `PAIRS_MAX`. */
  pairs: readonly PairSuggestion[];
  now: number;
}

function useCardData(): CardData | undefined {
  const revision = useAccessRevision();
  const library = useLibraryRevision();
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
        setData({ apps, rows, muted: apps.filter((app) => db.isAccessMuted(app.appId)), pairs: listPairSuggestions(db, now).slice(0, PAIRS_MAX), now });
      })
      .catch(() => {
        // the file is not open (a swap in flight): the card shows what it last read
      });
    return () => {
      cancelled = true;
    };
  }, [revision, library]);
  return data;
}

/** A pair's identity across re-reads: the two apps. */
const pairKey = (pair: Pick<PairSuggestion, 'readerAppId' | 'sourceAppId'>): string => JSON.stringify([pair.readerAppId, pair.sourceAppId]);

/**
 * *apps that could work together* (D-PR5-4): one row per pair, its act, and the ONE act line of the
 * last *review…* — in that pair's row while the row is there, under the rows once an allow (or a
 * change in the file) took the row away.
 */
function PairsSection({ pairs }: { pairs: readonly PairSuggestion[] }): ReactElement | null {
  const act = useAccessAct();
  const [asked, setAsked] = useState<{ key: string; readerName: string } | undefined>(undefined);
  const titleId = useId();
  const askedKey = act.settle === undefined ? undefined : asked?.key;
  const inRow = askedKey !== undefined && pairs.some((pair) => pairKey(pair) === askedKey);
  if (pairs.length === 0 && askedKey === undefined) return null;

  const line = (triggerGone: boolean): ReactElement => (
    <AccessActLine readerName={asked?.readerName ?? ''} settle={act.settle} onSettle={act.setSettle} triggerGone={triggerGone} />
  );
  return (
    <div className="settings-row access-sheet-section" data-testid="access-pairs">
      <h3 className="access-sheet-section-title" id={titleId}>
        {SETTINGS_CARD.pairsTitle}
      </h3>
      <ul className="access-row-list" aria-labelledby={titleId}>
        {pairs.map((pair) => {
          const key = pairKey(pair);
          return (
            <li key={key} className="access-row" data-testid="access-pair-row">
              <p className="access-row-sentence">
                {isolateNames((reader, source) => SETTINGS_CARD.pairRow(reader, source, pair.matchedTables), pair.readerName, pair.sourceName)}
              </p>
              {/* The app's own words, quoted and isolated — never the host's (D3). */}
              <q className="access-quote">{CONSENT_SHEET.quote(pair.want.purpose)}</q>
              <div className="access-row-state">
                <Button
                  variant="ghost"
                  className="access-row-act"
                  data-testid="access-pair-review"
                  aria-label={SETTINGS_CARD.pairReviewName(pair.readerName, pair.sourceName, pair.matchedTables)}
                  onClick={(event) => {
                    setAsked({ key, readerName: pair.readerName });
                    void act.start(pair.readerAppId, { declared: pair.want, source: pair.sourceAppId }, pair.sourceName, event.currentTarget);
                  }}
                >
                  {SETTINGS_CARD.pairReview}
                </Button>
              </div>
              {inRow && askedKey === key ? line(false) : null}
            </li>
          );
        })}
      </ul>
      {askedKey !== undefined && !inRow ? line(true) : null}
    </div>
  );
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

      {data !== undefined ? <PairsSection pairs={data.pairs} /> : null}

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
