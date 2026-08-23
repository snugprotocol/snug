// Feedback mount scan — TASK-20260822-feedback-loop AC2/AC4: every surface the
// plan names carries its affordance. An executable SOURCE scan (the
// authKindChoice precedent) rather than a render of each host: RunView, the
// wizard sheet and App each need a page of store scaffolding to mount, and what
// this test protects is precisely the mount being deleted in a refactor — the
// component's own behavior is pinned in feedbackSurfaces/feedbackMenu tests.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with cwd = apps/playground (the hueStarterManifest precedent);
// import.meta.url resolves to vite's serving path here, not the filesystem.
function src(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relative), 'utf8');
}

describe('feedback mounts', () => {
  it('the header carries the one persistent feedback entry', () => {
    const app = src('App.tsx');
    expect(app).toContain('<FeedbackMenu');
  });

  it('the boot load-failed screen offers report-this', () => {
    const app = src('App.tsx');
    expect(app).toMatch(/ReportErrorLink[\s\S]{0,200}surface: 'boot'/);
  });

  it('RunView offers report-this on the install and export failures', () => {
    const runView = src('run/RunView.tsx');
    const mounts = runView.match(/<ReportErrorLink/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    expect(runView).toMatch(/surface: 'run'/);
  });

  it('the connection wizard offers report-this on the connect error', () => {
    const sheet = src('connections/ConnectionWizardSheet.tsx');
    expect(sheet).toMatch(/ReportErrorLink[\s\S]{0,300}surface: 'connection-wizard'/);
  });

  it('settings carries the feedback card', () => {
    const settings = src('views/SettingsView.tsx');
    expect(settings).toContain('<FeedbackCard');
  });

  it('the build-failure chat surface mounts the link (rendered twin in feedbackSurfaces)', () => {
    const chatLog = src('views/ChatLog.tsx');
    expect(chatLog).toMatch(/ReportErrorLink[\s\S]{0,200}surface: 'build'/);
  });
});
