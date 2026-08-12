// Real-DOM driving helpers for the in-shell wizard journey (TASK-20260812 P4).
//
// The journey interacts with the SAME accessible affordances the Playwright e2e
// uses (testids, labels, button names) — querySelector + native events, no
// React internals. React 18 listens for the native `input` event, but a plain
// `el.value = x` never fires the component's onChange because React tracks the
// value through the prototype descriptor — hence the native-setter dance.

const POLL_MS = 100;

export async function waitFor<T>(
  what: string,
  fn: () => T | null | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Fill a React-controlled input/textarea through the native value setter. */
export function fillReactInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter === undefined) throw new Error('missing native value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** First element under `root` matching `selector` whose text matches. */
export function findByText<K extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: K,
  matcher: RegExp,
): HTMLElementTagNameMap[K] | null {
  for (const el of root.querySelectorAll<HTMLElementTagNameMap[K]>(selector)) {
    if (matcher.test(el.textContent ?? '')) return el;
  }
  return null;
}

export function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T & Element>(selector) as T | null;
}
