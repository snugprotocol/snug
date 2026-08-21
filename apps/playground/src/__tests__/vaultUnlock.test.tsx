// TASK-20260820 — the unlock screen (AC10, AC11, AC28).
//
// WHAT THIS SCREEN IS FOR. Someone opens Snug and their file is protected. They are
// one correct passphrase away from everything they own, and one wrong assumption away
// from believing they have lost it. So the copy has exactly two jobs: make the common
// case (typo) feel ordinary, and make the rare case (genuinely forgotten) point at the
// Recovery Key instead of at despair.
//
// The tests assert MEANING, not markup — what a worried person can actually find.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const unlockUserDb = vi.fn();
vi.mock('../state/userdb.js', () => ({
  unlockUserDb: (...args: unknown[]) => unlockUserDb(...args) as unknown,
}));

const { UnlockScreen } = await import('../vault/UnlockScreen.js');

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<UnlockScreen />);
  });
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  unlockUserDb.mockReset();
});

const text = (): string => container?.textContent ?? '';
const byLabel = (re: RegExp): HTMLInputElement => {
  const labels = Array.from(container!.querySelectorAll('label'));
  const label = labels.find((l) => re.test(l.textContent ?? ''));
  if (label === undefined) throw new Error(`no label matching ${String(re)}`);
  const id = label.getAttribute('for');
  return container!.querySelector<HTMLInputElement>(`#${id}`)!;
};
const button = (re: RegExp): HTMLButtonElement => {
  const buttons = Array.from(container!.querySelectorAll('button'));
  const hit = buttons.find((b) => re.test(b.textContent ?? '') || re.test(b.getAttribute('aria-label') ?? ''));
  if (hit === undefined) throw new Error(`no button matching ${String(re)}`);
  return hit;
};
async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the unlock screen', () => {
  it('asks for the passphrase and hands it to the unlock', async () => {
    unlockUserDb.mockResolvedValue(true);
    await render();
    await type(byLabel(/passphrase/i), 'my secret');
    await click(button(/unlock/i));
    expect(unlockUserDb).toHaveBeenCalledWith({ passphrase: 'my secret' });
  });

  it('masks the passphrase by default and can reveal it', async () => {
    // Revealing matters more than it looks: a long passphrase typed blind is the most
    // common reason a correct one "does not work".
    await render();
    expect(byLabel(/passphrase/i).type).toBe('password');
    await click(button(/show|reveal/i));
    expect(byLabel(/passphrase/i).type).toBe('text');
  });

  it('treats a wrong passphrase as ordinary — no alarm, and it stays retryable', async () => {
    unlockUserDb.mockResolvedValue(false);
    await render();
    await type(byLabel(/passphrase/i), 'wrong');
    await click(button(/unlock/i));

    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent ?? '').toMatch(/did not|didn't|incorrect|try again/i);
    // It must NOT imply damage or loss — that is the lie this whole design avoids.
    expect(alert?.textContent ?? '').not.toMatch(/corrupt|damaged|lost|deleted/i);
    expect(button(/unlock/i).disabled).toBe(false);
  });

  it('offers the Recovery Key as the way out of a forgotten passphrase', async () => {
    unlockUserDb.mockResolvedValue(true);
    await render();
    await click(button(/recovery key/i));
    await type(byLabel(/recovery key/i), 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-5');
    await click(button(/unlock/i));
    expect(unlockUserDb).toHaveBeenCalledWith({ recoveryKey: 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-5' });
  });

  it('says plainly that nobody can reset it — before the user asks', async () => {
    await render();
    // The honest sentence has to be on the screen the user is stuck on, not buried in
    // a help page they will never reach.
    expect(text()).toMatch(/no one|nobody|cannot be reset|can't be reset|no way to reset/i);
  });

  it('does not offer "start fresh" or any other destructive escape', async () => {
    await render();
    // A tired person at 1am will click whatever ends the friction. There must be
    // nothing here that trades their data for relief.
    expect(text()).not.toMatch(/start fresh|start over|erase|reset my file|delete/i);
  });

  it('refuses to submit an empty secret', async () => {
    await render();
    await click(button(/unlock/i));
    expect(unlockUserDb).not.toHaveBeenCalled();
  });
});
