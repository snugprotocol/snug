// scheduleOffer.test.tsx — TASK-20261009-scheduling-framework E10 (ADR-0074 §4; design F10):
// the deterministic chat offer. A user message that reads like a schedule gets ONE inline,
// dismissible line under its bubble in `ChatLog` — the place both the builder chat and the
// run rail's chat pass through — whose one act opens the editor route prefilled with the
// message. It never calls a brain (no transport is imported, no fetch is made), it parses each
// message once (memoised per message across re-renders), it renders for USER messages only,
// and it is gated on `allows('schedule')` like every scheduling surface.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../agent/useBuilderChat.js';
import { chatOffer } from '../schedule/copy.js';
import { OFFER } from '../schedule/copy.page.js';
import { scheduleOffer } from '../schedule/parseScheduleText.js';
import { newScheduleHref } from '../schedule/routes.js';
import { ScheduleOffer } from '../schedule/ScheduleOffer.js';
import { ChatLog } from '../views/ChatLog.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const gate = vi.hoisted(() => ({ schedule: true }));

vi.mock('../platform/platform.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../platform/platform.js')>();
  return {
    ...original,
    allows: (surface: Parameters<typeof original.allows>[0]) => (surface === 'schedule' ? gate.schedule : original.allows(surface)),
  };
});

// The grammar is the production one; the wrapper only counts the calls.
vi.mock('../schedule/parseScheduleText.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../schedule/parseScheduleText.js')>();
  return { ...original, scheduleOffer: vi.fn(original.scheduleOffer) };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: React.ReactElement): HTMLDivElement {
  container ??= (() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  })();
  root ??= createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container;
}

const SCHEDULE_TEXT = 'remind me every weekday at 8 to stretch';
const user = (id: number, text: string): ChatMessage => ({ id, role: 'user', displayText: text });
const agent = (id: number, text: string): ChatMessage => ({ id, role: 'agent', displayText: text });

const offers = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-testid="schedule-offer"]')];

beforeEach(() => {
  gate.schedule = true;
  vi.mocked(scheduleOffer).mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.restoreAllMocks();
});

describe('the offer under a user message', () => {
  it('renders once, quotes the schedule in the message’s own words, and links to the prefilled editor route', () => {
    const el = render(<ChatLog messages={[user(1, SCHEDULE_TEXT), agent(2, 'Sure — stretching reminders it is.')]} />);
    const found = offers(el);
    expect(found).toHaveLength(1);
    const expected = chatOffer('every weekday at 8');
    expect(found[0]?.textContent).toContain(expected.text);
    const review = found[0]?.querySelector('a');
    expect(review?.textContent).toBe(expected.action);
    expect(review?.getAttribute('href')).toBe(newScheduleHref({ text: SCHEDULE_TEXT }));
    expect(newScheduleHref({ text: SCHEDULE_TEXT })).toBe('/schedule/new?text=remind+me+every+weekday+at+8+to+stretch');
    // It sits as a sibling AFTER the bubble, never inside it.
    expect(found[0]?.closest('.msg')).toBeNull();
    expect(found[0]?.previousElementSibling?.classList.contains('msg-user')).toBe(true);
  });

  it('a message with no time expression and no word of intent gets no offer', () => {
    const el = render(<ChatLog messages={[user(1, 'what did I spend on food?')]} />);
    expect(offers(el)).toHaveLength(0);
  });

  it('an AGENT message that reads like a schedule gets no offer — the offer is for the user’s own words', () => {
    const el = render(<ChatLog messages={[agent(1, SCHEDULE_TEXT)]} />);
    expect(offers(el)).toHaveLength(0);
    expect(scheduleOffer).not.toHaveBeenCalled();
  });

  it('dismiss hides that message’s offer and no other', () => {
    const el = render(<ChatLog messages={[user(1, SCHEDULE_TEXT), user(2, 'every day at 7 water the ferns')]} />);
    expect(offers(el)).toHaveLength(2);
    const dismiss = offers(el)[0]?.querySelector('button');
    expect(dismiss?.getAttribute('aria-label')).toBe(OFFER.dismissName);
    act(() => dismiss?.click());
    const left = offers(el);
    expect(left).toHaveLength(1);
    expect(left[0]?.querySelector('a')?.getAttribute('href')).toBe(newScheduleHref({ text: 'every day at 7 water the ferns' }));
  });

  it('parses each message ONCE across re-renders, and never calls a brain or the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    render(<ChatLog messages={[user(1, SCHEDULE_TEXT)]} />);
    expect(scheduleOffer).toHaveBeenCalledTimes(1);
    render(<ChatLog messages={[user(1, SCHEDULE_TEXT), agent(2, 'thinking…')]} busy />);
    render(<ChatLog messages={[user(1, SCHEDULE_TEXT), agent(2, 'Done.')]} />);
    expect(scheduleOffer).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is gated on allows("schedule") like every scheduling surface (C7)', () => {
    gate.schedule = false;
    const el = render(<ChatLog messages={[user(1, SCHEDULE_TEXT)]} />);
    expect(offers(el)).toHaveLength(0);
    expect(scheduleOffer).not.toHaveBeenCalled();
  });
});

describe('ScheduleOffer on its own', () => {
  it('renders nothing for text that is not a schedule', () => {
    const el = render(<ScheduleOffer text="hello there" />);
    expect(el.querySelector('[data-testid="schedule-offer"]')).toBeNull();
  });

  it('a relative phrase is quoted as written', () => {
    const el = render(<ScheduleOffer text="in 20 minutes remind me to call mum" />);
    expect(el.querySelector('[data-testid="schedule-offer"]')?.textContent).toContain(chatOffer('in 20 minutes').text);
  });
});
