// NetConfirmDialog — the mutating-call confirm (AL-03 D5 / open Q1). Observes
// netConfirmStore; when an app asks to POST/PUT/PATCH/DELETE through the bridge, this
// shows the (app, host, method, URL) and a "remember for this session" checkbox.
// Allow/Deny resolve the parked confirm. Dev-grade visuals; functional and clean.
//
// THE SCHEDULED VARIANT (TASK-20261010-host-broker PR-1; ADR-0077 §3). When the parked confirm
// carries `scheduled`, a run the user did not start is asking on the open app: the dialog speaks
// for the HOST — `DELEGATED_CONFIRM.title`, never the schedule's own title as a heading (an
// app-authored string must not headline a consent surface); a body that quotes the schedule and
// says in one breath that this was not the user's click, that *allow once* means once and that
// silence means no; the credentials sentence and the verbatim URL exactly as the ordinary dialog
// (R-8); NO remember box — the run-scoped gate never remembers, so the dialog must not offer what
// the gate would not honour, and the decision it resolves carries no `rememberSession` key at
// all. The `afterRun` tag is the sticky variant (the frame hosted a run earlier). Every string
// comes from `schedule/copy.ts`.
//
// THE BUTTONS RESOLVE THE ENTRY THIS RENDER SHOWS (Gate-5 F-4), never "whatever is at the queue
// head now": a scheduled confirm is WITHDRAWN by its run's signal without a user act, which moves
// the head under an open dialog — a click that reached for the head could hand the user's *allow*
// to a different app's request. `pending.resolve` is the entry's own exit (a gone entry is a no-op).
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { DELEGATED_CONFIRM } from '../schedule/copy.js';
import { chatConfirmSurfaceStore, netConfirmStore, type PendingNetConfirm } from '../state/net.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';

/** The body of the scheduled variant: the run's, or the sticky after-run sentence. */
function scheduledBody(scheduled: NonNullable<PendingNetConfirm['scheduled']>, appName: string, method: string, host: string): string {
  return 'afterRun' in scheduled ? DELEGATED_CONFIRM.afterRunBody(appName, method, host) : DELEGATED_CONFIRM.body(scheduled.title, appName, method, host);
}

export function NetConfirmDialog(): ReactElement | null {
  const pending = useStore(netConfirmStore);
  const chatSurfaces = useStore(chatConfirmSurfaceStore);
  const [remember, setRemember] = useState(false);

  // Reset the checkbox each time a NEW confirm opens (never carry a prior choice).
  useEffect(() => {
    setRemember(false);
  }, [pending?.request.url, pending?.request.method]);

  // A chat-origin confirm renders as an inline card in the chat rail
  // (TASK-20260815-inline-cards) — the modal stepping in too would double-prompt the
  // same decision. But the card only exists while a ChatLog is MOUNTED (Gate-5 B
  // MAJOR-2: rail tabs unmount it), so the modal yields ONLY while a card surface is
  // actually present; with none, it renders chat-origin confirms too — a parked
  // decision must always have exactly one live surface.
  if (pending === null || (pending.origin === 'chat' && chatSurfaces > 0)) return null;
  const { appId, host, method, url } = pending.request;
  const scheduled = pending.scheduled;

  return (
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="confirm network request">
      <div className="net-confirm-card">
        {scheduled !== undefined ? (
          <>
            <h2 className="net-confirm-title">{DELEGATED_CONFIRM.title}</h2>
            <p className="net-confirm-body">{scheduledBody(scheduled, scheduled.appName, method, host)}</p>
            <p className="net-confirm-body">
              Your saved credentials for this connection will be attached by the host — the app never sees them.
            </p>
          </>
        ) : (
          <>
            <h2 className="net-confirm-title">this app wants to make a change</h2>
            <p className="net-confirm-body">
              <code>{appId}</code> is asking to send a <strong>{method}</strong> request to{' '}
              <strong>{host}</strong>. Your saved credentials for this connection will be attached by the host — the app
              never sees them.
            </p>
          </>
        )}
        {/*
          The URL is the field that DISTINGUISHES one mutating call from another, so
          it is shown verbatim. Threat-model R-8 rests this dialog on "naming host,
          method and URL": host+method alone cannot tell `POST /notes` from
          `POST /transfer?to=attacker`, which is exactly the difference a prompt
          injection would exploit. The chat-lane card has always rendered it.
        */}
        <code className="net-confirm-url" style={{ wordBreak: 'break-all' }}>
          {url}
        </code>
        {scheduled === undefined ? (
          <label className="check-label net-confirm-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            {/*
              The grant is keyed (appId, host, method) with NO path component
              (`session-confirm.ts`), so this covers every path on the host. Saying so
              is the difference between consent and the appearance of it.
            */}
            remember for this session — any path, {method} to {host}
          </label>
        ) : null}
        <div className="field-row net-confirm-actions">
          {scheduled !== undefined ? (
            <>
              <Button variant="ghost" onClick={() => pending.resolve({ granted: false })}>
                {DELEGATED_CONFIRM.deny}
              </Button>
              <Button variant="primary" onClick={() => pending.resolve({ granted: true })}>
                {DELEGATED_CONFIRM.allow}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => pending.resolve({ granted: false })}>
                deny
              </Button>
              <Button variant="primary" onClick={() => pending.resolve({ granted: true, rememberSession: remember })}>
                allow
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
