// The desktop's ChatGPT-plan seat (TASK-20261023-siwc-chatgpt-plan D2/D10; ADR-0078 §2, §10).
//
// What `SnugPlatform.chatgptPlan` carries on the desktop, in three parts:
//   - `sessionStore` — custody over the three Rust commands (`chatgpt_session_read|write|clear`,
//     src-tauri/src/chatgpt_session.rs). Rust keeps the payload as OPAQUE bytes, so the shape
//     check lives here: a malformed file reads as `undefined`, never a throw — a corrupt file
//     must not block the sign-in that would overwrite it. An IPC failure still rejects: the
//     keeper's crash-safe rotation depends on knowing a persist did not happen (D4).
//   - `loopback` — the sign-in's OWN `createDesktopOAuthTransport` (reserved appId
//     `chatgpt-plan`) over its own port-filtered listener, with error delivery opted in so a
//     declined consent ends by name. It never cancels or consumes the connection wizard's flow
//     (that transport lives in platform-desktop.ts, untouched).
//   - `openExternal` — the https-guarded system-browser opener; the authorize URL is always https.
//
// Nothing here logs (C1 — a session body is a credential), and building the seat touches no
// command: presence on the platform is static (AC1/D10), never the outcome of a read.

import {
  createDesktopOAuthTransport,
  type CallbackDelivery,
  type CallbackErrorDelivery,
  type ChatgptLoopbackSeat,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
} from '@snugprotocol/auth';
import { invoke } from '@tauri-apps/api/core';

import type { ChatgptPlanSeat } from '@playground/platform/platform';

import { createTauriLoopbackListener, openInSystemBrowser } from './oauth.js';

/** The reserved appId of the sign-in's flows — never a connection's provider name (D10). */
export const CHATGPT_PLAN_APP_ID = 'chatgpt-plan';

type Delivery = CallbackDelivery | CallbackErrorDelivery;

/**
 * The shape gate over the opaque bytes: a v1 object with a string `hostId`. Anything else —
 * not JSON, not an object, another version — is "no usable session". Deeper validity (token
 * fields, account) is the keeper's reading, not custody's.
 */
function parseSessionFile(body: string): ChatgptSessionFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const file = parsed as { v?: unknown; hostId?: unknown };
  if (file.v !== 1 || typeof file.hostId !== 'string') return undefined;
  return parsed as ChatgptSessionFile;
}

function createSessionStore(): ChatgptSessionStore {
  return {
    async read() {
      const body = await invoke<string | null>('chatgpt_session_read');
      return typeof body === 'string' ? parseSessionFile(body) : undefined;
    },
    async write(file) {
      await invoke('chatgpt_session_write', { payload: JSON.stringify(file) });
    },
    async clear() {
      await invoke('chatgpt_session_clear');
    },
  };
}

function createLoopbackSeat(): ChatgptLoopbackSeat {
  const subscribers = new Set<(d: Delivery) => void>();
  const deliver = (d: Delivery): void => {
    for (const cb of [...subscribers]) cb(d);
  };
  // A second transport instance with its own listener: the port filter in oauth.ts keeps the
  // wizard's callbacks and this one's apart on the plugin's single `oauth://url` event.
  const transport = createDesktopOAuthTransport({
    listener: createTauriLoopbackListener((url) => transport.handleCallbackUrl(url)),
    onDelivery: deliver,
    onError: deliver,
  });
  return {
    begin: (path) => transport.beginFlow({ posture: 'loopback', appId: CHATGPT_PLAN_APP_ID, path }),
    onCallback(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    cancel: () => transport.cancel(),
  };
}

export function createChatgptPlanSeat(): ChatgptPlanSeat {
  return {
    sessionStore: createSessionStore(),
    loopback: createLoopbackSeat(),
    openExternal: (url) => openInSystemBrowser(url),
  };
}
