// OAuthCallbackPage — the hosted-origin callback route (AL-04 plan D6): implements
// the AL-02 `CallbackSink` seam by posting the `CallbackDelivery` over a
// BroadcastChannel NAMED BY THE FLOWID. The unsigned peek at the state payload here
// serves CHANNEL NAMING ONLY — the flow BINDING is enforced by the initiating
// context, which passes `expectedFlowId` from its OWN held copy of the start result
// (AC6), and the state signature/nonce are verified there by `handleCallback`. A
// forged state can pick a channel name; it cannot pass verification.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { base64UrlToUtf8 } from '@snugprotocol/auth';

export function OAuthCallbackPage(): ReactElement {
  const [message, setMessage] = useState('finishing sign-in…');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (code === null || code === '' || state === null || state === '') {
      setMessage('this sign-in link is missing its code — close this window and try again.');
      return;
    }
    try {
      const encoded = state.split('.')[0] ?? '';
      const payload = JSON.parse(base64UrlToUtf8(encoded)) as { appId?: unknown; flowId?: unknown };
      if (typeof payload.appId !== 'string' || typeof payload.flowId !== 'string') {
        throw new Error('state payload has the wrong shape');
      }
      const channel = new BroadcastChannel(`snug-oauth-${payload.flowId}`);
      channel.postMessage({ appId: payload.appId, flowId: payload.flowId, code, state });
      channel.close();
      setMessage('sign-in complete — you can close this window.');
      window.close(); // best-effort; blocked when the window was not script-opened
    } catch {
      setMessage('this sign-in link is not valid — close this window and try again.');
    }
  }, []);

  return (
    <div className="field" style={{ padding: 'var(--space-4)' }}>
      <span className="hint">{message}</span>
    </div>
  );
}
