// The desktop's ChatGPT-plan seat (TASK-20261023-siwc-chatgpt-plan D2/D10; ADR-0078 §2, §10).
//
// What `SnugPlatform.chatgptPlan` carries on the desktop, in four parts:
//   - `sessionStore` — custody over the three Rust commands (`chatgpt_session_read|write|clear`,
//     src-tauri/src/chatgpt_session.rs). Rust keeps the payload as OPAQUE bytes, so the shape
//     check lives here, through auth's TOTAL `parseChatgptSessionFile` (Gate 5 ST4): malformed
//     JSON or a malformed shape reads as `undefined` — a corrupt file must not block the sign-in
//     that would overwrite it. A REFUSED read is different and stays a rejection: the Rust side
//     refusing (EACCES, a non-UTF-8 file, `.chatgpt-plan` existing as a file) is named by the
//     keeper, which settles on it and tells the user — the remedy is "forget this registration".
//     A failed write rejects too: the keeper's crash-safe rotation depends on knowing a persist
//     did not happen (D4).
//   - `flush()` — the store tracks ITS OWN in-flight write / clear IPC and `flush()` awaits them
//     all SETTLED (Gate 5 G5-C2 / ST8): the close-requested flush awaits this beside the keeper's
//     own `flush()`, so a rotated refresh token whose write is still crossing the bridge at close
//     reaches the custody file. It never rejects — a failed persist is the keeper's to report.
//   - `loopback` — the sign-in's OWN `createDesktopOAuthTransport` (auth's reserved
//     `CHATGPT_PLAN_APP_ID`) over its own port-filtered listener, with error delivery opted in so
//     a declined consent ends by name. It never cancels or consumes the connection wizard's flow
//     (that transport lives in platform-desktop.ts, untouched).
//   - `openExternal` — the https-guarded system-browser opener; the authorize URL is always https.
//
// Nothing here logs (C1 — a session body is a credential), and building the seat touches no
// command: presence on the platform is static (AC1/D10), never the outcome of a read.

import {
  CHATGPT_PLAN_APP_ID,
  createDesktopOAuthTransport,
  parseChatgptSessionFile,
  type CallbackDelivery,
  type CallbackErrorDelivery,
  type ChatgptLoopbackSeat,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
} from '@snugprotocol/auth';
import { invoke } from '@tauri-apps/api/core';

import type { ChatgptPlanSeat } from '@playground/platform/platform';

import { createTauriLoopbackListener, openInSystemBrowser } from './oauth.js';

type Delivery = CallbackDelivery | CallbackErrorDelivery;

/**
 * The shape gate over the opaque bytes: JSON, then auth's total parser. Anything that is not
 * JSON, or not a file the parser accepts, is "no usable session" — and a file whose token set is
 * malformed comes back as its registration alone, exactly as the keeper would read it.
 */
function parseSessionFile(body: string): ChatgptSessionFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return parseChatgptSessionFile(parsed);
}

interface TrackedSessionStore extends ChatgptSessionStore {
  /** Resolves once every write / clear started before the call has settled. Never rejects. */
  flush(): Promise<void>;
}

function createSessionStore(): TrackedSessionStore {
  // The IPC promises in flight. Each removes itself on settle; `flush` snapshots the set as of
  // the call, so a keeper that keeps writing cannot hold a close flush past its budget.
  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>): Promise<void> => {
    inFlight.add(p);
    const release = (): void => {
      inFlight.delete(p);
    };
    void p.then(release, release);
    return p;
  };
  return {
    async read() {
      const body = await invoke<string | null>('chatgpt_session_read');
      return typeof body === 'string' ? parseSessionFile(body) : undefined;
    },
    write(file) {
      return track(invoke('chatgpt_session_write', { payload: JSON.stringify(file) }));
    },
    clear() {
      return track(invoke('chatgpt_session_clear'));
    },
    async flush() {
      await Promise.allSettled([...inFlight]);
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
  const sessionStore = createSessionStore();
  return {
    sessionStore,
    flush: () => sessionStore.flush(),
    loopback: createLoopbackSeat(),
    openExternal: (url) => openInSystemBrowser(url),
  };
}
