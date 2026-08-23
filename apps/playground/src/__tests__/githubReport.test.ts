// githubReport — TASK-20260822-feedback-loop AC1 (URL assembly) + AC3 (scrub).
//
// The feedback channel is GitHub deep-links (ADR-0052): no hosted receiver exists,
// so the ONLY egress is the prefilled URL itself — which reaches github.com the
// moment it is opened. That is why the scrub runs at ASSEMBLY time (inside the
// builders), not merely at display time: a URL is transmitted by navigation, and
// what the preview shows must be what the wire carries.

import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_URL_CHARS,
  buildBugReport,
  buildFeatureRequest,
  buildFeedbackDiscussion,
  scrubCredentialShaped,
} from '../feedback/githubReport.js';
import { REPO_URL } from '../config/site.js';

const baseCtx = {
  surface: 'build' as const,
  errorText: 'the model reply could not be parsed',
  environment: 'web / Firefox 142 / byok',
};

function param(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

describe('buildBugReport (AC1)', () => {
  it('targets the bug issue form with prefilled field-id params', () => {
    const report = buildBugReport(baseCtx);
    expect(report.url.startsWith(`${REPO_URL}/issues/new?`)).toBe(true);
    expect(param(report.url, 'template')).toBe('bug_report.yml');
    // YAML issue forms prefill by FIELD ID — these three ids exist in
    // .github/ISSUE_TEMPLATE/bug_report.yml and renaming a field there
    // must red this test rather than silently emptying the prefill.
    expect(param(report.url, 'what-happened')).toContain('the model reply could not be parsed');
    expect(param(report.url, 'environment')).toBe('web / Firefox 142 / byok');
    expect(param(report.url, 'area')).toBe('apps/playground (hub UI)');
    expect(param(report.url, 'title')).toContain('the model reply could not be parsed');
  });

  it('names the reporting surface in the body and the title tag', () => {
    const report = buildBugReport({ ...baseCtx, surface: 'connection-wizard' });
    expect(param(report.url, 'title')).toMatch(/^\[connection wizard\]/);
    expect(param(report.url, 'what-happened')).toContain('connection wizard');
  });

  it('routes starter-app reports to the examples area and names the starter', () => {
    const report = buildBugReport({
      ...baseCtx,
      surface: 'run',
      appName: 'Moodboard',
      starterId: 'hue',
      starterVersion: '3',
    });
    expect(param(report.url, 'area')).toBe('examples (starter apps)');
    const body = param(report.url, 'what-happened');
    expect(body).toContain('Moodboard');
    expect(body).toContain('hue');
    expect(body).toContain('3');
  });

  it('exposes the same prefill as preview fields — the preview IS the payload', () => {
    const report = buildBugReport(baseCtx);
    const byLabel = Object.fromEntries(report.fields.map((f) => [f.label, f.value]));
    const url = new URL(report.url);
    expect(byLabel['what happened']).toBe(url.searchParams.get('what-happened'));
    expect(byLabel['environment']).toBe(url.searchParams.get('environment'));
    expect(byLabel['area']).toBe(url.searchParams.get('area'));
  });

  it('caps the URL and marks the truncation visibly', () => {
    const report = buildBugReport({ ...baseCtx, errorText: 'x'.repeat(40_000) });
    expect(report.url.length).toBeLessThanOrEqual(MAX_REPORT_URL_CHARS);
    expect(param(report.url, 'what-happened')).toContain('[truncated]');
    // The cap trims the error text, never the environment or area fields.
    expect(param(report.url, 'environment')).toBe(baseCtx.environment);
    expect(param(report.url, 'area')).toBe('apps/playground (hub UI)');
  });

  it('keeps a short report untruncated', () => {
    const report = buildBugReport(baseCtx);
    expect(param(report.url, 'what-happened')).not.toContain('[truncated]');
  });
});

describe('buildFeatureRequest / buildFeedbackDiscussion (AC1)', () => {
  it('feature requests open the feature issue form', () => {
    const report = buildFeatureRequest();
    expect(param(report.url, 'template')).toBe('feature_request.yml');
    expect(report.url.startsWith(`${REPO_URL}/issues/new?`)).toBe(true);
  });

  it('open feedback lands in the General discussions category', () => {
    const report = buildFeedbackDiscussion();
    expect(report.url).toBe(`${REPO_URL}/discussions/new?category=general`);
  });
});

describe('scrubCredentialShaped (AC3) — the shared credentialShapes list', () => {
  it('redacts scheme-carrying header values', () => {
    const out = scrubCredentialShaped('got 401 with Authorization: Bearer abcDEF123456SECRET');
    expect(out).not.toContain('abcDEF123456SECRET');
    expect(out).toContain('Bearer «redacted»');
  });

  it('leaves scheme-adjacent PROSE alone — a digit-less word is not a token (Gate-5 finding)', () => {
    expect(scrubCredentialShaped('Basic authentication failed for this provider')).toBe(
      'Basic authentication failed for this provider',
    );
    expect(scrubCredentialShaped('token mismatch: session token expired')).toBe(
      'token mismatch: session token expired',
    );
  });

  it('redacts AWS temporary-session keys too (ASIA — the drift the shared list closes)', () => {
    const out = scrubCredentialShaped('denied for ASIA1234567890AB');
    expect(out).not.toContain('ASIA1234567890AB');
  });

  it('redacts well-known key shapes', () => {
    const gh = `ghp_${'a1B2'.repeat(9)}`;
    const anthropic = 'sk-ant-api03-abcdefghijklmnop-qrstuvwx';
    const out = scrubCredentialShaped(`tried ${gh} then ${anthropic}`);
    expect(out).not.toContain(gh);
    expect(out).not.toContain(anthropic);
  });

  it('redacts credential-shaped query params but keeps the rest of the URL', () => {
    const out = scrubCredentialShaped('GET https://api.example.com/v1/data?units=metric&appid=deadbeefcafe1234&page=2 failed');
    expect(out).not.toContain('deadbeefcafe1234');
    expect(out).toContain('units=metric');
    expect(out).toContain('page=2');
  });

  it('redacts long unbroken token-like runs', () => {
    const blob = 'A'.repeat(20) + 'b1'.repeat(15); // 50 chars, mixed
    const out = scrubCredentialShaped(`response echoed ${blob} back`);
    expect(out).not.toContain(blob);
  });

  it('caps the URL even when the OTHER context fields are hostile-length (Gate-5 finding)', () => {
    const report = buildBugReport({
      ...baseCtx,
      surface: 'run',
      appName: 'A'.repeat(50_000),
      environment: 'E'.repeat(50_000),
      errorText: 'x'.repeat(50_000),
    });
    expect(report.url.length).toBeLessThanOrEqual(MAX_REPORT_URL_CHARS);
  });

  it('never strands a lone surrogate at a truncation cut', () => {
    const report = buildBugReport({ ...baseCtx, errorText: '💥'.repeat(30_000) });
    expect(report.url.length).toBeLessThanOrEqual(MAX_REPORT_URL_CHARS);
    expect(report.url).not.toContain('%EF%BF%BD'); // U+FFFD — a split pair re-encoded
  });

  it('leaves ordinary error prose and URLs alone', () => {
    const text = 'failed to fetch https://api.github.com/user: 401 unauthorized — try reconnecting';
    expect(scrubCredentialShaped(text)).toBe(text);
  });

  it('is applied INSIDE the builder — the assembled URL never carries the secret', () => {
    const secret = `ghp_${'x9Yz'.repeat(9)}`;
    const report = buildBugReport({ ...baseCtx, errorText: `refused: ${secret}` });
    expect(report.url).not.toContain(secret);
    expect(report.url).not.toContain(encodeURIComponent(secret));
    for (const field of report.fields) expect(field.value).not.toContain(secret);
  });
});
