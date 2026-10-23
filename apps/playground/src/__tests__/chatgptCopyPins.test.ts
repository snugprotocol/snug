// chatgptCopyPins.test.ts — TASK-20261023-siwc-chatgpt-plan Gate 3, L5 (plan §1 D9, §12 L5-6;
// interview Q4's label set; ADR-0078 §9).
//
// The words and the one asset this feature may and may not ship, pinned at the source:
//   - NEGATIVE copy pin: no playground source says "not used for training" or "zero retention" —
//     OpenAI's documents never say which data policy covers plan traffic (D9). A walker, so a new
//     file cannot slip the claim in where no rendered test looks;
//   - the D9 data-use sentence VERBATIM in `legal/privacy.ts` AND in at least one non-legal source
//     (the Settings consent band / the egress line) — two homes the legal dependency rule forces
//     (legal modules import nothing from the app), so both are pinned to the same bytes;
//   - the approved label set (owner, Q4) exists in source: Welcome *use your ChatGPT plan*, Settings
//     *my ChatGPT plan*, chip *ChatGPT plan*, popover *Using ChatGPT plan* + *Manage usage*,
//     *Sign out of ChatGPT*, button *Continue with ChatGPT*;
//   - OpenAI's two official button logos (L5-6) are committed VERBATIM — 4 214 bytes each, plain
//     SVG (no script, no event handler, no embedded image) — with a NOTICE.md beside them that names
//     OpenAI, the source, the date and that they are NOT under this repository's MIT licence, and a
//     repo-root NOTICE listing that one third-party asset;
//   - `ChatgptButton` renders the text "Continue with ChatGPT" beside a decorative logo
//     (`alt=""`, `aria-hidden`) — the black logo on the light theme, the white one on the dark.
// The `@siwc/` lockfile tripwire is NOT repeated here — it lives in packages/auth (L0).
//
// RED until the copy, the asset, the NOTICEs and `desktop/ChatgptButton.tsx` exist.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.resolve(__dirname, '..');
const REPO = path.resolve(SRC, '..', '..', '..');
const ASSET_DIR = path.join(SRC, 'desktop', 'assets', 'openai-button');
const BUTTON_MODULE = '../desktop/ChatgptButton.js';

const D9_DATA_USE =
  "In this mode your requests go to OpenAI under your ChatGPT account. OpenAI's documents don't say which data policy covers them, so assume your ChatGPT data controls ('Improve the model for everyone') apply. Snug and the app can't see your ChatGPT conversations or memories.";

/** Every non-test source file under src (tests excluded — they quote the forbidden words on purpose). */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * The text a source file would SAY: string escapes and JSX entities undone, whitespace collapsed
 * (JSX text wraps across lines) — so a pin cannot be dodged by `\'` vs `'` or a line break.
 */
function said(source: string): string {
  return source
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

const SOURCES = walk(SRC).map((file) => ({ file: path.relative(SRC, file), text: said(readFileSync(file, 'utf8')) }));

describe('copy pins (D9)', () => {
  it('NO playground source claims "not used for training" or "zero retention" (any case, any hyphenation)', () => {
    const offenders = SOURCES.filter(({ text }) => /not used for training|zero[ -]?retention/i.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the D9 data-use sentence appears VERBATIM in legal/privacy.ts AND in at least one non-legal source', () => {
    const homes = SOURCES.filter(({ text }) => text.includes(D9_DATA_USE)).map(({ file }) => file);
    expect(homes).toContain(path.join('legal', 'privacy.ts'));
    expect(homes.filter((file) => !file.startsWith(`legal${path.sep}`)).length, `found in: ${homes.join(', ')}`).toBeGreaterThanOrEqual(1);
    expect(homes.length).toBeGreaterThanOrEqual(2);
  });

  it.each(['use your ChatGPT plan', 'my ChatGPT plan', 'ChatGPT plan', 'Using ChatGPT plan', 'Manage usage', 'Sign out of ChatGPT', 'Continue with ChatGPT'])(
    'the approved label "%s" is in the source',
    (label) => {
      expect(SOURCES.some(({ text }) => text.includes(label))).toBe(true);
    },
  );
});

describe('the OpenAI button asset (L5-6)', () => {
  it.each(['chatgpt-logo-black.svg', 'chatgpt-logo-white.svg'])('%s is committed verbatim: 4 214 bytes of plain SVG — no script, handler or embedded image', (name) => {
    const file = path.join(ASSET_DIR, name);
    expect(existsSync(file), file).toBe(true);
    expect(statSync(file).size).toBe(4214);
    const svg = readFileSync(file, 'utf8');
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(svg).not.toMatch(/<image/i);
    expect(svg).not.toMatch(/<foreignObject/i);
  });

  it('a NOTICE.md beside the logos names OpenAI, the source, the date, and says they are NOT under this repository’s MIT licence', () => {
    const notice = path.join(ASSET_DIR, 'NOTICE.md');
    expect(existsSync(notice), notice).toBe(true);
    const text = readFileSync(notice, 'utf8');
    expect(text).toMatch(/OpenAI/);
    expect(text).toContain('developers.openai.com/assets/siwc/sign-in-buttons/');
    expect(text).toContain('2026-10-23');
    expect(text).toMatch(/not under this repository['’]s MIT licence/i);
  });

  it('the repo-root NOTICE lists the third-party asset', () => {
    const notice = path.join(REPO, 'NOTICE');
    expect(existsSync(notice), notice).toBe(true);
    const text = readFileSync(notice, 'utf8');
    expect(text).toContain('apps/playground/src/desktop/assets/openai-button');
    expect(text).toMatch(/OpenAI/);
  });
});

describe('ChatgptButton (L5-6)', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
  });

  async function renderButton(theme: 'light' | 'dark'): Promise<HTMLButtonElement> {
    const { themeStore } = await import('../state/theme.js');
    themeStore.set(theme);
    // A non-literal specifier keeps Vite's import analysis from failing the WHOLE file while the
    // component does not exist yet — so the copy and asset pins above report one by one.
    const { ChatgptButton } = (await import(/* @vite-ignore */ BUTTON_MODULE)) as typeof import('../desktop/ChatgptButton.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(ChatgptButton, { onClick: () => undefined }));
    });
    const button = container.querySelector('button');
    if (button === null) throw new Error('ChatgptButton rendered no button');
    return button;
  }

  it('renders "Continue with ChatGPT" with a decorative logo (alt="", aria-hidden) — the text is the accessible name', async () => {
    const button = await renderButton('light');
    expect(button.textContent?.trim()).toBe('Continue with ChatGPT');
    const img = button.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('alt')).toBe('');
    expect(img!.getAttribute('aria-hidden')).toBe('true');
  });

  it('the black logo on the light theme, the white one on the dark', async () => {
    expect((await renderButton('light')).querySelector('img')?.getAttribute('src')).toMatch(/chatgpt-logo-black/);
    act(() => root?.unmount());
    container?.remove();
    expect((await renderButton('dark')).querySelector('img')?.getAttribute('src')).toMatch(/chatgpt-logo-white/);
  });
});
