// legalPages.test.tsx — TASK-20260823-legal-terms-privacy-eula AC1 + AC4 (ADR-0055 §1).
//
// The load-bearing assertion is the NEGATIVE one: the web playground's first run has
// NO gate — no dialog, no aria-modal, no consent checkbox — because the terms do
// disclosure work, not contract formation (Berman v. Freedom Financial: a browsewrap
// binds nobody, so a gate would cost the first run and buy nothing). The positive half:
// /terms and /privacy render from the shared content modules, and the footer links to
// them everywhere EXCEPT inside a running app (the product surface; mobile.spec.ts pins
// the either/or band there) and the OAuth popup.
//
// Rendered through the REAL <App /> (appShellNetConfirm.test.tsx's harness), so a
// route nobody wired or a footer nobody mounted is a failure here, not a surprise.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { PRIVACY_PATH, TERMS_PATH, THREAT_MODEL_URL } from '../legal/legalShared.js';
import { PRIVACY, THIRD_PARTIES } from '../legal/privacy.js';
import { TERMS } from '../legal/terms.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  localStorage.clear();
  await installTestUserDb();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

async function renderAt(path: string): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return container;
}

const q = (sel: string): HTMLElement | null => container?.querySelector<HTMLElement>(sel) ?? null;
const qa = (sel: string): HTMLElement[] => [...(container?.querySelectorAll<HTMLElement>(sel) ?? [])];

describe('no gate on first run (AC1 — the load-bearing negative)', () => {
  it('the hub renders with no dialog, no aria-modal, and no consent checkbox', async () => {
    await renderAt('/');
    // The hub is actually there (a blank shell would pass a naive negative).
    expect(q('.shell-header')).not.toBeNull();
    expect(q('main.shell-main')).not.toBeNull();
    expect(qa('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')).toEqual([]);
    const consentBoxes = qa('input[type="checkbox"]').filter((el) =>
      /agree|accept|terms|consent/i.test(el.closest('label')?.textContent ?? el.getAttribute('aria-label') ?? ''),
    );
    expect(consentBoxes).toEqual([]);
    expect(container?.textContent ?? '').not.toMatch(/I agree|accept the terms/i);
  });
});

describe('/terms and /privacy render from the shared content (AC1)', () => {
  it('/terms', async () => {
    await renderAt(TERMS_PATH);
    const page = q('[data-testid="legal-page-terms"]');
    expect(page).not.toBeNull();
    expect(page?.querySelector('h1')?.textContent).toBe(TERMS.title);
    for (const section of TERMS.sections) {
      expect(page?.querySelector(`#${section.id}`)?.textContent, section.id).toBe(section.heading);
    }
    expect(page?.textContent).toContain(`updated ${TERMS.updated}`);
    // The MIT disclaimer is a quotation, rendered as one.
    expect(page?.querySelector('blockquote')?.textContent).toMatch(/PROVIDED "AS IS"/);
  });

  it('/privacy — including the third-party table, one row per party', async () => {
    await renderAt(PRIVACY_PATH);
    const page = q('[data-testid="legal-page-privacy"]');
    expect(page).not.toBeNull();
    expect(page?.querySelector('h1')?.textContent).toBe(PRIVACY.title);
    const rows = page?.querySelectorAll('table tbody tr') ?? [];
    expect(rows.length).toBe(THIRD_PARTIES.length);
    expect(page?.textContent).toContain('github.com');
  });

  it('external links open in a new tab; internal ones stay in the router', async () => {
    await renderAt(TERMS_PATH);
    const page = q('[data-testid="legal-page-terms"]')!;
    const threat = [...page.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.href === THREAT_MODEL_URL);
    expect(threat, 'the threat-model link is rendered').toBeDefined();
    expect(threat?.target).toBe('_blank');
    expect(threat?.rel).toContain('noreferrer');
    const privacy = [...page.querySelectorAll<HTMLAnchorElement>('a')].find((a) =>
      a.getAttribute('href')?.endsWith(PRIVACY_PATH),
    );
    expect(privacy, 'the in-app privacy link is rendered').toBeDefined();
    expect(privacy?.target).not.toBe('_blank');
  });
});

describe('the footer (AC4)', () => {
  it.each(['/', '/build', '/settings', '/download', TERMS_PATH, PRIVACY_PATH])(
    'renders on %s with terms · privacy · threat model · MIT',
    async (path) => {
      await renderAt(path);
      const footer = q('footer.shell-footer');
      expect(footer).not.toBeNull();
      expect(footer?.querySelector('[data-testid="footer-terms"]')?.getAttribute('href')).toContain(TERMS_PATH);
      expect(footer?.querySelector('[data-testid="footer-privacy"]')?.getAttribute('href')).toContain(PRIVACY_PATH);
      expect(footer?.querySelector<HTMLAnchorElement>('[data-testid="footer-threat-model"]')?.href).toBe(THREAT_MODEL_URL);
      expect(footer?.textContent).toMatch(/MIT/);
    },
  );

  it.each(['/run/some-app', '/oauth/callback'])('does NOT render on %s', async (path) => {
    await renderAt(path);
    expect(q('footer.shell-footer')).toBeNull();
  });
});
