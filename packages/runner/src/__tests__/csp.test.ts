// AC-1/AC-2 (C2): CSP injection via DOM parsing must defeat hostile parse-order input,
// the policy must contain no meta-ignored directives, and its allowlist must be exactly
// the protocol CDN_ALLOWLIST. jsdom scope: string/tree assertions only — real-browser
// enforcement is covered by browser-csp.spec.template.ts in the Playwright harness.
import { CDN_ALLOWLIST } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';
import { RUNNER_CSP, injectCsp } from '../csp.js';

const CSP_META_SELECTOR = 'meta[http-equiv="Content-Security-Policy" i]';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...values] = tokens;
    if (name) out.set(name, values);
  }
  return out;
}

describe('RUNNER_CSP policy content', () => {
  const parsed = directives(RUNNER_CSP);

  it('denies everything by default and closes the worker fallback hole (F3)', () => {
    expect(parsed.get('default-src')).toEqual(["'none'"]);
    expect(parsed.get('connect-src')).toEqual(["'none'"]);
    expect(parsed.get('worker-src')).toEqual(["'none'"]);
    expect(parsed.get('child-src')).toEqual(["'none'"]);
    expect(parsed.get('frame-src')).toEqual(["'none'"]);
    expect(parsed.get('object-src')).toEqual(["'none'"]);
    expect(parsed.get('base-uri')).toEqual(["'none'"]);
    expect(parsed.get('form-action')).toEqual(["'none'"]);
  });

  it('allows inline + eval scripts and styles from the fixed CDNs only', () => {
    expect(parsed.get('script-src')).toEqual(["'unsafe-inline'", "'unsafe-eval'", ...CDN_ALLOWLIST]);
    expect(parsed.get('style-src')).toEqual(["'unsafe-inline'", ...CDN_ALLOWLIST]);
    expect(parsed.get('font-src')).toEqual([...CDN_ALLOWLIST, 'data:']);
  });

  it('img-src permits only data: and blob: — no network scheme', () => {
    expect(parsed.get('img-src')).toEqual(['data:', 'blob:']);
    expect(parsed.get('img-src')!.some((v) => v.includes('https:') || v.includes('http:'))).toBe(false);
  });

  it('contains no directives that <meta> delivery ignores', () => {
    expect(RUNNER_CSP).not.toMatch(/frame-ancestors|report-uri|report-to|sandbox/);
  });

  it('every source-list URL is a member of the protocol CDN_ALLOWLIST (C2: never widened)', () => {
    const urls = RUNNER_CSP.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(CDN_ALLOWLIST).toContain(url);
    }
  });
});

describe('injectCsp — output invariants', () => {
  const APP = '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div></body></html>';

  it('prepends exactly one CSP meta as the first element of head', () => {
    const doc = parse(injectCsp(APP));
    const metas = doc.querySelectorAll(CSP_META_SELECTOR);
    expect(metas).toHaveLength(1);
    expect(doc.head.firstElementChild).toBe(metas[0]);
    expect(metas[0]!.getAttribute('content')).toBe(RUNNER_CSP);
  });

  it('emits a doctype so the app never renders in quirks mode', () => {
    expect(injectCsp(APP).toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });

  it('renders the policy attribute intact after serialization (rendered-attribute check)', () => {
    const rendered = injectCsp(APP);
    const doc = parse(rendered);
    const meta = doc.querySelector(CSP_META_SELECTOR)!;
    expect(meta.getAttribute('content')).toBe(RUNNER_CSP);
    expect(meta.getAttribute('content')).toContain("connect-src 'none'");
  });

  it('preserves the app content (title, root node, scripts)', () => {
    const doc = parse(injectCsp(APP));
    expect(doc.title).toBe('App');
    expect(doc.querySelector('#root')).not.toBeNull();
  });
});

describe('injectCsp — hostile parse-order matrix (F1)', () => {
  /** Every hostile input must yield: exactly one CSP meta, first in head, and every
   *  script element strictly AFTER the meta in document order. */
  function assertHardened(html: string): Document {
    const doc = parse(injectCsp(html));
    const metas = doc.querySelectorAll(CSP_META_SELECTOR);
    expect(metas, html).toHaveLength(1);
    const meta = metas[0]!;
    expect(doc.head.firstElementChild, html).toBe(meta);
    for (const script of doc.querySelectorAll('script')) {
      // DOCUMENT_POSITION_FOLLOWING: script comes after the meta in tree order.
      expect(meta.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING, html).toBeTruthy();
    }
    return doc;
  }

  it('script before <head> lands AFTER the meta in the output tree', () => {
    const doc = assertHardened('<script>fetch("https://evil.example")</script><head><title>x</title></head>');
    expect(doc.querySelector('script')).not.toBeNull();
  });

  it('uppercase <HEAD> is still hardened', () => {
    assertHardened('<HEAD><script>evil()</script></HEAD><body>x</body>');
  });

  it('attributes on head do not break prepending', () => {
    assertHardened('<head data-x="1" class="h"><script>evil()</script></head>');
  });

  it('document with no head still gains a head with the meta first', () => {
    assertHardened('<body><script>evil()</script><p>hi</p></body>');
  });

  it('document with no html element at all is normalized and hardened', () => {
    const doc = assertHardened('hello <b>world</b>');
    expect(doc.body.textContent).toContain('hello');
  });

  it('a comment decoy <!-- <head> --> cannot attract the meta', () => {
    const doc = assertHardened('<!-- <head> --><head><script>evil()</script></head>');
    // The meta must be an element child of the real head, not text near the comment.
    expect(doc.querySelector(CSP_META_SELECTOR)!.parentElement).toBe(doc.head);
  });

  it('body-first document keeps every script after the meta', () => {
    assertHardened('<body><script>evil()</script></body><head></head>');
  });

  it('string-surgery decoys in text content never receive the policy', () => {
    const doc = parse(injectCsp('<head></head><body><p>&lt;head&gt;</p><textarea>&lt;/head&gt;</textarea></body>'));
    expect(doc.querySelectorAll(CSP_META_SELECTOR)).toHaveLength(1);
    expect(doc.querySelector('textarea')!.textContent).not.toContain('Content-Security-Policy');
  });
});
