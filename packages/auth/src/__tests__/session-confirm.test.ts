// AL-03 amendment R3 + open Q1 — per-request confirm with session-remember: grants are
// keyed (app, host, method), live in MEMORY only, and are INVALIDATED on any
// re-approval/host-set change for that app (the settings panel calls `invalidate`).
import { describe, expect, it, vi } from 'vitest';
import { createSessionConfirmGate, type NetConfirmDecision, type NetConfirmRequest } from '../session-confirm.js';

const req = (over: Partial<NetConfirmRequest> = {}): NetConfirmRequest => ({
  appId: 'app-1',
  host: 'api.example.com',
  method: 'POST',
  url: 'https://api.example.com/v1/items',
  ...over,
});

function gateWith(decisions: NetConfirmDecision[]): { gate: ReturnType<typeof createSessionConfirmGate>; prompt: ReturnType<typeof vi.fn> } {
  const queue = [...decisions];
  const prompt = vi.fn(async () => queue.shift() ?? { granted: false });
  return { gate: createSessionConfirmGate(prompt), prompt };
}

describe('createSessionConfirmGate (R3)', () => {
  it('prompts per request; a plain grant is NOT remembered', async () => {
    const { gate, prompt } = gateWith([{ granted: true }, { granted: true }]);
    expect(await gate.confirm(req())).toBe(true);
    expect(await gate.confirm(req())).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('remember-for-session skips the prompt for the SAME (app, host, method) only', async () => {
    const { gate, prompt } = gateWith([
      { granted: true, rememberSession: true },
      { granted: true },
      { granted: true },
      { granted: true },
    ]);
    expect(await gate.confirm(req())).toBe(true);
    expect(await gate.confirm(req())).toBe(true); // remembered — no second prompt
    expect(prompt).toHaveBeenCalledTimes(1);

    await gate.confirm(req({ method: 'DELETE' })); // different method → prompts
    await gate.confirm(req({ host: 'other.example.com' })); // different host → prompts
    await gate.confirm(req({ appId: 'app-2' })); // different app → prompts
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it('a denial is never remembered', async () => {
    const { gate, prompt } = gateWith([{ granted: false, rememberSession: true }, { granted: true }]);
    expect(await gate.confirm(req())).toBe(false);
    expect(await gate.confirm(req())).toBe(true); // prompted again
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('invalidate(appId) clears every grant for that app and no other (re-approval hook)', async () => {
    const { gate, prompt } = gateWith([
      { granted: true, rememberSession: true }, // app-1 POST
      { granted: true, rememberSession: true }, // app-2 POST
      { granted: true }, // app-1 re-prompt after invalidation
    ]);
    await gate.confirm(req());
    await gate.confirm(req({ appId: 'app-2' }));
    expect(prompt).toHaveBeenCalledTimes(2);

    gate.invalidate('app-1');
    await gate.confirm(req()); // app-1 must prompt again
    expect(prompt).toHaveBeenCalledTimes(3);
    await gate.confirm(req({ appId: 'app-2' })); // app-2 grant survives
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('grant keys normalize the host (case/IDN) so remember cannot be dodged by recasing', async () => {
    const { gate, prompt } = gateWith([{ granted: true, rememberSession: true }, { granted: true }]);
    await gate.confirm(req({ host: 'API.Example.com' }));
    await gate.confirm(req({ host: 'api.example.com' }));
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
