// TASK-20260820 — the protect-setup flow (AC29, AC31, D2, D3).
//
// THE HARDEST SCREEN IN THE PRODUCT TO GET RIGHT. It asks someone to accept a trade
// most software never asks for: real protection, in exchange for a consequence nobody
// can undo for them. Get the copy wrong in one direction and they turn it on without
// understanding, then lose everything. Wrong in the other and they never turn it on,
// and the feature is decoration.
//
// So the flow is three steps, one idea each, and it refuses to let someone through
// step three by clicking "next" without reading — the typed acknowledgement is the
// only interaction in Snug deliberately designed to be slightly inconvenient.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const enableProtection = vi.fn();
vi.mock('../vault/enableProtection.js', () => ({
  enableProtection: (...args: unknown[]) => enableProtection(...args) as unknown,
}));
vi.mock('../vault/protectOffer.js', () => ({
  deferProtectOffer: vi.fn(),
  declineProtectOfferPermanently: vi.fn(),
  markProtectionEnabled: vi.fn(),
}));

const { ProtectSetupFlow } = await import('../vault/ProtectSetupFlow.js');

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ProtectSetupFlow onDone={() => undefined} />);
  });
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  enableProtection.mockReset();
});

const text = (): string => container?.textContent ?? '';
const maybeButton = (re: RegExp): HTMLButtonElement | undefined =>
  Array.from(container!.querySelectorAll('button')).find((b) => re.test(b.textContent ?? ''));
const button = (re: RegExp): HTMLButtonElement => {
  const hit = maybeButton(re);
  if (hit === undefined) throw new Error(`no button matching ${String(re)}`);
  return hit;
};
const field = (re: RegExp): HTMLInputElement => {
  const label = Array.from(container!.querySelectorAll('label')).find((l) => re.test(l.textContent ?? ''));
  if (label === undefined) throw new Error(`no label matching ${String(re)}`);
  return container!.querySelector<HTMLInputElement>(`#${label.getAttribute('for')}`)!;
};
async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Walk steps 1→2 with a valid, confirmed passphrase. */
async function toRecoveryStep(): Promise<void> {
  enableProtection.mockResolvedValue({ recoveryKey: 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-6' });
  await render();
  await click(button(/protect|turn on|continue/i));
  await type(field(/^passphrase|choose a passphrase/i), 'a long enough passphrase');
  await type(field(/confirm|again/i), 'a long enough passphrase');
  await click(button(/continue|next/i));
}

describe('step 1 — the offer states the trade honestly', () => {
  it('says what it protects AND what it costs, on the same screen', async () => {
    await render();
    expect(text()).toMatch(/passphrase/i);
    // Both halves of the trade, before any commitment. Burying the cost on a later
    // screen would make the consent worthless.
    expect(text()).toMatch(/no one|nobody|cannot|can't/i);
  });

  it('offers a real way out — this is opt-in (D3)', async () => {
    await render();
    expect(maybeButton(/not now|later|skip/i)).toBeDefined();
  });
});

describe('step 2 — choosing a passphrase', () => {
  it('will not continue until both fields match', async () => {
    await render();
    await click(button(/protect|turn on|continue/i));
    await type(field(/^passphrase|choose a passphrase/i), 'a long enough passphrase');
    await type(field(/confirm|again/i), 'a long enough passphrasx');
    expect(button(/continue|next/i).disabled).toBe(true);
    // And it says WHY rather than just sitting there dead.
    expect(text()).toMatch(/match/i);
  });

  it('refuses a trivially short passphrase, without inventing composition rules', async () => {
    await render();
    await click(button(/protect|turn on|continue/i));
    await type(field(/^passphrase|choose a passphrase/i), 'abc');
    await type(field(/confirm|again/i), 'abc');
    expect(button(/continue|next/i).disabled).toBe(true);
    // No "must contain a symbol" theatre — length is what actually helps, and
    // arbitrary rules push people toward Password1! and a sticky note.
    expect(text()).not.toMatch(/symbol|uppercase|special character/i);
  });
});

describe('step 3 — the Recovery Key (D2, AC31)', () => {
  it('shows the generated key and does not let the user leave by just clicking next', async () => {
    await toRecoveryStep();
    expect(text()).toContain('ABCDE-FGHJK');
    // The typed acknowledgement: the one deliberately inconvenient interaction in
    // Snug. Clicking through this screen unread is the failure mode that ends with
    // someone losing everything, so it is made impossible rather than discouraged.
    expect(button(/done|finish/i).disabled).toBe(true);
  });

  it('enables the finish only after the acknowledgement is typed exactly', async () => {
    await toRecoveryStep();
    await type(field(/type/i), 'i saved it');
    expect(button(/done|finish/i).disabled).toBe(false);
  });

  it('offers copy AND download — a key you cannot get out of the screen is not saved', async () => {
    await toRecoveryStep();
    expect(maybeButton(/copy/i)).toBeDefined();
    expect(maybeButton(/download|save/i)).toBeDefined();
  });

  it('states that this key is the ONLY other way in', async () => {
    await toRecoveryStep();
    expect(text()).toMatch(/only other way|only way back|other way in/i);
  });
});

describe('the whole flow', () => {
  it('turns protection on with the chosen passphrase', async () => {
    await toRecoveryStep();
    expect(enableProtection).toHaveBeenCalledWith('a long enough passphrase');
  });

  it('never shows the Recovery Key before the passphrase is settled', async () => {
    // Showing it early invites a screenshot-and-forget, and the key is worthless if
    // the user does not connect it to the passphrase they just chose.
    await render();
    expect(text()).not.toContain('ABCDE-FGHJK');
  });
});
