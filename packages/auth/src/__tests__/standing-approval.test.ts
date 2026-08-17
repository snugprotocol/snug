/**
 * THE STANDING APPROVAL GATE (ADR-0033) — armed auto-reply's host-side seat.
 *
 * The property under test, stated once: **armed is a recorded answer, not a bypass.** An
 * armed send traverses the same executor pipeline as any other write; what changes is that
 * the answer was given ahead of time, frozen to one thread and one trigger. Everything below
 * exists to keep that sentence structurally true rather than aspirational.
 *
 * WHY THIS IS A SEPARATE GATE AND NOT A WIDER SESSION GATE (blocker B2, ADR-0033 §3).
 * `createSessionConfirmGate` keys grants on `(appId, normalizedHost, method)` in an in-memory
 * `Set`. Every armed send is a `POST` to the SAME sidecar host, so that key cannot tell the
 * armed thread from any other thread — remembering one send would authorize all of them,
 * including sends to threads the user never armed. It also has no clock (the rate cap and
 * quiet hours need one), no persistence (its header pins "dies with the page" as a deliberate
 * property), and it is a module-level singleton shared with the wizard's probe path, so
 * widening it would widen the probe too.
 *
 * So the standing gate wraps the session gate rather than replacing or modifying it, and
 * returns NO OPINION outside its frozen scope — at which point the ordinary confirm runs
 * exactly as before. "Consulted before the session gate" is then structural (the wrapper is
 * the only caller) rather than a convention a later edit could quietly invert.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createStandingApprovalGate,
  type StandingGrant,
  type StandingApprovalStore,
} from '../standing-approval.js';

const THREAD = '120363000000000000@g.us';
const OTHER_THREAD = '120363999999999999@g.us';
const HOST = 'whatsapp.sidecar.localhost';

/** A store that keeps grants in a plain array — the shape a real persisted store implements. */
function fakeStore(initial: StandingGrant[] = []): StandingApprovalStore & { rows: StandingGrant[] } {
  const rows = [...initial];
  return {
    rows,
    list: () => rows,
    save: (grant) => {
      const i = rows.findIndex((r) => r.appId === grant.appId && r.slot === grant.slot);
      if (i >= 0) rows[i] = grant;
      else rows.push(grant);
    },
    clear: (appId) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.appId === appId) rows.splice(i, 1);
    },
  };
}

const grantOf = (over: Partial<StandingGrant> = {}): StandingGrant => ({
  appId: 'whatsapp-twin',
  slot: 'whatsapp',
  threadJid: THREAD,
  trigger: 'tagged',
  maxPerWindow: 5,
  windowMs: 60_000,
  quietHours: undefined,
  armedAt: 0,
  sends: [],
  ...over,
});

const req = (over: Partial<Parameters<ReturnType<typeof createStandingApprovalGate>['confirm']>[0]> = {}) => ({
  appId: 'whatsapp-twin',
  host: HOST,
  method: 'POST' as const,
  url: `https://${HOST}/chats/${encodeURIComponent(THREAD)}/messages`,
  slot: 'whatsapp',
  body: JSON.stringify({ text: 'hello' }),
  ...over,
});

describe('the standing gate defers to the session gate outside its scope', () => {
  it('with NO grant at all, the session gate decides — the standing gate never answers', async () => {
    const inner = vi.fn(async () => true);
    const gate = createStandingApprovalGate({ store: fakeStore(), inner: { confirm: inner }, now: () => 0 });

    await expect(gate.confirm(req())).resolves.toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a DENIAL from the session gate is still a denial when nothing is armed', async () => {
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({ store: fakeStore(), inner: { confirm: inner }, now: () => 0 });

    await expect(gate.confirm(req())).resolves.toBe(false);
  });

  it('an armed grant does NOT satisfy a confirm for a DIFFERENT thread (AC8)', async () => {
    // THE LOAD-BEARING NEGATIVE. Every armed send is a POST to the same host, so a gate
    // keyed any less precisely than the thread would authorize sends to conversations the
    // user never armed — the exact failure that rules out widening the session gate.
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    const otherUrl = `https://${HOST}/chats/${encodeURIComponent(OTHER_THREAD)}/messages`;
    await expect(gate.confirm(req({ url: otherUrl, body: JSON.stringify({ text: 'hi' }) }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1); // it fell through to the normal confirm
  });

  it('an armed grant does NOT satisfy a confirm for a different APP', async () => {
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    await expect(gate.confirm(req({ appId: 'some-other-app' }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('an armed grant does NOT satisfy the wizard probe path (AC8)', async () => {
    // The confirm gate is a module-level singleton shared with the wizard's probe
    // (`net.ts:100-118`). A grant that answered for a request carrying no slot would be
    // answering for the probe — a standing approval leaking onto a surface the user never
    // armed and cannot see.
    //
    // FIXTURE NOTE (a surviving mutant earned this). The obvious fixture — the armed
    // request with `slot: undefined` — passes even with the probe check DELETED, because
    // the very next guard (`grant.slot !== request.slot`) refuses `'whatsapp' !== undefined`
    // anyway. It tests the slot-match guard twice and the probe exclusion zero times. So the
    // grant here is armed WITHOUT a slot, which is the only way to isolate the probe check:
    // now every sibling guard would admit this request, and the probe exclusion is the sole
    // thing standing between the wizard's probe and a standing approval.
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ slot: undefined as unknown as string })]),
      inner: { confirm: inner },
      now: () => 0,
    });

    await expect(gate.confirm(req({ slot: undefined }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('an armed grant does NOT satisfy a non-send route on the same thread', async () => {
    // Arming approves SENDING to a thread. It is not a blanket write approval for whatever
    // other mutating routes the helper may grow later.
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    const other = `https://${HOST}/chats/${encodeURIComponent(THREAD)}/archive`;
    await expect(gate.confirm(req({ url: other }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('an in-scope armed send is approved without prompting', () => {
  it('approves, and the session gate is never consulted', async () => {
    const inner = vi.fn(async () => false); // would deny if reached
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    await expect(gate.confirm(req())).resolves.toBe(true);
    expect(inner).not.toHaveBeenCalled();
  });

  it('records the send, so the cap counts real traffic', async () => {
    const store = fakeStore([grantOf()]);
    const gate = createStandingApprovalGate({ store, inner: { confirm: async () => false }, now: () => 1_000 });

    await gate.confirm(req());
    expect(store.rows[0]!.sends).toEqual([1_000]);
  });
});

describe('the thread derivation is itself a security seat (ADR-0033 §3)', () => {
  it('REFUSES when the body JID disagrees with the path JID — never picks one', async () => {
    // Picking either one is a vulnerability with two spellings: trust the path and the body
    // decides where the message really goes; trust the body and the path check was theatre.
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    const body = JSON.stringify({ text: 'hi', jid: OTHER_THREAD });
    await expect(gate.confirm(req({ body }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('agreeing path and body JIDs are fine', async () => {
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: async () => false },
      now: () => 0,
    });

    await expect(gate.confirm(req({ body: JSON.stringify({ text: 'hi', jid: THREAD }) }))).resolves.toBe(true);
  });

  it('a body that is not JSON falls through to the confirm rather than being assumed safe', async () => {
    const inner = vi.fn(async () => false);
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: inner },
      now: () => 0,
    });

    await expect(gate.confirm(req({ body: 'not json at all' }))).resolves.toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a percent-encoded path JID resolves to the same thread as its decoded form', async () => {
    // The app encodes the JID; a gate comparing raw bytes would see a different thread and
    // silently fall through to a prompt on every armed send, making arming look broken.
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: async () => false },
      now: () => 0,
    });

    await expect(gate.confirm(req({ url: `https://${HOST}/chats/${THREAD}/messages` }))).resolves.toBe(true);
  });
});

describe('the guardrails ride the grant, enforced here rather than in the app', () => {
  it('refuses past the rate cap, and the refusal is DISTINGUISHABLE from a user denial (AC8)', async () => {
    // An app that cannot tell "you hit your cap" from "the user said no" will tell the user
    // the wrong thing about their own settings.
    const inner = vi.fn(async () => false);
    const sends = [1, 2, 3, 4, 5];
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ sends, maxPerWindow: 5, windowMs: 60_000 })]),
      inner: { confirm: inner },
      now: () => 100,
    });

    const decision = await gate.decide(req());
    expect(decision.outcome).toBe('rate-capped');
    expect(decision.granted).toBe(false);
    // And it does NOT silently fall through to a prompt: a capped send is refused, not asked.
    expect(inner).not.toHaveBeenCalled();
  });

  it('sends older than the window do not count against the cap', async () => {
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ sends: [1, 2, 3, 4, 5], maxPerWindow: 5, windowMs: 60_000 })]),
      inner: { confirm: async () => false },
      now: () => 1_000_000, // long past the window
    });

    await expect(gate.confirm(req())).resolves.toBe(true);
  });

  // FIXTURE NOTE: quiet hours are LOCAL wall-clock hours, deliberately — "no messages after
  // 10pm" means the user's 10pm, not UTC's. So these fixtures build their instants with the
  // LOCAL constructor. My first draft used `Date.UTC` and failed everywhere except UTC+0,
  // which is the machine-dependent green that makes a suite pass in CI and fail on a laptop.
  const localAt = (hour: number, minute = 0): number => new Date(2026, 7, 16, hour, minute).getTime();

  it('refuses during quiet hours, distinguishably', async () => {
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ quietHours: { startHour: 22, endHour: 7 } })]),
      inner: { confirm: async () => false },
      now: () => localAt(23, 30), // inside a window that wraps midnight
    });

    const decision = await gate.decide(req());
    expect(decision.outcome).toBe('quiet-hours');
    expect(decision.granted).toBe(false);
  });

  it('a midnight-wrapping quiet window still permits the middle of the day', async () => {
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ quietHours: { startHour: 22, endHour: 7 } })]),
      inner: { confirm: async () => false },
      now: () => localAt(13, 0),
    });

    await expect(gate.confirm(req())).resolves.toBe(true);
  });

  it('the small hours are inside a midnight-wrapping window — the other side of the wrap', async () => {
    // 02:00 is before `endHour` and after midnight, so it exercises the OR branch that the
    // 23:30 case cannot reach. Without it, a gate that only checked `hour >= startHour`
    // would pass every quiet-hours test while sending at 2am.
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf({ quietHours: { startHour: 22, endHour: 7 } })]),
      inner: { confirm: async () => false },
      now: () => localAt(2, 0),
    });

    expect((await gate.decide(req())).outcome).toBe('quiet-hours');
  });

  it('the kill switch disarms immediately — the next send is not armed', async () => {
    const store = fakeStore([grantOf()]);
    const gate = createStandingApprovalGate({ store, inner: { confirm: async () => false }, now: () => 0 });

    await expect(gate.confirm(req())).resolves.toBe(true);
    gate.disarm('whatsapp-twin');
    await expect(gate.confirm(req())).resolves.toBe(false);
  });

  it('approve / re-approve / revoke clears standing grants (AC8)', async () => {
    // The same R3 invalidation rule the session gate follows: a widened host set must never
    // ride an old grant. A standing grant outliving a connection change would be a standing
    // approval for a connection the user just changed.
    const store = fakeStore([grantOf()]);
    const gate = createStandingApprovalGate({ store, inner: { confirm: async () => false }, now: () => 0 });

    await expect(gate.confirm(req())).resolves.toBe(true);
    gate.invalidate('whatsapp-twin');
    await expect(gate.confirm(req())).resolves.toBe(false);
    expect(store.rows).toHaveLength(0);
  });

  it('only one thread may be armed at a time (v1) — arming a second replaces the first', async () => {
    const store = fakeStore();
    const gate = createStandingApprovalGate({ store, inner: { confirm: async () => false }, now: () => 0 });

    gate.arm(grantOf());
    gate.arm(grantOf({ threadJid: OTHER_THREAD }));
    expect(store.rows).toHaveLength(1);

    await expect(gate.confirm(req())).resolves.toBe(false); // the first thread is no longer armed
    const otherUrl = `https://${HOST}/chats/${encodeURIComponent(OTHER_THREAD)}/messages`;
    await expect(gate.confirm(req({ url: otherUrl }))).resolves.toBe(true);
  });
});

describe('the grant scope is FROZEN at arm time', () => {
  it('a DM grant (trigger "all") does not become a group grant by changing the request', async () => {
    // Trigger scope is fixed by thread type at arm time; widening requires disarm + re-arm.
    // The request cannot talk the gate into a wider scope than the one recorded.
    const store = fakeStore();
    const gate = createStandingApprovalGate({ store, inner: { confirm: async () => false }, now: () => 0 });
    gate.arm(grantOf({ trigger: 'all' }));

    expect(store.rows[0]!.trigger).toBe('all');
    await gate.confirm(req());
    expect(store.rows[0]!.trigger).toBe('all');
  });

  it('the gate reports what is armed, so the UI can disclose it', async () => {
    // ADR-0033 §2: a standing approval the user cannot see is not an approval.
    const gate = createStandingApprovalGate({
      store: fakeStore([grantOf()]),
      inner: { confirm: async () => false },
      now: () => 0,
    });

    const armed = gate.armedFor('whatsapp-twin');
    expect(armed?.threadJid).toBe(THREAD);
    expect(armed?.trigger).toBe('tagged');
  });
});
