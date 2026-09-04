// sharedConsentGate.test.tsx — TASK-20260904 AC13(N), Gate-5 findings 3 and 6.
//
// The frame-remount assertion in sharedSurfaces.test.tsx could not tell a consent gate
// from a key change. This file captures the TRANSPORT RunView hands to the frame by
// replacing `SnugAppFrame` with a probe, then drives `send()`:
//   • un-armed: the transport answers CONSENT_REQUIRED, non-retryable — deleting the
//     gate (handing the real transport to previews) turns this red;
//   • armed: the transport is a different object that is NOT the gate;
//   • /run/shared--A armed → /run/shared--B: B mounts un-armed (consent is per preview).
// Plus the unit contract of the gate itself.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_BUNDLE_FORMAT, ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

import { modeStore } from '../state/mode.js';
import { createConsentGateTransport, SHARED_PREVIEW_CONSENT_MESSAGE } from '../share/consentTransport.js';
import { __resetSharedInboxForTests, receiveSharedBundle, sharedRouteIdFor } from '../share/sharedInbox.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The captured transports, newest last. */
const captured: AgentTransport[] = [];

vi.mock('@snugprotocol/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/runner')>();
  const Probe = (props: { transport: AgentTransport }): ReactElement => {
    captured.push(props.transport);
    return <div data-testid="frame-probe" />;
  };
  return { ...actual, SnugAppFrame: Probe };
});

const LINEAGE_A = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';
const LINEAGE_B = '1c7f6b2d-9e6f-4a24-8b3c-8d2e3f4a5b6c';

function bundleText(lineage: string, name: string): string {
  return JSON.stringify({
    format: APP_BUNDLE_FORMAT,
    lineage,
    sharedAt: '2026-09-04T01:00:00.000Z',
    app: { displayName: name, usesDb: false },
    html: `<!doctype html><html><body>${name}</body></html>`,
    connections: [],
  });
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function settleUntil(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

let navigateTo: ((path: string) => void) | undefined;
function NavProbe(): ReactElement {
  navigateTo = useNavigate();
  return <span />;
}

async function renderRun(id: string): Promise<HTMLDivElement> {
  const { default: RunView } = await import('../run/RunView.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/run/${id}`]}>
        <NavProbe />
        <Routes>
          <Route path="/run/:id" element={<RunView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
  return container;
}

const q = (el: ParentNode, testId: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function send(transport: AgentTransport) {
  return transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: new AbortController().signal });
}

beforeEach(async () => {
  modeStore.set('byok');
  await installTestUserDb();
  __resetSharedInboxForTests();
  captured.length = 0;
});

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('createConsentGateTransport — the unit contract', () => {
  it('answers every send with a named, non-retryable CONSENT_REQUIRED refusal', async () => {
    const result = await send(createConsentGateTransport());
    expect(result).toEqual({ ok: false, code: ERROR_CODES.CONSENT_REQUIRED, message: SHARED_PREVIEW_CONSENT_MESSAGE, retryable: false });
  });
});

describe('the shared preview hands the frame the gate until armed (AC13 N)', () => {
  it('un-armed: the mounted transport refuses; armed: a different transport that is not the gate', async () => {
    const received = await receiveSharedBundle(bundleText(LINEAGE_A, 'Alpha'), { source: 'file', persist: true });
    if (!received.ok) throw new Error('receive failed');
    const el = await renderRun(sharedRouteIdFor(received.entry.bundleId));
    await settleUntil(() => q(el, 'frame-probe') !== null && captured.length > 0, 'the probe frame');
    const unarmed = captured.at(-1)!;
    const refused = await send(unarmed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe(ERROR_CODES.CONSENT_REQUIRED);
      expect(refused.retryable).toBe(false);
    }
    await act(async () => {
      q(el, 'shared-run-with-ai')!.click();
    });
    await settleUntil(() => captured.at(-1) !== unarmed, 'a remount with a new transport');
    const armed = captured.at(-1)!;
    expect(armed).not.toBe(unarmed);
    const answer = await send(armed);
    // The real transport (byok + demo brain in tests) is anything but the consent gate.
    if (!answer.ok) expect(answer.code).not.toBe(ERROR_CODES.CONSENT_REQUIRED);
  });

  it('consent is per preview: arming A then navigating to B mounts B un-armed (finding 3)', async () => {
    const a = await receiveSharedBundle(bundleText(LINEAGE_A, 'Alpha'), { source: 'file', persist: true });
    const b = await receiveSharedBundle(bundleText(LINEAGE_B, 'Beta'), { source: 'file', persist: true });
    if (!a.ok || !b.ok) throw new Error('receive failed');
    const el = await renderRun(sharedRouteIdFor(a.entry.bundleId));
    await settleUntil(() => q(el, 'shared-run-with-ai') !== null, 'A');
    await act(async () => {
      q(el, 'shared-run-with-ai')!.click();
    });
    await settleUntil(() => q(el, 'shared-run-with-ai')!.getAttribute('aria-pressed') === 'true', 'A armed');
    await act(async () => {
      navigateTo!(`/run/${sharedRouteIdFor(b.entry.bundleId)}`);
    });
    await settleUntil(() => q(el, 'shared-preview-disclosure') !== null && q(el, 'shared-run-with-ai')?.getAttribute('aria-pressed') === 'false', 'B un-armed');
    const last = captured.at(-1)!;
    const refused = await send(last);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe(ERROR_CODES.CONSENT_REQUIRED);
  });
});
