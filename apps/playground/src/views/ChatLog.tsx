import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useLocation } from 'react-router';

import type { ScheduleStep } from '@snugprotocol/protocol';

import { sanitizeCardText, type ChatCardState } from '../agent/cards.js';
import { persistScheduleResolution, readScheduleCardRow, type ScheduleCardState } from '../agent/scheduleCard.js';
import type { BuildStepView, ChatMessage, DataWriteCardState } from '../agent/useBuilderChat.js';
import { CONNECTIONS_UNAVAILABLE } from '../platform/availability.js';
import { allows } from '../platform/platform.js';
import { SCHEDULE_CARD, stepLabel } from '../schedule/copy.js';
import { OFFER } from '../schedule/copy.page.js';
import { describeSpec, nextOccurrence, resolveZone } from '../schedule/cron.js';
import { approvedHostsByApp } from '../schedule/editorModel.js';
import { EnableConsent } from '../schedule/EnableConsent.js';
import { enableProposedTask } from '../schedule/enableProposedTask.js';
import { pageClock } from '../schedule/pageModel.js';
import { formatOccurrence } from '../schedule/PreviewAndCost.js';
import { editHref, newScheduleHref } from '../schedule/routes.js';
import { ScheduleOffer } from '../schedule/ScheduleOffer.js';
import { netConfirmStore, registerChatConfirmSurface, resolveNetConfirm } from '../state/net.js';
import { useStore } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';
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
   * Resolve an inline choice card (TASK-20260815-inline-cards): the pick becomes the
   * next user message. Absent ⇒ options render disabled (a surface with no send path).
   */
  onSelectCardOption?: (card: ChatCardState, messageId: number, optionId: string) => void;
}

/**
 * The demo-turn provenance tag (TASK-20260826, ADR-0059 rule 3) — pinned copy: a
 * screenshot of scripted output must describe itself. Rendered from the MESSAGE's
 * persisted brain kind, never from live settings, so history keeps its truth after
 * a mode switch.
 */
export const DEMO_TURN_TAG = 'scripted demo — not an AI response';

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
  onSelectCardOption,
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
            "apply" invites a second, unreviewed execution.
          */}
          {message.dataWrite !== undefined ? (
            <Card className="artifact-card" data-testid="data-write-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%' }}>
                <span className="artifact-name">{message.dataWrite.summary}</span>
                <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                  {message.dataWrite.statements.map((statement, index) => (
                    <li key={`${message.id}-sql-${index}`}>
                      <code style={{ wordBreak: 'break-word' }}>{statement}</code>
                      <span className="hint">
                        {' '}
                        — {message.dataWrite?.previewed[index] ?? 0} row(s)
                      </span>
                    </li>
                  ))}
                </ol>
                {message.dataWrite.outcome === undefined ? (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {onApproveDataWrite !== undefined ? (
                      <Button variant="primary" onClick={() => onApproveDataWrite(message.dataWrite!, message.id)}>
                        apply to my data
                      </Button>
                    ) : null}
                    {onDeclineDataWrite !== undefined ? (
                      <Button onClick={() => onDeclineDataWrite(message.dataWrite!, message.id)}>cancel</Button>
                    ) : null}
                  </div>
                ) : (
                  <span className="hint">
                    {message.dataWrite.outcome === 'applied'
                      ? `applied — ${(message.dataWrite.executed ?? message.dataWrite.previewed).join(', ')} row(s) changed`
                      : message.dataWrite.outcome === 'declined'
                        ? 'cancelled — nothing was changed'
                        : message.dataWrite.outcome === 'drifted'
                          ? 'the number of rows this would affect changed since the preview, so nothing was applied — ask again for a fresh one'
                          : 'the change could not be applied — nothing was changed'}
                  </span>
                )}
              </div>
            </Card>
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
            The SCHEDULE SUGGESTION CARD (TASK-20261009 P1, ADR-0074 §4): what `schedule_propose`
            staged — the title, the steps in words, the when and the next time — with three acts.
            *Schedule it* opens the ONE consent surface inside the card and the user's act there
            calls the ONE writer; *edit…* opens the editor route prefilled; *not now* answers it.
            The card is UI, never a gate (ADR-0031 §3): nothing on it can enable a task by itself.
          */}
          {message.schedule !== undefined && allows('schedule') ? <ScheduleCard card={message.schedule} busy={busy} /> : null}
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

/** One step of a suggestion, in words — the label the editor uses, then the step's own words. */
function suggestionStepWords(step: ScheduleStep, appName: string | undefined): string {
  switch (step.kind) {
    case 'notify':
      return `${stepLabel('notify')}: ${step.title} — ${step.body}`;
    case 'app-think':
      return `${stepLabel('app-think', appName)}: ${step.prompt}`;
    case 'app-run':
      return step.input === undefined ? stepLabel('app-run', appName) : `${stepLabel('app-run', appName)} · ${JSON.stringify(step.input)}`;
    default: {
      const never: never = step;
      return never;
    }
  }
}

interface ScheduleCardProps {
  card: ScheduleCardState;
  /** The turn is in flight: the row does not exist yet, so an answer could not persist — the acts wait (the choice card's rule). */
  busy: boolean;
}

function ScheduleCard({ card, busy }: ScheduleCardProps): ReactElement {
  const location = useLocation();
  const [state, setState] = useState<ScheduleCardState>(card);
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  const [appMissing, setAppMissing] = useState(false);
  /** The consent panel is open: the hosts each app's approved connections may call. */
  const [consent, setConsent] = useState<Record<string, string[]> | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The row id lands after the turn finalizes; a resolution the hook rehydrated is adopted once.
  useEffect(() => {
    setState((current) => ({
      ...current,
      ...(card.messageRowId !== undefined ? { messageRowId: card.messageRowId } : {}),
      ...(card.resolution !== undefined && current.resolution === undefined
        ? { resolution: card.resolution, ...(card.taskId !== undefined ? { taskId: card.taskId } : {}) }
        : {}),
    }));
  }, [card.messageRowId, card.resolution, card.taskId]);

  // THE ROW IS THE TRUTH: a card remounted after an answer given elsewhere (the other view,
  // an earlier mount) reads it back; the same read names the app and notices it is gone.
  useEffect(() => {
    let cancelled = false;
    void getUserDb().then((db) => {
      if (cancelled) return;
      if (card.appId !== undefined) {
        const app = db.getApp(card.appId);
        setAppMissing(app === undefined);
        if (app !== undefined) setAppNames({ [card.appId]: app.displayName });
      }
      if (card.messageRowId !== undefined) {
        const row = readScheduleCardRow(db, card.threadId, card.messageRowId);
        if (row?.resolution !== undefined) {
          const answered = row;
          setState((current) =>
            current.resolution === undefined ? { ...current, resolution: answered.resolution!, ...(answered.taskId !== undefined ? { taskId: answered.taskId } : {}) } : current,
          );
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [card.appId, card.messageRowId, card.threadId]);

  const { proposal } = state;
  const now = pageClock.now();
  const zone = resolveZone(proposal.spec.tz);
  const next = nextOccurrence(proposal.spec, now);
  const appName = state.appId !== undefined ? appNames[state.appId] : undefined;
  // Stale: the app the suggestion was for is gone, or its one time has passed (no next within the bound).
  const resolution = state.resolution === 'stale' || appMissing || next === undefined ? 'stale' : state.resolution;
  const whenWords = next === undefined ? describeSpec(proposal.spec) : formatOccurrence(next, zone);

  const resolve = async (resolved: ScheduleCardState): Promise<void> => {
    setState(resolved);
    persistScheduleResolution(await getUserDb(), resolved);
  };
  const openConsent = async (): Promise<void> => {
    const db = await getUserDb();
    setError(undefined);
    setConsent(approvedHostsByApp(db, state.appId !== undefined ? [state.appId] : []));
  };
  const enable = async (): Promise<void> => {
    setWorking(true);
    setError(undefined);
    const result = await enableProposedTask({ proposal, provenance: state.channel, ...(state.appId !== undefined ? { ownerAppId: state.appId } : {}) });
    setWorking(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setConsent(undefined);
    await resolve({ ...state, resolution: 'scheduled', taskId: result.task.id });
  };
  const editTo = newScheduleHref({
    suggestion: JSON.stringify(proposal),
    ...(state.appId !== undefined ? { app: state.appId } : {}),
    back: `${location.pathname}${location.search}`,
  });

  return (
    <Card className={`artifact-card schedule-card${resolution === 'declined' ? ' is-declined' : ''}`} data-testid="schedule-card" data-resolution={resolution ?? 'staged'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', width: '100%', ...(resolution === 'declined' ? { opacity: 0.6 } : {}) }}>
        {/* The provenance line every agent-authored card opens with (the choice card's rule). */}
        <span className="hint">{SCHEDULE_CARD.lead}</span>
        <span className="artifact-name">{proposal.title}</span>
        <ol style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
          {proposal.steps.map((step, index) => (
            <li key={`${state.hash}-${index}`} data-testid={`schedule-card-step-${index}`}>
              {suggestionStepWords(step, appName)}
            </li>
          ))}
        </ol>
        <span className="hint" data-testid="schedule-card-when">
          {describeSpec(proposal.spec)} · {next === undefined ? SCHEDULE_CARD.noNext : SCHEDULE_CARD.next(formatOccurrence(next, zone))}
        </span>
        {consent !== undefined ? (
          <EnableConsent
            steps={proposal.steps}
            spec={proposal.spec}
            now={now}
            appNames={appNames}
            hostsByApp={consent}
            busy={working}
            {...(error !== undefined ? { error } : {})}
            onEnable={() => void enable()}
            onNotNow={() => setConsent(undefined)}
          />
        ) : resolution === undefined ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <Button variant="primary" onClick={() => void openConsent()} disabled={busy} data-testid="schedule-card-accept">
              {SCHEDULE_CARD.accept}
            </Button>
            <Link to={editTo} className="btn" data-testid="schedule-card-edit">
              {SCHEDULE_CARD.edit}
            </Link>
            <Button onClick={() => void resolve({ ...state, resolution: 'declined' })} disabled={busy} data-testid="schedule-card-decline">
              {SCHEDULE_CARD.decline}
            </Button>
          </div>
        ) : (
          <span className="hint" data-testid="schedule-card-outcome">
            {resolution === 'scheduled' ? (
              <>
                {SCHEDULE_CARD.scheduled(whenWords)}{' '}
                {state.taskId !== undefined ? (
                  <Link to={editHref(state.taskId)} data-testid="schedule-card-open">
                    {SCHEDULE_CARD.open}
                  </Link>
                ) : null}
              </>
            ) : resolution === 'declined' ? (
              SCHEDULE_CARD.declined
            ) : (
              SCHEDULE_CARD.stale
            )}
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
