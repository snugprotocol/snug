import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';

import type { ChatFetchFact } from '@snugprotocol/protocol';

import { AccessCard, type ResolveAccessCard } from '../access/AccessCard.js';
import { AccessWriteCard } from '../access/AccessWriteCard.js';
import { OwnUndoAct } from '../access/OwnUndoAct.js';
import type { UndoOutcome } from '../access/writeBroker.js';
import type { AccessWriteCardState } from '../agent/accessWriteCard.js';
import { sanitizeCardText, type ChatCardState } from '../agent/cards.js';
import { DATA_WRITE_CARD, FETCH_FACTS } from '../agent/copy.dataWrite.js';
import type { BuildStepView, ChatMessage, DataWriteCardState } from '../agent/useBuilderChat.js';
import { CONNECTIONS_UNAVAILABLE } from '../platform/availability.js';
import { allows } from '../platform/platform.js';
import { OFFER } from '../schedule/copy.page.js';
import { ScheduleCard, type ResolveScheduleCard } from '../schedule/ScheduleCard.js';
import { ScheduleOffer } from '../schedule/ScheduleOffer.js';
import { netConfirmStore, registerChatConfirmSurface, resolveNetConfirm } from '../state/net.js';
import { useStore } from '../state/store.js';
import { useBrain } from '../state/webllm.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { AuthChoiceCard } from './AuthChoiceCard.js';
import { ReportErrorLink } from '../feedback/ReportErrorLink.js';
import { StatusLine, type StatusPhase } from './StatusLine.js';

export interface ChatLogProps {
  messages: ChatMessage[];
  /**
   * Ordered build steps for the in-flight turn (empty when idle).
   *
   * No longer rendered as a timeline — the status line replaces that surface (AC9), and
   * the factual per-tool record lives in the LLM inspector, nested under the round trip
   * that requested each tool (AC5). Kept as a prop because a non-empty `steps` is still
   * the signal that a turn is running.
   */
  steps?: BuildStepView[];
  /** Tool activity label — retained for callers; no longer rendered as copy. */
  activity?: string | undefined;
  /**
   * Whether a turn is actually in flight — the ONLY signal the status line keys on.
   *
   * Deliberately not `steps.length > 0`: `steps` is cleared at turn START and never at
   * turn END, so it legitimately outlives the turn as a record of what ran. Keying a
   * live "in flight" indicator on it left the line rotating forever under a finished
   * build (Gate-5 review, 2026-08-05). `busy` is cleared in useBuilderChat's `finally`.
   */
  busy?: boolean;
  /** Which half of the build the user is in; drives the status copy (AC10). */
  phase?: StatusPhase;
  /** Compact mode for the run-view chat rail (smaller artifact cards). */
  compact?: boolean;
  /**
   * Mount for a VALIDATED `auth_wizard` directive card: the caller wires this to the
   * connection wizard with the attached appId. Absent ⇒ the card renders with a disabled
   * CTA (no app to attach the connection to yet).
   *
   * It takes NO argument. In v4 the card is a DOORBELL: the requirement was already
   * persisted at build time through the gated pipeline, so what the wizard reviews comes
   * from the row and the card cannot propose anything at click time.
   */
  onDirectiveConnect?: () => void;
  /**
   * Mount for the v4 connect card. Receives the (appId, slot) of the PERSISTED row so
   * the caller can open the wizard on exactly that connection — not a provider name the
   * caller would have to resolve back to a row.
   */
  onConnectionConnect?: (connection: { appId: string; slot: string }) => void;
  /** Approve a staged data-write proposal (ADR-0019 D8). Absent ⇒ the card is read-only. */
  onApproveDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
  /** Decline it. Declining executes nothing — there is no path from here to the DB. */
  onDeclineDataWrite?: (proposal: DataWriteCardState, messageId: number) => void;
  /**
   * Undo an applied card's change (TASK-20261010-host-broker PR-4, D-PR4-19) — host chrome's act,
   * carried out by the hook; it answers whether the rows went back. Absent ⇒ no card offers *undo*.
   */
  onUndoDataWrite?: (card: DataWriteCardState, messageId: number) => Promise<UndoOutcome>;
  /** The undo ids the journal holds LIVE (the hook's read): only those cards offer *undo*. Absent: none does. */
  dataWriteUndoable?: ReadonlySet<string>;
  /** The app whose data the cards change — the undo's question names it. */
  appName?: string;
  /**
   * Resolve an inline choice card (TASK-20260815-inline-cards): the pick becomes the
   * next user message. Absent ⇒ options render disabled (a surface with no send path).
   */
  onSelectCardOption?: (card: ChatCardState, messageId: number, optionId: string) => void;
  /**
   * Resolve the schedule suggestion card (TASK-20261009 P1; ADR-0074 §4) —
   * `(card: ScheduleCardState, messageId, resolution: 'scheduled' | 'declined', taskId?)`. The
   * card never writes the chat row itself: the hook that staged it persists the answer on the
   * row and patches its message. Absent ⇒ the card's acts render disabled (a surface with no
   * path to persist an answer must not create anything — the choice card's rule).
   */
  onResolveSchedule?: ResolveScheduleCard;
  /**
   * Resolve the brain's ASK card (TASK-20261010-host-broker PR-2; D-PR2-11) —
   * `(card: AccessCardState, messageId, resolution)`. The card never writes the chat row itself:
   * the hook that staged it persists the answer on the row and patches its message. Absent ⇒ the
   * card's acts render disabled (the schedule card's rule: an answer with nowhere to go asks nobody).
   */
  onResolveAccess?: ResolveAccessCard;
  /**
   * The chat's CROSS-APP card's acts (TASK-20261010-host-broker PR-5, D-PR5-14): *apply to Ledger*
   * and *cancel*, carried out by the hook. Absent ⇒ the card offers no act.
   */
  onApproveAccessWrite?: (card: AccessWriteCardState, messageId: number) => void;
  onDeclineAccessWrite?: (card: AccessWriteCardState, messageId: number) => void;
}

/**
 * The demo-turn provenance tag (TASK-20260826, ADR-0059 rule 3) — pinned copy: a
 * screenshot of scripted output must describe itself. Rendered from the MESSAGE's
 * persisted brain kind, never from live settings, so history keeps its truth after
 * a mode switch.
 */
export const DEMO_TURN_TAG = 'scripted demo — not an AI response';

/**
 * What *fetch new data first* came to (TASK-20261010-host-broker PR-5, D-PR5-20; Gate-5 G5-17), from
 * the message's FACTS — never a sentence a row carried: the one wording (`FETCH_FACTS.note`,
 * `FETCH_FIRST`'s words), composed with a NUL-fenced index in place of each fact's name — no copy
 * sentence holds a NUL, and no fact's name can — and each name put back in its own `<bdi>`, so a
 * right-to-left name can never reorder the host's words.
 */
function fetchNoteFrom(facts: readonly ChatFetchFact[], now: number): ReactNode[] {
  const marked = facts.map((fact, index) => ({ ...fact, source: `\u0000${index}\u0000` }));
  return FETCH_FACTS.note(marked, now)
    .split(/\u0000(\d+)\u0000/)
    .map((part, index) => (index % 2 === 1 ? <bdi key={index}>{facts[Number(part)]?.source}</bdi> : part));
}

/** The streamed conversation: user bubbles, streaming agent text with a soft caret,
    error notes as data, and the artifact card with its "run it" CTA. */
export function ChatLog({
  messages,
  steps = [],
  activity,
  busy = false,
  phase = 'build',
  compact = false,
  onDirectiveConnect,
  onConnectionConnect,
  onApproveDataWrite,
  onDeclineDataWrite,
  onUndoDataWrite,
  dataWriteUndoable,
  appName,
  onSelectCardOption,
  onResolveSchedule,
  onResolveAccess,
  onApproveAccessWrite,
  onDeclineAccessWrite,
}: ChatLogProps): ReactElement {
  // Under a platform-pinned HOST brain the chat has no classifier and no `schedule` lane
  // (TASK-20261009 P2): the deterministic offer is the route, and its line says so.
  const brain = useBrain();
  const offerNote = brain.kind === 'host' ? OFFER.hostBrain : undefined;
  return (
    <div className="chat-log" aria-live="polite">
      {messages.map((message) => (
        <div key={message.id} style={{ display: 'contents' }}>
          <div className={`msg ${message.role === 'user' ? 'msg-user' : 'msg-agent'}`}>
            <span className={message.streaming === true && message.displayText !== '' ? 'streaming-caret' : undefined}>
              {message.displayText}
            </span>
            {message.error !== undefined ? (
              <div className="error-note" role="alert">
                {message.error.message}
                {message.error.retryable ? ' — try again.' : ''}{' '}
                <ReportErrorLink context={{ surface: 'build', errorText: message.error.message }} />
              </div>
            ) : null}
            {message.directiveNote !== undefined ? <div className="hint">{message.directiveNote}</div> : null}
            {/* TASK-20261010-host-broker PR-5 (D-PR5-20; G5-17): what *fetch new data first* came to — the host's words, from the facts, on the person's own message. */}
            {message.role === 'user' && message.fetched !== undefined ? (
              <div className="hint" data-testid="chat-fetch-note">
                {fetchNoteFrom(message.fetched, Date.now())}
              </div>
            ) : null}
            {message.role === 'agent' && message.brainKind === 'demo' ? (
              <div className="demo-turn-tag" data-testid="demo-turn-tag">
                <span aria-hidden="true">🧪</span> {DEMO_TURN_TAG}
              </div>
            ) : null}
          </div>
          {/*
            THE SCHEDULE OFFER (TASK-20261009 E10, ADR-0074 §4): a user message that reads like
            a schedule gets one deterministic, dismissible line under its bubble — on every
            brain, because it never calls one. This is the one place both chats pass through
            (the builder view and the run rail), so it renders once per message; the component
            memoises its parse per message and owns its own dismissal.
          */}
          {message.role === 'user' && allows('schedule') ? (
            <ScheduleOffer text={message.displayText} {...(offerNote !== undefined ? { note: offerNote } : {})} />
          ) : null}
          {message.directive !== undefined ? (
            <Card className="artifact-card" data-testid="auth-directive-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                🔐
              </span>
              <span className="artifact-name">connect {message.directive.proposal.providerName}</span>
              {!allows('connections') ? (
                // D4: no connected apps inside an artifact — the card names the ask and says
                // why nothing can be done about it here (never a dead button).
                <span className="hint">{CONNECTIONS_UNAVAILABLE}</span>
              ) : onDirectiveConnect !== undefined ? (
                <Button onClick={() => onDirectiveConnect()}>connect</Button>
              ) : (
                <span className="hint">run the app once to attach this connection</span>
              )}
            </Card>
          ) : null}
          {/*
            The v4 CONNECT CARD. It renders only when the post-turn pipeline actually
            PERSISTED a row, so it can never advertise a connection that does not exist —
            the v3 card rendered from the reply's directive and could outlive a refused
            requirement. Clicking it opens the wizard on that (appId, slot); everything
            the user reviews is read from the row.
          */}
          {message.connection !== undefined ? (
            <Card className="artifact-card" data-testid="connection-requirement-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                🔌
              </span>
              <span className="artifact-name">connect {message.connection.providerName}</span>
              {onConnectionConnect !== undefined ? (
                <Button onClick={() => onConnectionConnect(message.connection!)}>connect</Button>
              ) : (
                <span className="hint">run the app once to attach this connection</span>
              )}
            </Card>
          ) : null}
          {/*
            The AUTH-OPTION CHOICE CARD (TASK-20260812-auth-kind-choice). Rendered from
            a pointer + the live row; the component itself hides once the row is chosen,
            approved, or gone — so this mount can stay unconditional on the seed.
          */}
          {message.authChoice !== undefined ? <AuthChoiceCard choice={message.authChoice} /> : null}
          {/*
            The DATA-WRITE APPROVAL CARD (ADR-0019 D8). Everything the user is agreeing
            to is ON the card — the plain-language summary, the VERBATIM statements, and
            the affected-row counts — because "the human approves" only means something
            if the human can see what they are approving.

            Once resolved the buttons are gone: an approved change that still offers
            "apply" invites a second, unreviewed execution. An applied change offers *undo*
            while the journal holds it live (PR-4, D-PR4-19); the words are DATA_WRITE_CARD's.
          */}
          {message.dataWrite !== undefined ? (
            <DataWriteCard
              card={message.dataWrite}
              messageId={message.id}
              onApprove={onApproveDataWrite}
              onDecline={onDeclineDataWrite}
              onUndo={onUndoDataWrite}
              undoable={dataWriteUndoable}
              appName={appName}
            />
          ) : null}
          {/*
            The INLINE CHOICE CARD (TASK-20260815-inline-cards, ADR-0031 §3). UI-only
            authority: tapping an option sends a plain user message — nothing here
            executes anything. Once resolved, options collapse to the recorded pick
            (single-shot; a card must never offer the same decision twice).
          */}
          {message.card !== undefined ? (
            <Card className="artifact-card chat-choice-card" data-testid="chat-choice-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
                {/* The provenance line is the anti-imitation affordance (Gate-5 B
                    MINOR-4): every model-authored card SAYS it is the agent asking, so
                    a card styled to read like a host consent surface still opens with
                    the one line a host surface never carries. Text is sanitized —
                    bidi/control characters stripped — so display order is the
                    codepoint order that a pick would send. */}
                <span className="hint">the agent is asking:</span>
                {message.card.title !== undefined ? (
                  <span className="artifact-name">{sanitizeCardText(message.card.title)}</span>
                ) : null}
                <span>{sanitizeCardText(message.card.body)}</span>
                {message.card.resolution === undefined ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                    {message.card.options.map((option) => (
                      <Button
                        key={`${message.id}-opt-${option.id}`}
                        onClick={
                          onSelectCardOption !== undefined
                            ? () => onSelectCardOption(message.card!, message.id, option.id)
                            : undefined
                        }
                        // Disabled while the turn is IN FLIGHT (Gate-5 B MAJOR-1): a
                        // mid-turn pick had no send path (the busy guard swallowed it)
                        // and no row to persist to — the click window opens when the
                        // turn settles and both exist.
                        disabled={onSelectCardOption === undefined || busy}
                        title={option.description !== undefined ? sanitizeCardText(option.description) : undefined}
                      >
                        {sanitizeCardText(option.label)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <span className="hint">
                    {message.card.resolution.kind === 'selected'
                      ? `you chose: ${sanitizeCardText(message.card.resolution.label)}`
                      : 'dismissed'}
                  </span>
                )}
              </div>
            </Card>
          ) : null}
          {/*
            The SCHEDULE SUGGESTION CARD (TASK-20261009 P1, ADR-0074 §4; `schedule/ScheduleCard.tsx`):
            what `schedule_propose` staged, with its three acts. Its answer travels back through
            `onResolveSchedule` with this message's id — the card is UI, never a gate (ADR-0031 §3),
            and never writes the row itself.
          */}
          {message.schedule !== undefined && allows('schedule') ? (
            <ScheduleCard card={message.schedule} messageId={message.id} busy={busy} onResolve={onResolveSchedule} />
          ) : null}
          {/*
            The brain's ASK CARD (TASK-20261010-host-broker PR-2, D-PR2-11; `access/AccessCard.tsx`):
            what `access_propose` staged, with *review* (the host's own sheet) and *not now*. Its
            answer travels back through `onResolveAccess` with this message's id — the card is UI,
            never a gate, and never writes the row itself. Only where the host allows access
            between apps (the schedule card's rule).
          */}
          {message.access !== undefined && allows('access') ? (
            <AccessCard card={message.access} messageId={message.id} busy={busy} onResolve={onResolveAccess} />
          ) : null}
          {/*
            The CROSS-APP CARD (TASK-20261010-host-broker PR-5, D-PR5-14; `access/AccessWriteCard.tsx`):
            a change the chat's AI proposed to another app's table, applied only from the card's own act
            — carried out by the hook, never by the card. Only where the host allows access between apps.
          */}
          {message.accessWrite !== undefined && allows('access') ? (
            <AccessWriteCard
              card={message.accessWrite}
              messageId={message.id}
              busy={busy}
              {...(onApproveAccessWrite !== undefined ? { onApply: onApproveAccessWrite } : {})}
              {...(onDeclineAccessWrite !== undefined ? { onCancel: onDeclineAccessWrite } : {})}
            />
          ) : null}
          {message.artifact !== undefined ? (
            <Card className="artifact-card" data-testid="artifact-card">
              <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                ✦
              </span>
              <span className="artifact-name">{message.artifact.displayName}</span>
              {compact ? null : (
                <Link to={`/run/${message.artifact.artifactId}`} className="btn btn-primary">
                  run it
                </Link>
              )}
            </Card>
          ) : null}
        </div>
      ))}
      {/*
        One rotating status line in place of BOTH the step timeline and the
        last-write-wins pill (AC9). The two said roughly the same thing in two places,
        and neither said as much as the LLM inspector already shows — which is where the
        factual record now lives (AC5, D0/Q1).
      */}
      {/*
        The PROVIDER WRITE-CONFIRM CARD (TASK-20260815-inline-cards AC5): a chat-origin
        parked confirm renders HERE instead of the modal (NetConfirmDialog returns null
        for origin 'chat' — one surface per decision). The card resolves the same parked
        entry the executor is awaiting; host, method and URL come from the executor's own
        confirm payload, so what the user reads is what will run.
      */}
      <ProviderConfirmCard />
      <StatusLine phase={phase} active={busy} />
    </div>
  );
}

/** The app a card's undo question names when the surface did not say. */
const THIS_APP = 'this app';

/**
 * The DATA-WRITE card itself (ADR-0019 D8; TASK-20261010-host-broker PR-4, D-PR4-19): the summary,
 * each statement verbatim with its dry-run count, then the two acts — or, once answered, what became
 * of it. An applied change says what it changed and, in the same breath, its undo: offered while
 * its entry is live (and the surface wired the act), *can no longer be undone* once it is not, *this
 * one can't be undone* when it was never captured. The line and its undo keep ONE shape from
 * *applied* to *undone*, so the outcome line that took the focus is never pulled from under it.
 */
function DataWriteCard({
  card,
  messageId,
  onApprove,
  onDecline,
  onUndo,
  undoable,
  appName = THIS_APP,
}: {
  card: DataWriteCardState;
  messageId: number;
  onApprove: ChatLogProps['onApproveDataWrite'];
  onDecline: ChatLogProps['onDeclineDataWrite'];
  onUndo: ChatLogProps['onUndoDataWrite'];
  undoable: ReadonlySet<string> | undefined;
  appName?: string | undefined;
}): ReactElement {
  const changed = (card.executed ?? card.previewed).reduce((sum, n) => sum + n, 0);
  const live = card.undoId !== undefined && undoable?.has(card.undoId) === true;
  return (
    <Card className="artifact-card" data-testid="data-write-card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
        <span className="artifact-name">{card.summary}</span>
        <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
          {card.statements.map((statement, index) => (
            <li key={`${messageId}-sql-${index}`}>
              <code style={{ wordBreak: 'break-word' }}>{statement}</code>
              <span className="hint"> {DATA_WRITE_CARD.previewed(card.previewed[index] ?? 0)}</span>
            </li>
          ))}
        </ol>
        {card.outcome === undefined ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {onApprove !== undefined ? (
              <Button variant="primary" onClick={() => onApprove(card, messageId)}>
                {DATA_WRITE_CARD.apply}
              </Button>
            ) : null}
            {onDecline !== undefined ? <Button onClick={() => onDecline(card, messageId)}>{DATA_WRITE_CARD.cancel}</Button> : null}
          </div>
        ) : card.outcome === 'applied' || card.outcome === 'undone' ? (
          card.undoable === false ? (
            <span className="hint">{DATA_WRITE_CARD.appliedLine(changed, 'none')}</span>
          ) : card.outcome === 'undone' || (live && onUndo !== undefined) ? (
            <span className="hint field-row field-row-wrap">
              <span>{DATA_WRITE_CARD.appliedLine(changed, 'offered')}</span>
              {' · '}
              <OwnUndoAct rows={changed} appName={appName} offered={live} onUndo={onUndo === undefined ? undefined : () => onUndo(card, messageId)} undone={card.outcome === 'undone'} />
            </span>
          ) : (
            // Captured once, but no longer live — or a change from before undo existed, which claims nothing.
            <span className="hint">{DATA_WRITE_CARD.appliedLine(changed, card.undoId !== undefined ? 'ended' : 'offered')}</span>
          )
        ) : (
          <span className="hint">
            {card.outcome === 'declined' ? DATA_WRITE_CARD.declined : card.outcome === 'drifted' ? DATA_WRITE_CARD.drifted : DATA_WRITE_CARD.failed}
          </span>
        )}
      </div>
    </Card>
  );
}

function ProviderConfirmCard(): ReactElement | null {
  const pending = useStore(netConfirmStore);
  const [remember, setRemember] = useState(false);
  // Register THIS mount as a live chat confirm surface (Gate-5 B MAJOR-2): while at
  // least one is mounted the modal yields chat-origin confirms to us; when the rail
  // tab unmounts the ChatLog, the modal takes over so no parked decision goes surface-less.
  useEffect(() => registerChatConfirmSurface(), []);
  if (pending === null || pending.origin !== 'chat') return null;
  const { host, method, url } = pending.request;
  return (
    <Card className="artifact-card" data-testid="provider-confirm-card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
        <span className="artifact-name">allow this change?</span>
        <span>
          Your chat request needs a <strong>{method}</strong> to <strong>{host}</strong>. Your saved credentials are
          attached by the host — the conversation never sees them.
        </span>
        <code style={{ wordBreak: 'break-all' }}>{url}</code>
        <label className="check-label">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          remember for this session ({method} to {host})
        </label>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button
            onClick={() => {
              setRemember(false);
              resolveNetConfirm({ granted: false });
            }}
          >
            deny
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const rememberSession = remember;
              setRemember(false);
              resolveNetConfirm({ granted: true, rememberSession });
            }}
          >
            allow
          </Button>
        </div>
      </div>
    </Card>
  );
}
