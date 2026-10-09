// BrainChip — the always-on "what's thinking" status surface (TASK-20260826,
// ADR-0059 rules 1/2/4).
//
// A status chip, never a nag: it renders on every route, in every brain state, and
// stays useful after the user switches — its job is to keep being true. The label
// derives from the ONE live routing derivation (state/activeBrain.ts), so the
// keyed-provider-with-no-key fall-through reads "demo brain" here the moment it
// would route there. Clicking opens a small popover (the IdentityChip open/close/
// focus contract) with one honest sentence for the current brain and the switch
// affordances — "use ollama now" appears ONLY when the probe found models (the
// DesktopWelcome rule: never offer a button that cannot work).
//
// COPY IS A CONTRACT (ADR-0059 rule 4, byte-pinned in brainChip.test.tsx): the
// demo body names the mechanism; the BYOK invitation claims exactly what the code
// vouches for — the key lives in the user's file on this device and is sent only
// to the chosen provider, never to Snug's servers. It deliberately does NOT say
// "never leaves your device": the key travels to the provider, and a critical
// reader who catches an overclaim stops believing the honest claims too.
//
// TWO CHIPS, ONE SLOT (TASK-20261003 R4, ADR-0071 §4). Where the platform carries a brain
// switcher — the local runner, where the brain is one of the user's OWN agents — the chip is
// the switcher: every agent the runner knows with its state and its remedy, `auto` first,
// and the answering agent's model and thinking level. Everywhere else it is the status chip
// it has always been, unchanged. The platform is set once before boot, so which of the two
// this is never changes under a mounted tree.

import type { ReactElement } from 'react';
import { useId, useRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';

import {
  BRAIN_AUTO,
  BRAIN_MARK_WORD,
  BRAIN_UNVERIFIED_BODY,
  BRAIN_UNVERIFIED_LABEL,
  autoChoiceLine,
  brainLevels,
  brainMark,
  brainReadyState,
  brainRemedy,
  demoStandIn,
  proseParts,
  standInBody,
  tierAutoLabel,
  tierLabel,
  tierSubstitutionNote,
} from '../platform/copy.js';
import { allows, getPlatform, type BrainOptionView, type BrainSwitchSeat, type TierChoice } from '../platform/platform.js';
import { setMode } from '../state/mode.js';
import { useActiveBrain, type ActiveBrainKind } from '../state/activeBrain.js';
import { useOllama } from '../state/ollama.js';
import { useBrain } from '../state/webllm.js';
import { useDismissableMenu } from '../ui/useDismissableMenu.js';

export const DEMO_BRAIN_BODY =
  'a tiny script inside this page fakes the AI so you can try the flow — no AI model or service is called.';

/**
 * The host kit with no host brain (TASK-20260905-host-kit AC5): the chip DISCLOSES the
 * fallback and instructs nothing — there is no brain to switch to here (D15).
 */
export const HOST_NO_BRAIN_HEADLINE = 'demo brain — no host brain wired yet';
export const HOST_NO_BRAIN_BODY =
  'no host brain reached this page, so a tiny script inside it fakes the AI — nothing to configure.';

export const BYOK_HONESTY_COPY =
  'your key is saved in your Snug file on this device and sent only to the AI provider you choose — never to Snug’s servers.';

/** Chip label + popover copy per brain. The chip text is an API (tests, AT, docs). */
const BRAINS: Record<ActiveBrainKind, { label: string; aria: string; headline: string; body: string }> = {
  demo: {
    label: 'demo brain',
    aria: 'what’s thinking: demo brain — scripted, no AI service',
    headline: 'demo brain — scripted',
    body: DEMO_BRAIN_BODY,
  },
  anthropic: {
    label: 'claude',
    aria: 'what’s thinking: claude, with your key',
    headline: 'claude · your key',
    body: 'turns go browser-direct to Anthropic with your key.',
  },
  openai: {
    label: 'openai',
    aria: 'what’s thinking: openai, with your key',
    headline: 'openai · your key',
    body: 'turns go browser-direct to OpenAI with your key.',
  },
  local: {
    label: 'local',
    aria: 'what’s thinking: a local model on this computer',
    headline: 'local model',
    body: 'turns run against your local endpoint on this computer.',
  },
  webllm: {
    label: 'in-browser',
    aria: 'what’s thinking: an in-browser model on WebGPU',
    headline: 'in-browser model',
    body: 'the model thinks inside this tab on WebGPU.',
  },
  subscription: {
    label: 'hub',
    aria: 'what’s thinking: the Snug hub',
    headline: 'snug hub',
    body: 'turns run through the Snug hub server you signed into.',
  },
  // The platform-pinned host brain (TASK-20260905-host-kit P2): the label is the host's
  // own (`PlatformBrain.label`), substituted at render — this row is the fallback shape.
  host: {
    label: 'host',
    aria: 'what’s thinking: the AI of the host you opened Snug in',
    headline: 'this host’s AI',
    body: 'the AI of the host you opened Snug in answers every turn — nothing to configure.',
  },
};

/** The chip copy for the active brain, with the host brain's own label substituted in. */
function copyFor(brain: ActiveBrainKind): { label: string; aria: string; headline: string; body: string } {
  const platform = getPlatform();
  const pinned = platform.brain;
  if (brain === 'host' && pinned?.kind === 'host') {
    return { ...BRAINS.host, label: pinned.label, headline: pinned.label, aria: `what’s thinking: ${pinned.label}` };
  }
  if (brain === 'demo' && platform.kind === 'host') {
    return { ...BRAINS.demo, headline: HOST_NO_BRAIN_HEADLINE, body: HOST_NO_BRAIN_BODY, aria: `what’s thinking: ${HOST_NO_BRAIN_HEADLINE}` };
  }
  return BRAINS[brain];
}

/** One stable no-op for the seatless render (a fresh closure per render would resubscribe on every render). */
const noSubscription = (): (() => void) => () => undefined;

export function BrainChip(): ReactElement {
  const seat = getPlatform().brainSwitch;
  return seat === undefined ? <StatusChip /> : <BrainSwitcher seat={seat} />;
}

/** The chip on every platform without a brain switcher: web, desktop, the artifact kit. */
function StatusChip(): ReactElement {
  const brain = useActiveBrain();
  const ollama = useOllama();
  // The webllm override outranks the configured mode (ADR-0015), so while it is
  // armed the menu's setMode('local') shortcut would visibly do nothing yet still
  // persist a mode write — withhold it (the DesktopWelcome never-offer-a-dead-button
  // rule; Gate-5 review). The settings door stays: config edits remain meaningful.
  const overrideArmed = useBrain().kind !== 'settings';
  const { open, toggle, close, triggerRef, menuRef } = useDismissableMenu();
  // The thinking level (ADR-0067 — D15 amended narrowly): a seat exists ONLY on a host brain
  // whose contract offers tiers (the artifact's `sample`); its state is subscribed like the
  // custody seat's, and the control renders nowhere else. Never a call: `set` changes what
  // the NEXT call carries.
  const pinned = getPlatform().brain;
  const tierSeat = brain === 'host' && pinned?.kind === 'host' ? pinned.tiers : undefined;
  const tierState = useSyncExternalStore(
    tierSeat?.state.subscribe ?? noSubscription,
    () => tierSeat?.state.get(),
    () => tierSeat?.state.get(),
  );

  const copy = copyFor(brain);
  const models = ollama !== 'unknown' && ollama.running ? ollama.models : [];
  const tierNote = tierSubstitutionNote(tierState?.applied);

  return (
    <div className="identity-menu-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="brain-chip"
        data-testid="brain-chip"
        data-brain={brain}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={copy.aria}
        title={copy.aria}
        {...(tierState !== undefined ? { 'data-tier': tierState.choice } : {})}
        onClick={toggle}
      >
        <span className="brain-dot" aria-hidden="true" />
        {brain === 'demo' ? (
          // The demo label must survive every compaction — but "demo brain" is 7px too
          // wide for the 375px header (the mobile overflow tripwire caught it), so the
          // narrow band swaps to the one word that still discloses. The full state
          // always rides the aria-label above.
          <>
            <span className="brain-chip-label brain-chip-label-full">{copy.label}</span>
            <span className="brain-chip-label brain-chip-label-short">demo</span>
          </>
        ) : (
          <span className="brain-chip-text">
            <span className="brain-chip-label">{copy.label}</span>
          </span>
        )}
      </button>
      {open ? (
        <div className="identity-menu brain-menu" data-testid="brain-menu" ref={menuRef} aria-label="what’s thinking">
          <span className="identity-menu-label">{copy.headline}</span>
          <span className="brain-menu-body">{copy.body}</span>
          {tierSeat !== undefined && tierState !== undefined ? (
            <label className="brain-menu-tier">
              <span className="brain-menu-tier-label">thinking level</span>
              <select
                aria-label="thinking level"
                data-testid="brain-menu-tier"
                value={tierState.choice}
                onChange={(event) => tierSeat.set(event.currentTarget.value as TierChoice)}
              >
                <option value="auto">{tierAutoLabel(tierSeat, tierState)}</option>
                {tierSeat.options.map((tier) => (
                  <option key={tier} value={tier} disabled={tierState.unavailable[tier] !== undefined}>
                    {tierLabel(tier, tierSeat, tierState)}
                  </option>
                ))}
              </select>
              {tierNote !== undefined ? (
                <span className="brain-menu-hint" data-testid="brain-menu-tier-note">
                  {tierNote}
                </span>
              ) : null}
            </label>
          ) : null}
          {/* The BRAIN switch affordances exist only where a brain can be chosen (D15): under
              the host kit the brain is the host's; the thinking level above is the one control
              the chip carries there (ADR-0067). */}
          {allows('brainSettings') ? (
            <Link
              to="/settings"
              className="identity-menu-item"
              data-testid="brain-menu-settings"
              onClick={() => close(false)}
            >
              {brain === 'demo' ? 'use your own AI key' : 'change in settings'}
            </Link>
          ) : null}
          {brain === 'demo' && allows('brainSettings') && !overrideArmed && models.length > 0 ? (
            <button
              type="button"
              className="identity-menu-item"
              data-testid="brain-menu-ollama"
              onClick={() => {
                setMode('local');
                close(false);
              }}
            >
              use ollama now — {models.length} {models.length === 1 ? 'model' : 'models'} found
            </button>
          ) : null}
          {brain === 'demo' && allows('brainSettings') ? <span className="brain-menu-hint">{BYOK_HONESTY_COPY}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ the brain switcher

/**
 * A thinking-level row shows every level at once while there are few enough to read as one
 * row at 375 px (Claude has five; with "default" that is six segments at about 50 px each).
 * Past that it is the plain dropdown.
 */
const MAX_SEGMENTED_LEVELS = 6;

/** A sentence from the runner, its commands set as code. */
function Prose({ text }: { text: string }): ReactElement {
  return (
    <>
      {proseParts(text).map((part, index) => (part.code ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>))}
    </>
  );
}

function BrainRow({ brain, chosen, answering, checking, onChoose }: { brain: BrainOptionView; chosen: boolean; answering: boolean; checking: boolean; onChoose: () => void }): ReactElement {
  const id = useId();
  const mark = brainMark(brain.state);
  const ready = mark === 'ready';
  // A brain that is not checked yet, while a check is running, is being checked — not in
  // need of the user's attention. (Every brain is in that state for the first seconds of a
  // page: the runner looks at its brains when the first page asks, never before.)
  const word = answering ? 'answering' : checking && brainReadyState(brain.state) === 'unknown' ? 'checking…' : BRAIN_MARK_WORD[mark];
  return (
    // The whole row is the control: a ready brain's row pins it. A brain that is not ready
    // cannot be picked — a pin that cannot answer is a dead control — but its row stays
    // FOCUSABLE (`aria-disabled`, not `disabled`), because the remedy inside it is the one
    // thing a keyboard or screen-reader user came here for.
    <button
      type="button"
      className="brain-row"
      data-testid={`brain-option-${brain.id}`}
      data-state={brainReadyState(brain.state)}
      data-mark={mark}
      data-answering={answering}
      aria-pressed={chosen}
      aria-disabled={!ready}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-state ${id}-notes`}
      onClick={ready && !chosen ? onChoose : undefined}
    >
      <span className="brain-row-main">
        <span className="brain-row-name" id={`${id}-name`}>
          {brain.name}
        </span>
        <span className="brain-row-via">{brain.via}</span>
      </span>
      <span className="brain-row-state" id={`${id}-state`}>
        <span className="brain-mark" aria-hidden="true" />
        {/* The answering brain is necessarily ready, so "answering" is the more useful word. */}
        {word}
      </span>
      <span className="brain-row-notes" id={`${id}-notes`}>
        {!brain.verified ? (
          <span className="brain-row-note brain-row-experimental" data-testid={`brain-experimental-${brain.id}`}>
            <strong>{BRAIN_UNVERIFIED_LABEL}</strong> {BRAIN_UNVERIFIED_BODY}
          </span>
        ) : null}
        {!ready ? (
          <span className="brain-row-note brain-row-remedy" data-testid={`brain-remedy-${brain.id}`}>
            <Prose text={brainRemedy(brain)} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

function LevelPicker({ levels, value, onChange }: { levels: readonly string[]; value: string | undefined; onChange: (level: string | undefined) => void }): ReactElement {
  const native = useRef<HTMLSelectElement>(null);
  const segmented = levels.length <= MAX_SEGMENTED_LEVELS;
  return (
    <div className="brain-dock-field">
      <span className="brain-dock-field-label">thinking level</span>
      {/* ONE control, shown two ways. The native select is the control: its keyboard, its
          accessible name and value, and what a test selects. While the levels fit a row it is
          laid transparently over a row of segments — the same options, one tap each — which
          are a pointer affordance only, hidden from assistive technology so the level is
          never announced twice. */}
      <div className="brain-dock-levels" data-segmented={segmented}>
        <select
          ref={native}
          aria-label="thinking level"
          data-testid="brain-menu-effort"
          value={value ?? ''}
          onChange={(event) => onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
        >
          <option value="">default</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {segmented ? (
          <div className="brain-dock-segments" aria-hidden="true">
            {[undefined, ...levels].map((level) => (
              <span
                key={level ?? ''}
                className="brain-dock-segment"
                data-testid={`brain-level-${level ?? 'default'}`}
                data-selected={level === value}
                onClick={() => {
                  onChange(level);
                  // The keyboard continues from the real control.
                  native.current?.focus();
                }}
              >
                {level ?? 'default'}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BrainSwitcher({ seat }: { seat: BrainSwitchSeat }): ReactElement {
  const brain = useActiveBrain();
  const state = useSyncExternalStore(seat.state.subscribe, seat.state.get, seat.state.get);
  const { open, toggle, triggerRef, menuRef } = useDismissableMenu();

  // The label is the host arm's own, read LIVE: it is a getter over the same two sources
  // this state is derived from, and the state changing is what re-renders this.
  const pinned = getPlatform().brain;
  const answering = state.brains.find((candidate) => candidate.id === state.active);
  const label = answering !== undefined && pinned?.kind === 'host' ? pinned.label : undefined;
  const standIn = demoStandIn(state);
  // The levels of the model the answering brain would run — per model, in its own words.
  const levels = answering === undefined ? [] : brainLevels(answering, state.model);
  const level = state.effort ?? 'default';
  const experimental = answering !== undefined && !answering.verified;

  const aria =
    label === undefined
      ? `what’s thinking: demo brain — ${standIn?.why ?? 'no agent is answering'}`
      : `what’s thinking: ${label}${experimental ? ` (${BRAIN_UNVERIFIED_LABEL})` : ''}${levels.length > 0 ? `, thinking level ${level}` : ''}`;
  // What ANSWERED, never what was asked (ADR-0059 rule 2): a chosen model is not named here
  // until a think has come back on it — and what another brain answered on is not this one's.
  const ran = answering !== undefined && state.answered?.brain === answering.id ? state.answered.model : undefined;
  // …and a CHOSEN model nothing has answered on yet is said as asked for: "thinking on the
  // default model" there was untrue — the next think carries the choice.
  const asked = answering === undefined || ran !== undefined || state.model === undefined ? undefined : (answering.models.find((model) => model.id === state.model)?.name ?? state.model);
  const levelWords = levels.length > 0 ? `, level ${level}` : '';

  const refusal =
    state.refusal !== undefined ? (
      <p className="brain-dock-refusal" data-testid="brain-menu-cli-note">
        <Prose text={state.refusal} />
      </p>
    ) : null;

  return (
    <div className="identity-menu-wrap brain-dock-wrap">
      <button
        type="button"
        ref={triggerRef}
        className="brain-chip"
        data-testid="brain-chip"
        data-brain={brain}
        data-experimental={experimental}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={aria}
        title={aria}
        onClick={toggle}
      >
        <span className="brain-dot" aria-hidden="true" />
        {label === undefined ? (
          // The demo brain is standing in: the chip says so, and — where there is room — WHY.
          // The 375px header has none (see app.css), so there it is the one word, as on web.
          <span className="brain-chip-text">
            <span className="brain-chip-label brain-chip-label-full">demo brain</span>
            <span className="brain-chip-label brain-chip-label-short">demo</span>
            {standIn !== undefined ? (
              <span className="brain-chip-sub" data-testid="brain-chip-why">
                {standIn.why}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="brain-chip-text">
            <span className="brain-chip-label">{label}</span>
            {/* Under the label, smaller (S12): that the brain is experimental, and the thinking
                level — only where the model HAS levels (Haiku 4.5 has none, and naming a level
                it ignores would be noise). An unchosen level is "default": a brain reports its
                default level nowhere, so none is invented. */}
            {experimental || levels.length > 0 ? (
              <span className="brain-chip-sub">
                {experimental ? <span data-testid="brain-chip-experimental">experimental</span> : null}
                {experimental && levels.length > 0 ? ' · ' : null}
                {levels.length > 0 ? <span data-testid="brain-chip-effort">{`thinking · ${level}`}</span> : null}
              </span>
            ) : null}
          </span>
        )}
      </button>
      {open ? (
        <div className="identity-menu brain-dock" data-testid="brain-menu" ref={menuRef} role="group" aria-label="what’s thinking" data-checking={state.checking}>
          <div className="brain-dock-head">
            <div className="brain-dock-now" data-testid="brain-dock-now">
              <span className="brain-dock-kicker">answering now</span>
              <span className="brain-dock-title">{label ?? 'the demo brain'}</span>
            </div>
            {/* In the head, so nothing above it can grow and move it from under the pointer. */}
            <button
              type="button"
              className="brain-dock-recheck"
              data-testid="brain-recheck"
              aria-busy={state.checking}
              aria-disabled={state.checking}
              title="ask the runner to look at your agents again"
              onClick={state.checking ? undefined : () => void seat.recheck()}
            >
              <span className="brain-dock-spin" aria-hidden="true" />
              {state.checking ? 'checking…' : 'check again'}
            </button>
          </div>
          {standIn !== undefined ? (
            <p className="brain-dock-standin" data-testid="brain-dock-standin">
              {/* Never "nothing to configure": on the runner there is always something to do. */}
              <strong>{standIn.why}.</strong> {standInBody(standIn, state.brains)}
              {/* A reason that is about ONE agent has its remedy on that agent's row, below. */}
              {standIn.brain === undefined ? <span className="brain-dock-standin-remedy"> {standIn.remedy}</span> : null}
            </p>
          ) : null}
          {answering === undefined ? refusal : null}
          <div className="brain-dock-list" role="group" aria-label="which agent answers">
            <button
              type="button"
              className="brain-row brain-row-auto"
              data-testid="brain-switch-auto"
              aria-pressed={state.choice === BRAIN_AUTO}
              onClick={state.choice === BRAIN_AUTO ? undefined : () => seat.choose(BRAIN_AUTO)}
            >
              <span className="brain-row-main">
                <span className="brain-row-name">auto</span>
                <span className="brain-row-via">{autoChoiceLine(state)}</span>
              </span>
            </button>
            {state.brains.map((candidate) => (
              <BrainRow
                key={candidate.id}
                brain={candidate}
                chosen={state.choice === candidate.id}
                answering={candidate.id === state.active}
                checking={state.checking}
                onChoose={() => seat.choose(candidate.id)}
              />
            ))}
            {state.brains.length === 0 ? (
              <p className="brain-dock-empty" data-testid="brain-dock-empty">
                your agents will be listed here.
              </p>
            ) : null}
          </div>
          {answering !== undefined ? (
            <div className="brain-dock-controls" data-testid="brain-dock-controls">
              <label className="brain-dock-field">
                <span className="brain-dock-field-label">model</span>
                {/* A dropdown of the brain's OWN catalogue (S9) — exact ids, so a typo cannot
                    break a call. No `other…` rung: it swapped the dropdown for a text field with
                    no way back (owner's walk, 2026-10-02). Free text survives ONLY as the whole
                    control when no catalogue could be read (it is an internal cache and may move),
                    because the alternative there is no control at all. */}
                {answering.models.length > 0 ? (
                  <select
                    aria-label="model"
                    data-testid="brain-menu-model-select"
                    value={state.model ?? ''}
                    onChange={(event) => seat.setModel(event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
                  >
                    <option value="">{`${answering.name}’s default`}</option>
                    {answering.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                    {/* A model stored earlier that this brain no longer lists stays visible and
                        selectable-away, rather than silently reading as "default". */}
                    {state.model !== undefined && !answering.models.some((model) => model.id === state.model) ? (
                      <option value={state.model}>{state.model}</option>
                    ) : null}
                  </select>
                ) : (
                  <input
                    // Uncontrolled, so typing is not fought by a re-render; keyed, so another
                    // brain's field does not open holding this one's text.
                    key={answering.id}
                    type="text"
                    aria-label="model"
                    data-testid="brain-menu-model"
                    placeholder={`${answering.name}’s default`}
                    defaultValue={state.model ?? ''}
                    onChange={(event) => seat.setModel(event.currentTarget.value)}
                  />
                )}
              </label>
              {/* Not every model HAS a thinking level (Haiku 4.5 does not), and a control the
                  model ignores is a dead control (AC8). */}
              {levels.length > 0 ? <LevelPicker levels={levels} value={state.effort} onChange={(next) => seat.setEffort(next)} /> : null}
              <p className="brain-dock-active" data-testid="brain-menu-active">
                {asked !== undefined
                  ? `next think asks for ${asked}${levelWords} — what answers is shown here after it`
                  : `thinking on ${ran ?? `${answering.name}’s default model (known after the first think)`}${levelWords}`}
              </p>
              {refusal}
              <p className="brain-dock-hint" data-testid="brain-menu-cli-hint">
                {seat.note}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
