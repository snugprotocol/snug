/**
 * Session-remember confirm gate (AL-03 amendment R3 + open Q1): mutating net calls
 * prompt per request; a grant with "remember for this session" is keyed
 * (app, host, method), lives in MEMORY only (never persisted — it dies with the page),
 * and is INVALIDATED whenever the app's connection is approved, re-approved, or
 * revoked (the settings surface calls `invalidate(appId)` on every such transition, so
 * a widened host set can never ride an old grant).
 */

import { normalizeAuthHost, type NetMethod } from '@snugprotocol/protocol';

export interface NetConfirmRequest {
  appId: string;
  host: string;
  method: NetMethod;
  url: string;
}

/** What the UI prompt resolves: the decision plus the remember checkbox state. */
export interface NetConfirmDecision {
  granted: boolean;
  rememberSession?: boolean;
}

export type NetConfirmPrompt = (request: NetConfirmRequest) => Promise<NetConfirmDecision>;

export interface SessionConfirmGate {
  confirm(request: NetConfirmRequest): Promise<boolean>;
  /** Drop every remembered grant for `appId` — called on approve/re-approve/revoke (R3). */
  invalidate(appId: string): void;
}

/** NUL escape — cannot appear in an appId, hostname, or method, so keys never collide. */
const SEP = '\u0000';

export function createSessionConfirmGate(prompt: NetConfirmPrompt): SessionConfirmGate {
  const grants = new Set<string>();
  const keyOf = (appId: string, host: string, method: string): string =>
    `${appId}${SEP}${normalizeAuthHost(host)}${SEP}${method}`;
  return {
    async confirm(request) {
      const key = keyOf(request.appId, request.host, request.method);
      if (grants.has(key)) return true;
      const decision = await prompt(request);
      if (decision.granted === true && decision.rememberSession === true) grants.add(key);
      return decision.granted === true;
    },
    invalidate(appId) {
      const prefix = `${appId}${SEP}`;
      for (const key of [...grants]) {
        if (key.startsWith(prefix)) grants.delete(key);
      }
    },
  };
}
