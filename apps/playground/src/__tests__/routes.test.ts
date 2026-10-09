// routes.test.ts — TASK-20261009-scheduling-framework U1–U5 (Gate-5 PR-B S4): the scheduling
// routes, and the ONE reader of `?back=`. A `back` is an in-app path the editor follows after
// the save or cancel, so it must never be able to leave the origin: a URL, a protocol-relative
// `//host`, a backslash form (`/\host` — browsers read `\` as `/` in http URLs, so it is
// `//host` in disguise), its percent-encoded twin (`/%5Chost`, which a decode on the way turns
// into the same), a newline, or anything `new URL(value, origin)` resolves off-origin.
import { describe, expect, it } from 'vitest';

import { editHref, isBackPath, newScheduleHref, resultHref } from '../schedule/routes.js';

describe('isBackPath — an in-app path and nothing else', () => {
  it('accepts an in-app path, with a query string', () => {
    expect(isBackPath('/run/app-1')).toBe(true);
    expect(isBackPath('/build/app-1')).toBe(true);
    expect(isBackPath('/schedule?x=1')).toBe(true);
    expect(isBackPath('/')).toBe(true);
  });

  it('refuses a URL, a protocol-relative path and the backslash forms', () => {
    expect(isBackPath('https://evil.com/x')).toBe(false);
    expect(isBackPath('//evil.com')).toBe(false);
    expect(isBackPath('/\\evil.com')).toBe(false);
    expect(isBackPath('/%5Cevil.com')).toBe(false);
    expect(isBackPath('/%5cevil.com')).toBe(false);
    expect(isBackPath('/%2F%2Fevil.com')).toBe(false);
    expect(isBackPath('/run/a\\b')).toBe(false);
  });

  it('refuses whitespace, control characters, an empty or a non-string value', () => {
    expect(isBackPath('/run/a\nb')).toBe(false);
    expect(isBackPath('/run/a b')).toBe(false);
    expect(isBackPath('')).toBe(false);
    expect(isBackPath('run/app-1')).toBe(false);
    expect(isBackPath(null)).toBe(false);
    expect(isBackPath(undefined)).toBe(false);
  });

  it('with an origin in hand, the value must resolve on that origin', () => {
    expect(isBackPath('/run/app-1', 'http://localhost:5173')).toBe(true);
    expect(isBackPath('/\\evil.com', 'http://localhost:5173')).toBe(false);
    expect(isBackPath('//evil.com', 'http://localhost:5173')).toBe(false);
    // The page's own `location` is the default origin in a browser (jsdom here).
    expect(isBackPath('/schedule?x=1')).toBe(true);
  });
});

describe('the hrefs, spelled once', () => {
  it('edit and result routes encode their ids', () => {
    expect(editHref('t 1')).toBe('/schedule/t%201');
    expect(resultHref('t1', '2026-10-09T08:00:00.000Z')).toBe('/schedule/t1/result/2026-10-09T08%3A00%3A00.000Z');
  });

  it('newScheduleHref carries only the params given, and drops a `back` that is not an in-app path', () => {
    expect(newScheduleHref()).toBe('/schedule/new');
    expect(newScheduleHref({ text: 'every day at 8', back: '/run/app-1' })).toBe('/schedule/new?text=every+day+at+8&back=%2Frun%2Fapp-1');
    expect(newScheduleHref({ back: '//evil.com' })).toBe('/schedule/new');
    expect(newScheduleHref({ back: '/\\evil.com' })).toBe('/schedule/new');
    expect(newScheduleHref({ back: '/%5Cevil.com' })).toBe('/schedule/new');
  });
});
