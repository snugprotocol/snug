/**
 * connectionWizard.ts — the v4 connection-wizard store seam (TASK-20260810-p3-wizard,
 * parent plan §6). One wizard open at a time, keyed by (appId, SLOT).
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT. It owns the STEP MACHINE and the session — which
 * slot is open, which screen is showing, whether an OAuth exchange is in flight. It owns
 * NO requirement data: every screen reads the v4 `snug_connections` row live through
 * `getUserDb()`, because the row is the only thing that can be true. A session that
 * cached the requirement at open would keep rendering a stale one after a re-approval
 * promoted `pending` → live, and the user would approve one thing while another served.
 *
 * THE MACHINE (P3-AC1) is `review → register? → credentials → connect? → done`, and both
 * '?' steps are CONDITIONAL on the requirement rather than on the kind alone:
 *  - `register` exists iff the requirement carries a `registration` walkthrough. No seat
 *    means no content, and a screen with no content is a screen with no decision — the
 *    "one decision per screen" rule read in its second direction (no screen without one).
 *  - `connect` is OAuth-only: `oauth2_auth_code` needs the three-legged popup after its
 *    client id is saved; every static kind is finished the moment its secrets land.
 * The machine is DERIVED (`nextStep` below) rather than stored as a list, so a
 * requirement edited between two screens cannot leave the user walking a route that no
 * longer matches what they are approving.
 *
 * ORDER IS THE B1 WALL, restated at the v4 surface: `credentials` is reachable only
 * after `approveConnection` has returned. Approval is what freezes the host ceiling, so
 * collecting a secret first would mean collecting it against an unfrozen one. The wall
 * lives in `advanceFromReview` — the ONLY transition into the credentials half — so
 * there is one place to audit rather than one per screen.
 *
 * Q5 — THIS MODULE INTENTIONALLY EXPOSES NO INFERENCE SEAM, and must never grow one. The
 * paste-docs rung belongs to BUILD/EDIT chat, where the model is already the author and
 * the user is already in an authoring posture. Offering it at RUN time asks a person who
 * only wanted to USE their app to adjudicate a model's guess about a provider's auth
 * scheme, at the exact moment they are least equipped to and most motivated to click
 * past it. The removal is structural — nothing here to hide, nothing here to gate — and
 * the P3 suite reads this file's own bytes to keep it that way, which is also why the
 * removed entry point is described here rather than named.
 */

import {
  CONNECTION_STATUS,
  NET_ERROR_CODES,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey, type ConnectionRow, type UserDb } from '@snugprotocol/db';
import {
  InMemoryFlowStateStore,
  OAuthService,
  SlotScopedCredentialStore,
  SnugAuthError,
  UserDbCredentialStore,
  executeConnectionTestRequest,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
  requirementToSpec,
  resolveDesktopPosture,
  type DesktopRedirectPosture,
  type FetchLike,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthStartInput,
  type OAuthStartResult,
  type WellKnownAuthOption,
  type WellKnownOauthProvider,
} from '@snugprotocol/auth';

import { createStore } from './store.js';
import { getUserDb } from './userdb.js';
import { connectedFetchDepsFor, invalidateNetGrants } from './net.js';
import { getPlatform } from '../platform/platform.js';

export type ConnectionWizardStep = 'review' | 'register' | 'credentials' | 'connect' | 'done';

export type ConnectionWizardSource = 'settings' | 'error_cta' | 'directive';

export type ConnectionWizardMode = 'connect' | 'reapprove';

export interface ConnectionWizardSession {
  appId: string;
  /** The connection SLOT this session operates on — the R6 keying, surfaced in the UI. */
  slot: string;
  source: ConnectionWizardSource;
  mode: ConnectionWizardMode;
}

export interface OpenConnectionWizardRequest {
  appId: string;
  slot: string;
  source: ConnectionWizardSource;
  mode?: ConnectionWizardMode;
}

/**
 * OAuth flow status, mirrored from the v3 store's shape because the popup lifecycle it
 * describes is unchanged by the v4 cutover — only the SCOPE the flow is built from moved
 * from an app-keyed spec row to a slot-keyed connection row.
 */
export type ConnectionFlowStatus =
  | { state: 'idle' }
  | { state: 'awaiting_callback'; flowId: string }
  | { state: 'exchanging' }
  | { state: 'connected'; scopesGranted?: string[] }
  | { state: 'error'; message: string; authorizeUrl?: string }
  /**
   * Desktop-only (TASK-20260812, Decision 5): the registry's posture for this provider
   * is one the running shell does not implement, so the flow REFUSED before any
   * credential step. Typed — the sheet renders the refusal, never a generic error.
   */
  | { state: 'refused'; refusal: DesktopOAuthRefusal };

export const connectionWizardStore = createStore<ConnectionWizardSession | null>(null);
export const connectionWizardStepStore = createStore<ConnectionWizardStep>('review');
export const connectionWizardSlotStore = createStore<string | null>(null);
export const connectionWizardNoteStore = createStore<string | null>(null);
export const connectionFlowStatusStore = createStore<ConnectionFlowStatus>({ state: 'idle' });

/**
 * A revision counter the sheet subscribes to so a WRITE performed here (approve,
 * re-approve) re-reads the row. The alternative — pushing the row into a store — would
 * reintroduce exactly the cached-requirement staleness the module doc rejects; a bare
 * "something changed" tick keeps the row itself the single source.
 */
export const connectionWizardRevisionStore = createStore<number>(0);

function bumpRevision(): void {
  connectionWizardRevisionStore.set(connectionWizardRevisionStore.get() + 1);
}

/**
 * External-writer hook (state/authKindChoice.ts, P3 item 4b): after a `user`-channel
 * rebind of the OPEN session's own row, pull the wizard back to review and re-read.
 * Reopening through openConnectionWizard would refuse — one wizard at a time — and a
 * bare write would leave the sheet rendering the stale requirement (or, on desktop, a
 * refusal for a flow the user just walked away from).
 */
export function refreshOpenConnectionWizard(appId: string, slot: string): boolean {
  const session = connectionWizardStore.get();
  if (session === null || session.appId !== appId || session.slot !== slot) return false;
  connectionFlowStatusStore.set({ state: 'idle' });
  connectionWizardStepStore.set('review');
  bumpRevision();
  return true;
}

/**
 * Open the wizard for one (app, slot). Returns false — with a visible note — when
 * another session is already parked, matching v3's R2 refusal: two wizards open at once
 * means two approvals racing for one frozen ceiling.
 *
 * SYNCHRONOUS on purpose, and it deliberately does NOT read the DB. Every caller is a
 * click handler, and an async open would either force every call site to await (the v3
 * `openWizardForNetError` trap, where a Promise's truthiness silently dismissed the CTA
 * banner) or open a wizard whose session lands a tick after the render that needed it.
 * The row is read by the SHEET, which can render a loading state honestly.
 */
export function openConnectionWizard(request: OpenConnectionWizardRequest): boolean {
  if (connectionWizardStore.get() !== null) {
    connectionWizardNoteStore.set('a connection wizard is already open — finish or dismiss it first');
    return false;
  }
  connectionWizardNoteStore.set(null);
  connectionFlowStatusStore.set({ state: 'idle' });
  connectionWizardStepStore.set('review');
  connectionWizardSlotStore.set(request.slot);
  connectionWizardStore.set({
    appId: request.appId,
    slot: request.slot,
    source: request.source,
    mode: request.mode ?? 'connect',
  });
  bumpRevision();
  return true;
}

/**
 * The CHAT-CARD and RUN-CTA mount (plan §6 item 3): open the wizard for whichever slot
 * of this app most needs attention, so both entry points land on the SAME wizard rather
 * than each inventing its own notion of "the connection".
 *
 * A DOORBELL, NEVER AN AUTHORITY — the v3 trust rule, restated for v4 and made structural
 * by the cutover. A chat directive carries no requirement any more: the requirement was
 * already persisted at BUILD time by the post-turn pipeline, gated by schema, admission
 * and the template lint. So all a card can do here is name an app; what is REVIEWED comes
 * from the row. There is no longer a channel through which a directive could propose
 * endpoints or field labels at click time, which is what made the v3 re-ladder necessary.
 *
 * Priority is the order a person would want: a staged change first (something is waiting
 * on them), then an unconnected slot (something is not working yet). An all-approved app
 * opens its first slot, which is the manage view.
 */
export async function openConnectionWizardForApp(
  appId: string,
  source: ConnectionWizardSource,
): Promise<boolean> {
  const db = await getUserDb();
  const rows = db.listConnections(appId);
  if (rows.length === 0) {
    // F4 (TASK-20260812) — the zero-row refusal must never be silent. This is the state
    // the owner's Coinbase app was in: no requirement row ever persisted, so the
    // net-error banner's CTA called here, got `false`, and NOTHING visible happened.
    // The explanation is written where the DECISION is made, so every caller — the
    // banner CTA, the chat card, settings — inherits it rather than each translating
    // `false` on its own. Rendered by `ConnectionWizardNote` (the store finally has a
    // surface). Forward-only repair per owner decision Q4: the route out is asking the
    // app's agent to declare the connection, not the host inventing a row here.
    connectionWizardNoteStore.set(
      'this app has no connection set up yet, so there is nothing to connect — open the app\'s chat and ask it to declare the connection it needs',
    );
    return false;
  }
  const staged = rows.find((row) => needsReapproval(row));
  if (staged !== undefined) {
    return openConnectionWizard({ appId, slot: staged.slot, source, mode: 'reapprove' });
  }
  const unconnected = rows.find((row) => row.status !== CONNECTION_STATUS.approved);
  const target = unconnected ?? rows[0]!;
  return openConnectionWizard({ appId, slot: target.slot, source });
}

/**
 * The net-error CTA mount. Consults ONLY the error CODE, never a message substring.
 *
 * Off-ceiling and confirm-denied codes deliberately get NO wizard: routing them to a
 * connect CTA would coach the user into widening a ceiling in direct response to an
 * attack. Every code that reaches here is auth-repairable as shipped.
 *
 * THE RESOLVED BOOLEAN IS THE CONTRACT. A Promise is always truthy, so a caller that
 * writes `if (openConnectionWizardForNetError(...))` dismisses its CTA banner even when
 * the wizard REFUSED to open — stranding the user with no route back to the connection.
 * Callers must await, then branch.
 */
export async function openConnectionWizardForNetError(appId: string, code: string): Promise<boolean> {
  if (!isConnectionRepairableNetError(code)) return false;
  return openConnectionWizardForApp(appId, 'error_cta');
}

/** Codes a connection wizard can actually repair. Code-keyed, never message-matched. */
const AUTH_REPAIRABLE_NET_CODES = new Set<string>([
  NET_ERROR_CODES.NET_AUTH_FAILED,
  NET_ERROR_CODES.NET_NOT_APPROVED,
  NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
]);

/**
 * Should a net error surface a connect CTA at all? The run view asks this BEFORE it
 * renders a banner, so an off-ceiling or confirm-denied failure shows nothing rather than
 * a button that would teach the user to widen a ceiling under attack.
 */
export function isConnectionRepairableNetError(code: string): boolean {
  return AUTH_REPAIRABLE_NET_CODES.has(code);
}

/**
 * The two states in which a sign-in is genuinely MID-FLIGHT: the popup is open and we are
 * waiting for the provider to call back, or the code came back and the token exchange is
 * running. Everything else — idle, connected, error — is settled, and a settled wizard
 * must close without ceremony.
 */
const IN_FLIGHT_FLOW_STATES = new Set<ConnectionFlowStatus['state']>(['awaiting_callback', 'exchanging']);

export function isConnectionFlowInFlight(): boolean {
  return IN_FLIGHT_FLOW_STATES.has(connectionFlowStatusStore.get().state);
}

/**
 * Dismissal, gated (owner decision 2026-08-10; restores the v3 `requestCloseWizard`
 * semantics the P3 rebuild dropped).
 *
 * Returns `'needs_confirm'` WITHOUT touching anything when a sign-in is mid-flight — the
 * session survives, the popup stays open, the channel stays subscribed — so one stray Esc
 * can no longer discard a sign-in the user is halfway through. The caller then asks, and
 * an explicit yes calls `forceCloseWizard`.
 *
 * The gate is deliberately narrow: only `awaiting_callback` and `exchanging` ask. A prompt
 * on every close would train the user to dismiss it reflexively, which costs the
 * protection it was added for.
 */
export function closeConnectionWizard(): 'closed' | 'needs_confirm' {
  if (isConnectionFlowInFlight()) return 'needs_confirm';
  forceCloseWizard();
  return 'closed';
}

/**
 * The unconditional close — the confirm's landing point, and the only path that tears down
 * an in-flight flow.
 *
 * The teardown itself is UNCHANGED and must not be weakened: a channel, poll or popup left
 * alive over a dismissed session means a returning callback writing into a flow nobody is
 * watching, and a poll that will later error a status belonging to somebody else's flow.
 * This function is what the v3 hardening protected; the confirm above only decides WHO
 * triggers it.
 */
export function forceCloseWizard(): void {
  teardownFlow();
  connectionWizardStore.set(null);
  connectionWizardStepStore.set('review');
  connectionWizardSlotStore.set(null);
  connectionFlowStatusStore.set({ state: 'idle' });
}

// ---------------------------------------------------------------------------
// The derived machine
// ---------------------------------------------------------------------------

/** A `registration` seat with actual content is what earns the register screen. */
export function hasRegistrationWalkthrough(requirement: ConnectionRequirement | undefined): boolean {
  const registration = requirement?.registration;
  if (registration === undefined) return false;
  return registration.consoleUrl !== undefined || (registration.instructions ?? []).length > 0;
}

/** OAuth is the only kind whose credentials step is followed by a browser round trip. */
export function needsOAuthConnectStep(requirement: ConnectionRequirement | undefined): boolean {
  return requirement?.kind === 'oauth2_auth_code';
}

/**
 * The next screen after `from`, derived from the requirement. Conditional steps are
 * SKIPPED rather than rendered empty (AC1): `register` without a walkthrough and
 * `connect` without OAuth are screens that would ask the user to tap past nothing.
 */
export function nextStep(
  from: ConnectionWizardStep,
  requirement: ConnectionRequirement | undefined,
): ConnectionWizardStep {
  switch (from) {
    case 'review':
      return hasRegistrationWalkthrough(requirement) ? 'register' : 'credentials';
    case 'register':
      return 'credentials';
    case 'credentials':
      return needsOAuthConnectStep(requirement) ? 'connect' : 'done';
    case 'connect':
      return 'done';
    case 'done':
      return 'done';
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type ConnectionWizardResult = { ok: true } | { ok: false; message: string };

async function withSession(
  run: (db: UserDb, session: ConnectionWizardSession) => ConnectionWizardResult,
): Promise<ConnectionWizardResult> {
  const session = connectionWizardStore.get();
  if (session === null) return { ok: false, message: 'no wizard session' };
  try {
    const db = await getUserDb();
    // Re-read the session AFTER the await: a close or re-open during the DB wait must
    // not let this transition write against a slot the user has already left.
    if (connectionWizardStore.get() !== session) return { ok: false, message: 'the wizard session changed' };
    return run(db, session);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * THE B1 WALL. Approve the reviewed requirement, then advance. `approveConnection` is
 * what freezes `allowed_hosts`, so this is also the moment the ceiling the user just
 * read on the review screen becomes the runtime's ceiling — the display and the freeze
 * are the same act, which is why nothing may collect a credential before it.
 *
 * An already-`approved` row (re-entering the wizard to fix a typo'd key) is NOT
 * re-approved: re-approval is `reapproveConnection`'s job and carries a re-freeze the
 * user has not been shown a diff for. It simply advances.
 */
export async function advanceFromReview(): Promise<ConnectionWizardResult> {
  return withSession((db, session) => {
    const row = db.getConnection(session.appId, session.slot);
    if (row === undefined) return { ok: false, message: 'this connection has no declared requirement' };

    if (row.status === CONNECTION_STATUS.declared) {
      const approved = db.approveConnection(session.appId, session.slot);
      // Every approval transition invalidates the app's remembered net grants, so a
      // freshly frozen ceiling is consulted rather than a cached pre-approval verdict.
      invalidateNetGrants(session.appId);
      bumpRevision();
      connectionWizardStepStore.set(nextStep('review', approved.requirement));
      return { ok: true };
    }
    if (row.status === CONNECTION_STATUS.approved) {
      connectionWizardStepStore.set(nextStep('review', row.requirement));
      return { ok: true };
    }
    return { ok: false, message: 'this connection was revoked — declare it again to reconnect' };
  });
}

/** The register screen's only forward move; it writes nothing. */
export async function advanceFromRegister(): Promise<ConnectionWizardResult> {
  return withSession((db, session) => {
    const row = db.getConnection(session.appId, session.slot);
    connectionWizardStepStore.set(nextStep('register', row?.requirement));
    return { ok: true };
  });
}

/**
 * Promote a staged `pending_requirement_json` and re-freeze the ceiling (AC8). The ONLY
 * widening path. A same-kind change lands on `done` rather than walking the credential
 * screens again: the user's existing secrets are still valid — what changed is what the
 * app may DO with them, which is exactly what the diff they just read described. A KIND
 * rebind (P3 item 4b: the desktop refusal steering to a different flow, e.g. OAuth →
 * personal access token) changes what credential is even asked for, so it walks the
 * register/credentials half — "done" would claim a connection no secret backs.
 */
export async function reapproveFromDiff(): Promise<ConnectionWizardResult> {
  return withSession((db, session) => {
    const before = db.getConnection(session.appId, session.slot);
    const kindChanged =
      before?.pendingRequirement !== undefined && before.pendingRequirement.kind !== before.requirement.kind;
    db.reapproveConnection(session.appId, session.slot);
    invalidateNetGrants(session.appId);
    bumpRevision();
    const after = db.getConnection(session.appId, session.slot);
    connectionWizardStepStore.set(kindChanged ? nextStep('review', after?.requirement) : 'done');
    return { ok: true };
  });
}

/**
 * Save the collected credential values, slot-keyed (P1), then advance.
 *
 * C1 — this is the ONLY function in the wizard surface that touches a credential VALUE,
 * and it is write-only: values arrive from the component's local state, go straight to
 * `snug_secrets`, and are never returned, logged, or written to any row. Nothing here
 * can reach the LLM, the iframe, or a publisher, because none of them is a caller.
 *
 * The values map is keyed by DECLARED FIELD KEY and filtered against the requirement's
 * own `fields`, so a stale draft key left over from a requirement edit cannot write a
 * secret under a name no template will ever read.
 */
export async function saveConnectionCredentials(values: Record<string, string>): Promise<ConnectionWizardResult> {
  const session = connectionWizardStore.get();
  if (session === null) return { ok: false, message: 'no wizard session' };
  try {
    const db = await getUserDb();
    if (connectionWizardStore.get() !== session) return { ok: false, message: 'the wizard session changed' };
    const row = db.getConnection(session.appId, session.slot);
    if (row === undefined) return { ok: false, message: 'this connection has no declared requirement' };
    // The B1 wall, restated at the WRITE rather than only at the transition: a credential
    // may only be stored against a FROZEN ceiling. Belt and braces on purpose — this is
    // the function that touches the secret, so it states its own precondition.
    if (row.status !== CONNECTION_STATUS.approved) {
      return { ok: false, message: 'approve this connection before saving credentials' };
    }

    // A CREDENTIAL-BEARING KIND WITH NO FIELDS IS A REFUSAL, NEVER A SUCCESS.
    //
    // The loop below is field-driven: with an empty list it runs zero times, stores
    // nothing, and used to fall through to `{ok:true}` — advancing the machine to `done`
    // and showing the user a CONNECTED connection holding no credential. That is the exact
    // failure the `missing`-field check in `CredentialsScreen` names ("showed connected,
    // turning an answerable problem now into a NET_AUTH_FAILED round trip later"), except
    // arrived at through an empty array rather than an empty value, so that check is
    // vacuously satisfied and never fires.
    //
    // This is defence in depth. The cause was `applyRegistryValues` dropping the registry's
    // pinned `fields` (fixed in packages/auth), and the field list should always arrive now.
    // But "no boxes to type in" must never again be able to READ as success, whatever
    // produces it — a silent success is worse than a failure because nothing prompts the
    // user to look, and the eventual 401 points nowhere near here.
    //
    // `kind:'none'` is exempt and that exemption is the point of testing the kind rather
    // than the array: it declares a connection that legitimately collects no credential, so
    // an empty field list is the CORRECT shape and refusing it would break a working
    // posture.
    if (row.requirement.kind !== 'none' && (row.requirement.fields ?? []).length === 0) {
      return {
        ok: false,
        message: 'this connection declares no credential fields — there is nothing to collect, so it cannot be connected',
      };
    }

    for (const field of row.requirement.fields ?? []) {
      const value = values[field.key];
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (trimmed === '') continue;
      db.setSecret(authConnectionCredentialSecretKey(session.appId, session.slot, field.key), trimmed);
    }
    bumpRevision();
    connectionWizardStepStore.set(nextStep('credentials', row.requirement));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Post-revoke disclosure (AC9)
// ---------------------------------------------------------------------------

export interface RevokedBefore {
  /** The slot whose grant was revoked — may differ from the one being connected now. */
  slot: string;
  providerName: string;
  revokedAt?: string;
}

/**
 * Has the user revoked THIS PROVIDER for this app before? Keyed by provider NAME or by
 * any shared declared HOST — never by slot.
 *
 * WHY NOT SLOT-KEYED, stated as a limit rather than a claim. A slot-keyed disclosure is
 * trivially evaded: re-declare the same provider under a fresh slot name and the notice
 * vanishes. Matching on provider-or-host raises that bar, and it is worth stating plainly
 * that the evasion never bought silent credential REUSE even before this — revoke wipes
 * the slot's secrets and a new slot lands `declared`, facing the full strong review. So
 * this is UX HONESTY, not a security boundary, and must never be described as one. It is
 * implemented against evasion anyway because honesty that holds only while nobody tries
 * is not honesty.
 *
 * The tombstone is what makes this possible at all: `revokeConnection` KEEPS the row.
 */
export function findRevokedBefore(
  db: UserDb,
  appId: string,
  requirement: ConnectionRequirement,
  currentSlot: string,
): RevokedBefore | undefined {
  const providerKey = requirement.provider.name.trim().toLowerCase();
  const hosts = new Set(requirement.declaredApiHosts);
  for (const row of db.listConnections(appId)) {
    if (row.slot === currentSlot) continue;
    if (row.status !== CONNECTION_STATUS.revoked) continue;
    const sameProvider = row.requirement.provider.name.trim().toLowerCase() === providerKey;
    const sharesHost = row.requirement.declaredApiHosts.some((host) => hosts.has(host));
    if (!sameProvider && !sharesHost) continue;
    return {
      slot: row.slot,
      providerName: row.requirement.provider.name,
      ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
    };
  }
  return undefined;
}

/**
 * "Needs re-approval", DERIVED (fold B2) — the single definition both the Settings pill
 * and the wizard's diff branch read. Never a fourth persisted status: a fourth value
 * would let a stage-time write move a row OUT of `approved`, silently de-authorizing a
 * grant the user never touched, which is precisely what the pending column prevents.
 */
export function needsReapproval(row: Pick<ConnectionRow, 'status' | 'pendingRequirement'> | undefined): boolean {
  return row !== undefined && row.status === CONNECTION_STATUS.approved && row.pendingRequirement !== undefined;
}

// ---------------------------------------------------------------------------
// Q7 — "test this connection" (the done screen's probe)
// ---------------------------------------------------------------------------

/** What the done screen renders after a probe. Never carries a credential value. */
export type ConnectionTestOutcome =
  | { ok: true; status: number }
  | { ok: false; code: string; message: string };

/**
 * Run the requirement's declared probe through the REAL connected-fetch executor.
 *
 * IT IS A THIN PASS-THROUGH TO `executeConnectionTestRequest`, AND THAT IS THE POINT. The
 * natural implementation of a "test" button is a small dedicated fetch, which would be a
 * SECOND NETWORK PATH: a second host channel with no frozen-ceiling check, a second
 * injection seat with no scrub on the way back, and a second confirm bypass — reachable
 * from the one surface whose whole purpose is to be clicked while credentials are fresh.
 * So the probe goes through the same ten gates as every app request, and this function
 * exists only to assemble the executor's deps from the page user DB.
 *
 * P1 shipped that executor with NO production caller. This is the caller — which is the
 * whole reason the seat matters: a security property that only holds in a test is a
 * property the shipped path does not have.
 *
 * C1 — the RESULT is what the screen renders, and the executor has already scrubbed it.
 * Nothing here reads a credential; the injection happens inside the executor and the
 * value never crosses back out.
 */
export async function testConnection(
  /**
   * Injectable for tests only, and defaulted so production has no seam to misconfigure —
   * the same shape `createNetHandlerFor` already exposes for the e2e stub. It reaches the
   * executor as `fetchImpl`, which means it is subject to every gate above it: a test
   * cannot use this to skip the frozen ceiling, the confirm, or the scrub.
   */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ConnectionTestOutcome> {
  const session = connectionWizardStore.get();
  if (session === null) return { ok: false, code: 'NO_SESSION', message: 'no wizard session' };
  const db = await getUserDb();
  if (connectionWizardStore.get() !== session) {
    return { ok: false, code: 'SESSION_CHANGED', message: 'the wizard session changed' };
  }
  // THE SAME DEPS THE APP RUNTIME USES — same confirm gate instance, same store, same
  // unfiltered reader. Assembling a second deps object here would configure a second
  // network path with its own gates, which is precisely what the single-path discipline
  // around `executeConnectionTestRequest` exists to prevent.
  const result = await executeConnectionTestRequest(
    fetchImpl === undefined ? connectedFetchDepsFor(db) : connectedFetchDepsFor(db, fetchImpl),
    session.appId,
    session.slot,
  );
  if (!result.ok) return { ok: false, code: result.code, message: result.message };

  /**
   * A 2xx IS THE ONLY PASS, and this translation is the reason the probe is worth having.
   *
   * `ConnectedFetchResult.ok` means the HTTP CALL SUCCEEDED — the executor is right to
   * return `ok: true` for a 401, because from its altitude a delivered response IS the
   * successful outcome and inventing an auth verdict from a status code is not its job.
   * But this surface answers a different question: "do the credentials I just pasted
   * work?" A 401 answers that with a flat no, and reporting it as "it works" would send
   * the user away believing a broken connection is fine — then hand them the same failure
   * later, inside their running app, in a vocabulary they never chose.
   *
   * The message names the STATUS and nothing else. A provider's error BODY is the most
   * likely place for a credential echo, and this screen is the worst possible place to
   * print one.
   */
  if (result.status >= 200 && result.status < 300) return { ok: true, status: result.status };
  return {
    ok: false,
    code: `HTTP_${result.status}`,
    message:
      result.status === 401 || result.status === 403
        ? `${result.status} — the provider rejected these credentials. Check you pasted them correctly, and that the key is still active.`
        : `the provider answered ${result.status}.`,
  };
}

// ---------------------------------------------------------------------------
// The OAuth connect step (P3 fold) — REINSTATED on the v4 slot-keyed row
// ---------------------------------------------------------------------------
//
// WHY THIS IS BACK, stated as the defect it repairs. The P3 cutover deleted the v3 wizard
// store and with it a complete, hardened three-legged flow, and left the connect screen a
// static paragraph promising "a sign-in window will open". Nothing opened one. There was no
// popup, no exchange, and no forward affordance at all — a terminal dead end for every
// OAuth app, invisible to a suite whose only assertion at that screen was the step's NAME.
//
// IT IS A PORT, NOT A REWRITE, and that is deliberate: every guard below was paid for by a
// real defect in the v3 flow (a leaked poll that killed later flows, a popup blocked into a
// permanent spinner, a completed mint landing a window over a dismissed wizard, a delivery
// binding to a flowId it had itself supplied). Rebuilding from scratch would mean earning
// each of those again on users.
//
// WHAT ACTUALLY CHANGED is only the SCOPE the flow is built from: v3 read an app-keyed
// `snug_auth_specs` row through `requireApprovedSpecScope`; v4 reads the (app, SLOT)
// connection row and uses its FROZEN `allowedHosts`. The popup lifecycle is untouched by
// that, which is precisely why the port is honest. Two pieces of the executor's own
// plumbing are reused rather than reimplemented — `SlotScopedCredentialStore` (so tokens
// land under `auth:<appId>:<slot>:*` and one slot can never serve another's) and
// `requirementToSpec` (the single dialect translation) — because a second copy of either
// is a copy that can drift, and a drifted re-key is a token served to the wrong provider.
//
// C1 — no credential VALUE crosses this boundary. Client credentials are read back from
// `snug_secrets` INSIDE the service, through the slot-scoped store; nothing here returns,
// logs, or renders one, and the only value a caller passes in is the client id it just
// collected on the credentials screen.

// ---------------------------------------------------------------------------
// Desktop redirect posture (TASK-20260812 W2a; ADR-0021 Decisions 1/3/5)
// ---------------------------------------------------------------------------
//
// The posture is REGISTRY DATA, resolved at connect/render time via
// `lookupWellKnownProvider` + `resolveDesktopPosture` — never a requirement seat,
// never persisted. On the web platform none of this applies (the popup path handles
// every posture); on desktop the wizard either uses a loopback transport or refuses
// HONESTLY before any credential is collected (AC6), steering to the provider's other
// registry options where they exist.

/** The postures the SHIPPED desktop transport implements (loopback listener only). */
const IMPLEMENTED_DESKTOP_POSTURES = new Set<DesktopRedirectPosture>(['loopback', 'loopback-fixed-port']);

export interface DesktopOAuthAlternative {
  /** The registry's human label for the flow — what the button says. */
  label: string;
  /**
   * The flow's COMPLETE registry-built requirement, ready for the `user` channel
   * (`chooseAuthOption`). Registry-pinned seats only — nothing model-proposed.
   */
  requirement: ConnectionRequirement;
}

export interface DesktopOAuthRefusal {
  providerName: string;
  /** The unsupported posture — or 'unvouched' when the registry names none at all. */
  posture: DesktopRedirectPosture | 'unvouched';
  /** Human labels of this provider's registry flows that DO work on this shell. */
  alternativeLabels: string[];
  /**
   * The same flows as ROUTES (P3 item 4b): a refusal that names a way in must offer
   * a button that goes there, not advice to go ask the chat.
   */
  alternatives: DesktopOAuthAlternative[];
}

/**
 * Which registry flow is this requirement? Kind-keyed on the `option ?? entry` seat
 * rule (ADR-0020): the entry itself is the DEFAULT flow; an option matches when the
 * requirement carries ITS kind. Kind is the discriminator the choice card rebinds, so
 * it is the honest handle here — fields may have been substituted since.
 */
function matchedRegistryOption(
  entry: WellKnownOauthProvider,
  requirement: ConnectionRequirement,
): WellKnownAuthOption | undefined {
  if (entry.kind === requirement.kind) return undefined;
  return (entry.authOptions ?? []).find((option) => option.kind === requirement.kind);
}

/**
 * The desktop redirect posture for this requirement's flow. An UNKNOWN provider (the
 * user's own IdP, a self-hosted service) defaults to the ephemeral loopback posture —
 * RFC 8252 §7.3's any-port listener, the transport a BYO registration can always
 * honor. A KNOWN provider resolves through the registry, and a registry entry that
 * names no posture resolves to 'unvouched': the wizard must refuse, never guess.
 */
export function desktopOAuthPostureFor(requirement: ConnectionRequirement): DesktopRedirectPosture | 'unvouched' {
  const entry = lookupWellKnownProvider(requirement.provider.name);
  if (entry === undefined) return 'loopback';
  return resolveDesktopPosture(entry, matchedRegistryOption(entry, requirement)) ?? 'unvouched';
}

/**
 * The provider's OTHER flows that work on this shell — the refusal's steer, each with
 * the registry-built requirement the `user` channel can rebind to (P3 item 4b).
 */
function alternativeFlows(entry: WellKnownOauthProvider, requirement: ConnectionRequirement): DesktopOAuthAlternative[] {
  const flows: Array<{ kind: ConnectionRequirement['kind']; label?: string; option?: WellKnownAuthOption }> = [
    { kind: entry.kind, ...(entry.optionLabel !== undefined ? { label: entry.optionLabel } : {}) },
    ...(entry.authOptions ?? []).map((option) => ({ kind: option.kind, label: option.label, option })),
  ];
  const alternatives: DesktopOAuthAlternative[] = [];
  for (const flow of flows) {
    if (flow.label === undefined) continue;
    if (flow.kind === 'oauth2_auth_code') {
      const posture = resolveDesktopPosture(entry, flow.option);
      if (posture === undefined || !IMPLEMENTED_DESKTOP_POSTURES.has(posture)) continue;
    }
    alternatives.push({
      label: flow.label,
      requirement: requirementFromRegistryEntry(entry, requirement.provider.name, requirement.slot, flow.option),
    });
  }
  return alternatives;
}

/**
 * Should the desktop wizard REFUSE this OAuth requirement before collecting anything?
 * `undefined` on the web platform (always), for non-OAuth kinds (postures are a
 * redirect-transport concern), and for postures the shell implements. The sheet calls
 * this at the register/credentials gate; the flow calls it again as defence in depth.
 */
export function desktopOAuthRefusalFor(requirement: ConnectionRequirement): DesktopOAuthRefusal | undefined {
  if (getPlatform().oauth === undefined) return undefined;
  if (requirement.kind !== 'oauth2_auth_code') return undefined;
  const posture = desktopOAuthPostureFor(requirement);
  if (posture !== 'unvouched' && IMPLEMENTED_DESKTOP_POSTURES.has(posture)) return undefined;
  const entry = lookupWellKnownProvider(requirement.provider.name);
  const alternatives = entry === undefined ? [] : alternativeFlows(entry, requirement);
  return {
    providerName: requirement.provider.name,
    posture,
    alternativeLabels: alternatives.map((alternative) => alternative.label),
    alternatives,
  };
}

/** The BroadcastChannel surface, injectable so tests drive delivery without a real bus. */
export interface ConnectionChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** The popup surface, injectable so tests never open a window. */
export interface ConnectionPopupLike {
  closed: boolean;
  close?: () => void;
  /**
   * Point an already-open popup at a URL. Present when the window was opened
   * SYNCHRONOUSLY inside the user's click (the popup-blocker escape): it is created on
   * `about:blank` while the gesture is still live, then navigated here once the async
   * mint resolves. A `window.open` AFTER those awaits is no longer gesture-associated and
   * a default blocker refuses it.
   */
  navigate?: (url: string) => void;
}

/** The OAuthService surface this store drives; a fake stands in for it in tests. */
export interface ConnectionOAuthServiceLike {
  generateAuthUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  handleCallback(input: OAuthCallbackInput): Promise<OAuthCallbackResult>;
}

interface ConnectionOAuthHooks {
  channelFactory?: (name: string) => ConnectionChannelLike;
  openPopup?: (url: string) => ConnectionPopupLike | null;
  service?: ConnectionOAuthServiceLike;
  /** Injectable fetch for the REAL service, so tests drive the full exchange offline. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

let hooks: ConnectionOAuthHooks = {};

export function __setConnectionOAuthHooksForTests(next: ConnectionOAuthHooks): void {
  hooks = next;
  serviceSingleton = null; // a new fetch seam must not be shadowed by a cached service
}

const POPUP_POLL_MS = 500;

interface ActiveFlow {
  start: OAuthStartResult;
  channel: ConnectionChannelLike;
  popup: ConnectionPopupLike | null;
  poll: ReturnType<typeof setInterval> | null;
}

/**
 * STORE-OWNED, never component-owned. The wizard is minutes-lived and the user may
 * navigate while a sign-in window is open; a flow held in a component would be torn down
 * by an unmount and the returning callback would find nobody listening.
 */
let activeFlow: ActiveFlow | null = null;
let flowStateStore = new InMemoryFlowStateStore();
let serviceSingleton: ConnectionOAuthServiceLike | null = null;

/**
 * The service's outbound fetch (token exchange/refresh), platform-sourced (P0
 * amendment 6): test hooks win, then the desktop native fetch, then the service's own
 * page-fetch default (web today). The B2 manual-redirect semantics are the injected
 * transport's contract to honor — pinned in the desktop transport's own suite.
 */
function serviceFetchDep(): { fetch: FetchLike } | Record<string, never> {
  if (hooks.fetchImpl !== undefined) return { fetch: hooks.fetchImpl };
  const platformFetch = getPlatform().fetchImpl;
  return platformFetch !== undefined ? { fetch: platformFetch } : {};
}

/**
 * The redirect URI seam, ONE source for both service call sites AND the register
 * screen's display (Decision 3): the platform's recorded-string provider on desktop,
 * the origin literal on web. `undefined` when the desktop posture is not a loopback —
 * callers must have refused already; this never invents a transport.
 */
function redirectUriSourceFor(requirement: ConnectionRequirement): (() => string | Promise<string>) | undefined {
  const platformOauth = getPlatform().oauth;
  if (platformOauth === undefined) return () => `${window.location.origin}/oauth/callback`;
  const posture = desktopOAuthPostureFor(requirement);
  if (posture === 'unvouched' || !IMPLEMENTED_DESKTOP_POSTURES.has(posture)) return undefined;
  const providerName = requirement.provider.name;
  return () => platformOauth.redirectUriFor({ provider: providerName, posture });
}

function connectionOAuthService(db: UserDb): ConnectionOAuthServiceLike {
  if (hooks.service !== undefined) return hooks.service;
  serviceSingleton ??= new OAuthService({
    // The BARE store: the slot scoping is applied per flow, below, because the service is
    // constructed once while the slot changes per session.
    store: new UserDbCredentialStore(db),
    redirectUriProvider: {
      // ONE seam, both call sites (start and exchange). The provider matches this string
      // character for character, so a second derivation is a second chance to differ —
      // and the register screen shows the user this exact value to register.
      redirectUri: () => `${window.location.origin}/oauth/callback`,
    },
    flowStore: flowStateStore,
    ...serviceFetchDep(),
  });
  return serviceSingleton;
}

/** Per-flow service bound to ONE slot's credential slice. */
function slotBoundService(
  db: UserDb,
  slot: string,
  redirectUri?: () => string | Promise<string>,
): ConnectionOAuthServiceLike {
  if (hooks.service !== undefined) return hooks.service;
  return new OAuthService({
    store: new SlotScopedCredentialStore(new UserDbCredentialStore(db), slot),
    redirectUriProvider: { redirectUri: redirectUri ?? (() => `${window.location.origin}/oauth/callback`) },
    flowStore: flowStateStore,
    ...serviceFetchDep(),
  });
}

function teardownFlow(): void {
  if (activeFlow === null) return;
  if (activeFlow.poll !== null) clearInterval(activeFlow.poll);
  activeFlow.channel.close();
  try {
    activeFlow.popup?.close?.();
  } catch {
    /* the popup is already gone — closing a closed window is not an error worth raising */
  }
  // Desktop: the loopback listener dies with the flow. Fire-and-forget — the listener's
  // absence is the observable outcome, and teardown must stay synchronous for callers.
  const platformOauth = getPlatform().oauth;
  if (platformOauth !== undefined) void platformOauth.cancel().catch(() => undefined);
  activeFlow = null;
}

/**
 * The explicit abandonment affordance (P0 amendment 7). The desktop sign-in runs in
 * the SYSTEM browser — a handle-less window nothing can poll — so the only exits from
 * `awaiting_callback` are delivery, the flow TTL, and this cancel. Lands on `idle`
 * (the "sign in" button returns), never on an error the user did not have.
 */
export function cancelConnectionOAuthFlow(): void {
  teardownFlow();
  connectionFlowStatusStore.set({ state: 'idle' });
}

function defaultChannelFactory(name: string): ConnectionChannelLike {
  const channel = new BroadcastChannel(name);
  const like: ConnectionChannelLike = { onmessage: null, close: () => channel.close() };
  channel.onmessage = (event) => like.onmessage?.({ data: event.data });
  return like;
}

function defaultOpenPopup(url: string): ConnectionPopupLike | null {
  return window.open(url, 'snug-oauth', 'popup,width=480,height=720');
}

/**
 * Open the popup SYNCHRONOUSLY on the click — `about:blank`, no URL yet — so the window
 * rides the user's gesture and a default blocker lets it through. It is navigated to the
 * authorize URL later, once the mint resolves. The component calls this from its handler
 * BEFORE awaiting anything; that ordering is the whole fix.
 */
export function openBlankConnectionOAuthPopup(): ConnectionPopupLike | null {
  const win = window.open('about:blank', 'snug-oauth', 'popup,width=480,height=720');
  // `== null` on purpose: a blocked open is null per spec, but non-conforming
  // environments (jsdom among them) return undefined — both are "no window".
  if (win == null) return null;
  return {
    get closed() {
      return win.closed;
    },
    close: () => win.close(),
    navigate: (url: string) => {
      win.location.href = url;
    },
  };
}

/**
 * THE B1 WALL AT THE FLOW. The scope is built from the APPROVED row and nowhere else:
 * `allowedHosts` is the ceiling frozen at approval, and every token POST the service makes
 * is checked against it. A `declared` or `revoked` row throws before a window opens, so
 * there is no ordering in which a sign-in can be started against an unfrozen ceiling.
 */
function approvedOAuthScope(
  db: UserDb,
  session: ConnectionWizardSession,
): { appId: string; slot: string; spec: NonNullable<ReturnType<typeof requirementToSpec>>; allowedHosts: readonly string[] } {
  const row = db.getConnection(session.appId, session.slot);
  if (row === undefined) throw new Error('this connection has no declared requirement');
  if (row.status !== CONNECTION_STATUS.approved) {
    throw new Error('approve this connection before signing in');
  }
  // The APPROVED requirement, never `pendingRequirement`: a staged edit is a proposal the
  // user has not read a diff for, and minting a token against it would grant exactly what
  // the re-approval screen exists to ask about.
  const spec = requirementToSpec(row.requirement);
  if (spec === null || spec.kind !== 'oauth2_auth_code') {
    throw new Error('this connection does not sign you in');
  }
  return { appId: row.appId, slot: row.slot, spec, allowedHosts: row.allowedHosts };
}

/**
 * Start the three-legged flow for the CURRENT session.
 *
 * `preOpened` is the blank popup the click handler opened synchronously; when present it
 * is navigated here, when absent a popup is opened with the URL directly (the path tests
 * and direct callers take). Either way a bail closes it, so a blank window is never
 * orphaned on the user's screen.
 */
export async function startConnectionOAuthFlow(
  clientCreds: Record<string, string>,
  preOpened?: ConnectionPopupLike | null,
): Promise<void> {
  const session = connectionWizardStore.get();
  if (session === null) {
    preOpened?.close?.();
    throw new Error('no wizard session');
  }
  // Lifecycle guard 1 (entry half): a deliberate restart tears the previous flow down
  // FIRST, so its channel, poll and popup never outlive a second start. Pre-fix, a
  // double-click leaked flow 1's poll, which then killed EVERY later flow within 500ms of
  // `awaiting_callback` the moment its stale popup reported closed.
  if (activeFlow !== null) teardownFlow();

  // Lifecycle guard 2 (staleness): bail after EVERY await if the session closed or was
  // replaced. `openConnectionWizard`/`closeConnectionWizard` replace the session OBJECT,
  // so identity comparison catches close, replace and re-open alike.
  const stale = (): boolean => connectionWizardStore.get() !== session;
  const bail = (): void => {
    preOpened?.close?.();
  };

  const platformOauth = getPlatform().oauth;

  let start: OAuthStartResult;
  let service: ConnectionOAuthServiceLike;
  let scope: ReturnType<typeof approvedOAuthScope>;
  try {
    const db = await getUserDb();
    if (stale()) return bail();
    scope = approvedOAuthScope(db, session); // B1 — throws before any window opens
    if (stale()) return bail();
    const row = db.getConnection(session.appId, session.slot);
    if (row === undefined) throw new Error('this connection has no declared requirement');
    // Decision 5 — the desktop refusal, ALSO here as defence in depth: the sheet gates
    // the credential screens, but a direct caller must be refused before any mint, and
    // the refusal is TYPED so the sheet renders it rather than a generic error.
    const refusal = desktopOAuthRefusalFor(row.requirement);
    if (refusal !== undefined) {
      preOpened?.close?.();
      connectionFlowStatusStore.set({ state: 'refused', refusal });
      return;
    }
    // ONE redirect URI source for the authorize URL, the exchange, and the register
    // screen (Decision 3): platform-provided on desktop, the origin literal on web.
    service = slotBoundService(db, scope.slot, redirectUriSourceFor(row.requirement));
    start = await service.generateAuthUrl({ appId: scope.appId, spec: scope.spec, clientCreds });
  } catch (err) {
    preOpened?.close?.(); // the B1 gate or the mint failed — never orphan the blank window
    throw err;
  }
  if (stale()) return bail();

  // The initiating context knows the channel name because it HOLDS the flowId; the
  // delivery payload can never teach it one. On desktop the channel is the platform's
  // listener-event adapter, keyed by the same held flowId.
  const channel =
    hooks.channelFactory !== undefined
      ? hooks.channelFactory(`snug-oauth-${start.flowId}`)
      : platformOauth !== undefined
        ? platformOauth.channelFor(start.flowId)
        : defaultChannelFactory(`snug-oauth-${start.flowId}`);
  channel.onmessage = (event) => {
    void handleConnectionDelivery(event.data, session, scope, service, start);
  };

  let popup: ConnectionPopupLike | null;
  let poll: ReturnType<typeof setInterval> | null = null;

  if (platformOauth !== undefined) {
    /**
     * DESKTOP (RFC 8252 §8.12, Decision 3): the SYSTEM browser carries the sign-in and
     * the webview never navigates to a provider. Any pre-opened blank window is a web
     * affordance that must not linger; the OS opener needs no gesture escape. The
     * pseudo-popup below is handle-less — `closed` can never flip, so the popup-closed
     * poll is BYPASSED: the flow TTL and the wizard's explicit cancel are the
     * abandonment story (P0 amendment 7).
     */
    preOpened?.close?.();
    try {
      await platformOauth.openExternal(start.authorizeUrl);
    } catch {
      channel.close();
      connectionFlowStatusStore.set({
        state: 'error',
        message: 'could not open your browser for the sign-in — try again',
      });
      return;
    }
    if (stale()) {
      channel.close();
      return;
    }
    popup = { closed: false };
  } else {
    if (preOpened != null && preOpened.navigate !== undefined) {
      preOpened.navigate(start.authorizeUrl);
      popup = preOpened;
    } else {
      preOpened?.close?.(); // a pre-opened popup that cannot navigate is unusable — don't leak it
      popup = (hooks.openPopup ?? defaultOpenPopup)(start.authorizeUrl);
    }

    if (popup === null) {
      /**
       * BLOCKED. A visible error, never a parked `awaiting_callback` — nothing is coming, and
       * a spinner that never resolves is the cruelest possible ending for a person who has
       * already pasted their client id. No flow is installed (so closing needs no confirm),
       * the channel is closed, and the minted authorize URL rides the status so the UI can
       * offer a gesture-associated fallback link.
       */
      channel.close();
      connectionFlowStatusStore.set({
        state: 'error',
        message: 'the sign-in window was blocked — allow popups for this site and try again',
        authorizeUrl: start.authorizeUrl,
      });
      return;
    }

    // The popup-closed backstop: BroadcastChannel delivery has NO failure signal, so a user
    // who closes the window mid-sign-in would otherwise wait forever. Web only — the
    // desktop pseudo-popup has no window to observe.
    const openedPopup = popup;
    poll = setInterval(() => {
      if (openedPopup.closed && connectionFlowStatusStore.get().state === 'awaiting_callback') {
        connectionFlowStatusStore.set({ state: 'error', message: 'the sign-in window closed — try again' });
        teardownFlow();
      }
    }, POPUP_POLL_MS);
  }

  // Lifecycle guard 1 (assignment half): the awaits above may have raced another start
  // that installed a flow meanwhile, so ALWAYS tear down immediately before assigning —
  // an overwrite must never leak the prior channel or interval.
  teardownFlow();
  activeFlow = { start, channel, popup, poll };
  connectionFlowStatusStore.set({ state: 'awaiting_callback', flowId: start.flowId });
}

/**
 * Parse-don't-trust over the delivered payload; the flow BINDING is the HELD copy.
 *
 * `expectedFlowId` comes from `start.flowId` — the initiator's own value — and never from
 * the delivery, which is the entire point: a state signed with the right key for the WRONG
 * flow must still be refused, or the binding is a tautology that verifies a value against
 * itself.
 */
async function handleConnectionDelivery(
  data: unknown,
  session: ConnectionWizardSession,
  scope: ReturnType<typeof approvedOAuthScope>,
  service: ConnectionOAuthServiceLike,
  start: OAuthStartResult,
): Promise<void> {
  if (activeFlow === null || connectionWizardStore.get() !== session) return;
  if (typeof data !== 'object' || data === null) return;
  const delivery = data as Record<string, unknown>;
  const code = delivery['code'];
  const state = delivery['state'];
  if (typeof code !== 'string' || typeof state !== 'string' || code.length === 0 || state.length === 0) return;

  connectionFlowStatusStore.set({ state: 'exchanging' });
  try {
    const result = await service.handleCallback({
      appId: scope.appId,
      spec: scope.spec,
      allowedHosts: scope.allowedHosts,
      code,
      state,
      expectedFlowId: start.flowId, // the HELD copy, never parsed out of the delivery
    });
    connectionFlowStatusStore.set({
      state: 'connected',
      ...(result.scopesGranted !== undefined ? { scopesGranted: result.scopesGranted } : {}),
    });
    // A minted token is a working connection, so the app's remembered net verdicts are
    // stale — same rule as every other grant transition (R3).
    invalidateNetGrants(scope.appId);
    bumpRevision();
    connectionWizardStepStore.set('done');
  } catch (err) {
    const message =
      err instanceof SnugAuthError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err);
    connectionFlowStatusStore.set({ state: 'error', message });
  } finally {
    teardownFlow();
  }
}

export function __resetConnectionWizardForTests(): void {
  teardownFlow();
  hooks = {};
  serviceSingleton = null;
  flowStateStore = new InMemoryFlowStateStore();
  connectionWizardStore.set(null);
  connectionWizardStepStore.set('review');
  connectionWizardSlotStore.set(null);
  connectionWizardNoteStore.set(null);
  connectionFlowStatusStore.set({ state: 'idle' });
  connectionWizardRevisionStore.set(0);
}
