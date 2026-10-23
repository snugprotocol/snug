// TASK-20261023-siwc-chatgpt-plan L0 (plan §2, F5/F12): the two playground-side contracts the
// parallel lanes compile against — the platform's custody seat (presence IS the capability;
// L3's desktop platform object must type-check before L4 exists) and the thinking level on
// the turn config (D6: the level reaches the adapter per send). Types only; behaviour is L4.
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChatgptLoopbackSeat, ChatgptSessionStore } from '@snugprotocol/auth';

import type { TurnAdapterConfig } from '../agent/adapter.js';
import type { ChatgptPlanSeat, SnugPlatform } from '../platform/platform.js';

describe('L0 — SnugPlatform.chatgptPlan (D10, AC1)', () => {
  it('is optional — web and host platforms omit it, and omission compiles', () => {
    const web: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };
    expect(web.chatgptPlan).toBeUndefined();
  });

  it('is the custody store + the sign-in loopback + the https opener, nothing else', () => {
    expectTypeOf<ChatgptPlanSeat>().toEqualTypeOf<{
      sessionStore: ChatgptSessionStore;
      loopback: ChatgptLoopbackSeat;
      openExternal(url: string): Promise<void>;
    }>();
    expectTypeOf<SnugPlatform['chatgptPlan']>().toEqualTypeOf<ChatgptPlanSeat | undefined>();
  });
});

describe('L0 — TurnAdapterConfig.effort (D6)', () => {
  it('an optional string in the brain’s own vocabulary — never a mapped tier', () => {
    const config: TurnAdapterConfig = { mode: 'byok', provider: 'mock', effort: 'high' };
    expect(config.effort).toBe('high');
    expectTypeOf<TurnAdapterConfig['effort']>().toEqualTypeOf<string | undefined>();
  });
});
