// NetConfirmDialog — the mutating-call confirm (AL-03 D5 / open Q1). Observes
// netConfirmStore; when an app asks to POST/PUT/PATCH/DELETE through the bridge, this
// shows the (app, host, method) and a "remember for this session" checkbox. Allow/Deny
// resolve the parked confirm. Dev-grade visuals; functional and clean.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { chatConfirmSurfaceStore, netConfirmStore, resolveNetConfirm } from '../state/net.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';

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
  const { appId, host, method } = pending.request;

  return (
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="confirm network request">
      <div className="net-confirm-card">
        <h2 className="net-confirm-title">this app wants to make a change</h2>
        <p className="net-confirm-body">
          <code>{appId}</code> is asking to send a <strong>{method}</strong> request to{' '}
          <strong>{host}</strong>. Your saved credentials for this connection will be attached by the host — the app
          never sees them.
        </p>
        <label className="check-label net-confirm-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          remember for this session ({method} to {host})
        </label>
        <div className="field-row net-confirm-actions">
          <Button variant="ghost" onClick={() => resolveNetConfirm({ granted: false })}>
            deny
          </Button>
          <Button variant="primary" onClick={() => resolveNetConfirm({ granted: true, rememberSession: remember })}>
            allow
          </Button>
        </div>
      </div>
    </div>
  );
}
