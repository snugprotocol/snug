/**
 * THE STANDING APPROVAL GATE (ADR-0033) — the host-side seat for armed auto-reply.
 *
 * "The LLM proposes, the human approves, the host freezes" needs an answer for approval that
 * happens BEFORE the act, because an unattended send by definition has nobody at the dialog.
 * This gate is that answer: arming records an explicit, scoped, standing approval, and an
 * armed send then traverses the same executor pipeline as any other write. **Armed is a
 * recorded answer, not a bypass.**
 *
 * IT WRAPS THE SESSION GATE RATHER THAN WIDENING IT (blocker B2, ADR-0033 §3).
 * `createSessionConfirmGate` keys grants on `(appId, normalizedHost, method)` in memory.
 * Every armed send is a POST to the SAME sidecar host, so that key cannot tell the armed
 * thread from any other — remembering one send would authorize all of them. It also has no
 * clock (the cap and quiet hours need one), no persistence, and it is a module-level
 * singleton shared with the wizard's probe path, so widening it would widen the probe too.
 *
 * Composing instead of modifying buys the ordering structurally: this gate IS the caller of
 * the session gate, so "consulted first" cannot be inverted by a later edit, and the session
 * gate's deliberate memory-only property is left exactly as its own header describes it.
 * Anything outside the frozen scope returns NO OPINION and falls through to the ordinary
 * confirm — the user still gets asked, exactly as before.
 */

import type { NetMethod } from '@snugprotocol/protocol';

/** What arming freezes. Every field is decided at arm time and never re-derived per request. */
export interface StandingGrant {
  appId: string;
  /** The connection slot. A grant is scoped to ONE connection, not to a host. */
  slot: string;
  /** The one conversation this approval covers. */
  threadJid: string;
  /**
   * Fixed by thread type at arm time: `tagged` (group — only messages tagging the user) or
   * `all` (DM). Widening requires disarm + re-arm, so no request can talk its way wider.
   */
  trigger: 'tagged' | 'all';
  maxPerWindow: number;
  windowMs: number;
  /** Local wall-clock hours, `startHour` inclusive to `endHour` exclusive; may wrap midnight. */
  quietHours?: { startHour: number; endHour: number };
  armedAt: number;
  /** Send timestamps inside the current window. Pruned as the window slides. */
  sends: number[];
}

/** Persistence seam. The real implementation stores grants beside the connection. */
export interface StandingApprovalStore {
  list(): readonly StandingGrant[];
  save(grant: StandingGrant): void;
  clear(appId: string): void;
}

/** The request seat, widened past `NetConfirmRequest` with what a thread decision needs. */
export interface StandingConfirmRequest {
  appId: string;
  host: string;
  method: NetMethod;
  url: string;
  /**
   * The resolved connection slot, present only on the app's connected path. The wizard's
   * probe carries none — which is precisely how a standing grant is kept off it.
   */
  slot?: string;
  body?: string;
}

export type StandingOutcome =
  | 'no-opinion'
  | 'armed'
  | 'rate-capped'
  | 'quiet-hours'
  | 'thread-mismatch';

export interface StandingDecision {
  granted: boolean;
  outcome: StandingOutcome;
  /** Present when the refusal came from a guardrail — the app tells the user which one. */
  detail?: string;
}

export interface StandingApprovalGateDeps {
  store: StandingApprovalStore;
  /** The gate consulted when this one has no opinion — in practice the session gate. */
  inner: { confirm(request: StandingConfirmRequest): boolean | Promise<boolean> };
  now: () => number;
}

export interface StandingApprovalGate {
  confirm(request: StandingConfirmRequest): Promise<boolean>;
  /** Like `confirm`, but reports WHY — a capped send must be distinguishable from a denial. */
  decide(request: StandingConfirmRequest): Promise<StandingDecision>;
  arm(grant: StandingGrant): void;
  /** The kill switch. Immediate: the next send is simply not armed. */
  disarm(appId: string): void;
  /** Approve / re-approve / revoke — the R3 rule the session gate follows. */
  invalidate(appId: string): void;
  armedFor(appId: string): StandingGrant | undefined;
}

/**
 * The send route, as a matcher rather than a prefix test.
 *
 * Anchored, and `:jid` is a single segment: arming approves SENDING to one thread, and must
 * not become a blanket write approval for whatever other mutating routes the helper grows.
 */
const SEND_ROUTE = /^\/chats\/([^/]+)\/messages$/;

/**
 * The thread a request is really addressed to, or `undefined` when that cannot be decided.
 *
 * BOTH sources must agree. Picking one is a vulnerability with two spellings: trust the path
 * and the body decides where the message actually goes; trust the body and the path check was
 * theatre. Disagreement is refused, never resolved.
 */
function deriveThread(request: StandingConfirmRequest): string | undefined {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  const matched = SEND_ROUTE.exec(path);
  if (matched === null) return undefined;

  let pathJid: string;
  try {
    pathJid = decodeURIComponent(matched[1] ?? '');
  } catch {
    // A malformed escape is not a thread identity; refuse rather than compare raw bytes.
    return undefined;
  }
  if (pathJid.length === 0) return undefined;

  if (request.body === undefined || request.body.length === 0) return pathJid;

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    // An armed send is JSON by contract. Something else is unrecognized, and an
    // unrecognized send is asked about rather than assumed safe.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const bodyJid = (parsed as { jid?: unknown }).jid;
  if (bodyJid === undefined) return pathJid;
  if (typeof bodyJid !== 'string') return undefined;
  return bodyJid === pathJid ? pathJid : undefined;
}

/** Is `at` inside the quiet window? Handles a window that wraps midnight. */
function inQuietHours(at: number, quiet: { startHour: number; endHour: number }): boolean {
  const hour = new Date(at).getHours();
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

export function createStandingApprovalGate(deps: StandingApprovalGateDeps): StandingApprovalGate {
  const { store, inner, now } = deps;

  const armedFor = (appId: string): StandingGrant | undefined =>
    store.list().find((grant) => grant.appId === appId);

  const decide = async (request: StandingConfirmRequest): Promise<StandingDecision> => {
    const fallthrough = async (outcome: StandingOutcome): Promise<StandingDecision> => ({
      granted: (await inner.confirm(request)) === true,
      outcome,
    });

    // Mutating methods only: a GET never reaches the executor's confirm seat at all, and a
    // standing grant that answered for reads would be answering a question nobody asked.
    if (request.method === 'GET' || request.method === 'HEAD') return fallthrough('no-opinion');

    // No slot means the wizard's probe path, which shares this gate as a singleton. A grant
    // must never reach it: the user armed an app, not the wizard.
    if (request.slot === undefined) return fallthrough('no-opinion');

    const grant = armedFor(request.appId);
    if (grant === undefined) return fallthrough('no-opinion');
    if (grant.slot !== request.slot) return fallthrough('no-opinion');

    const thread = deriveThread(request);
    if (thread === undefined) {
      // Includes the disagreeing-JID case. Falling through means the USER is asked — the
      // refusal to decide is never itself an approval.
      return fallthrough('thread-mismatch');
    }
    if (thread !== grant.threadJid) return fallthrough('no-opinion');

    const at = now();

    if (grant.quietHours !== undefined && inQuietHours(at, grant.quietHours)) {
      return { granted: false, outcome: 'quiet-hours', detail: 'quiet hours are in effect for this thread' };
    }

    const fresh = grant.sends.filter((sent) => at - sent < grant.windowMs);
    if (fresh.length >= grant.maxPerWindow) {
      return {
        granted: false,
        outcome: 'rate-capped',
        detail: `this thread's send limit (${grant.maxPerWindow}) has been reached — it resets shortly`,
      };
    }

    // Record BEFORE returning: a send the cap did not count is a cap that does not hold.
    store.save({ ...grant, sends: [...fresh, at] });
    return { granted: true, outcome: 'armed' };
  };

  return {
    decide,
    async confirm(request) {
      return (await decide(request)).granted;
    },
    arm(grant) {
      // One thread armed at a time (v1): the store is keyed by (appId, slot), so arming a
      // second thread replaces the first rather than accumulating parallel approvals.
      store.save({ ...grant, sends: [] });
    },
    disarm(appId) {
      store.clear(appId);
    },
    invalidate(appId) {
      store.clear(appId);
    },
    armedFor,
  };
}
