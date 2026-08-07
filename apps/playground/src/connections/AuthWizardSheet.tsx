// AuthWizardSheet — the Dynamic Auth wizard (AL-04 plan D5), rebuilt on playground
// components; the OProject implementation is Next.js-coupled and was NOT lifted.
//
// ONE app-level mount (M9 — App.tsx renders this once, outside the router views):
// the two entry points (chat directive card, ConnectionsCard) live in different
// views, and a per-view mount would strand the minutes-lived singleton on
// navigation. All flow state lives in state/wizard.ts; THIS component holds only
// edit drafts and credential field values (write-only: cleared on save, never
// loaded from the store — AC10).
//
// Review branches (AC3): host-computed provenance 'inference'/'user_docs' ⇒ the
// field-by-field spec_confirm; 'registry' (or a plain row review) ⇒ the light
// prefilled path. EVERY branch displays the FULL punycoded host list before
// approval enables (AC7/M10), and the re-approval branch renders the union diff
// with NEW/removed flags (M4). Order is B1: review → approve → only then
// credentials.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import {
  AUTH_SPEC_STATUS,
  deriveAuthAllowedHosts,
  normalizeAuthHost,
  type AuthField,
  type AuthSpec,
  type LlmProposal,
} from '@snugprotocol/protocol';
import {
  UserDbCredentialStore,
  needsUnsureConfidenceNote,
  paramsToAuthSpec,
} from '@snugprotocol/auth';
import type { AuthSpecRow } from '@snugprotocol/db';

import { inferenceWireCopy } from '../agent/inferrerAdapter.js';
import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import {
  approveWizardSpec,
  forceCloseWizard,
  openBlankOAuthPopup,
  requestCloseWizard,
  runWizardInference,
  saveWizardClientCreds,
  startOAuthFlow,
  wizardCloseConfirmStore,
  wizardFlowStatusStore,
  wizardNoteStore,
  wizardStepStore,
  wizardStore,
  type WizardSession,
} from '../state/wizard.js';
import { Button } from '../ui/Button.js';
import { Sheet } from '../ui/Sheet.js';

interface HintsDraft {
  providerName: string;
  kindHint: string;
  authorizeUrl: string;
  tokenUrl: string;
  hostsCsv: string;
  scopesCsv: string;
}

const csv = (values: readonly string[] | undefined): string => (values ?? []).join(', ');
const parseCsv = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

function draftFromProposal(session: WizardSession): HintsDraft {
  const proposal = session.proposal;
  return {
    providerName: proposal?.providerName ?? '',
    kindHint: proposal?.kindHint ?? 'api_key',
    authorizeUrl: proposal?.endpoints?.authorizeUrl ?? '',
    tokenUrl: proposal?.endpoints?.tokenUrl ?? '',
    hostsCsv: csv(proposal?.declaredApiHosts),
    scopesCsv: csv(proposal?.scopes),
  };
}

function draftToProposal(draft: HintsDraft, session: WizardSession): LlmProposal {
  const hosts = parseCsv(draft.hostsCsv);
  const scopes = parseCsv(draft.scopesCsv);
  const endpoints =
    draft.authorizeUrl !== '' || draft.tokenUrl !== ''
      ? {
          ...(draft.authorizeUrl !== '' ? { authorizeUrl: draft.authorizeUrl } : {}),
          ...(draft.tokenUrl !== '' ? { tokenUrl: draft.tokenUrl } : {}),
        }
      : undefined;
  return {
    providerName: draft.providerName,
    kindHint: draft.kindHint,
    ...(endpoints !== undefined ? { endpoints } : {}),
    ...(hosts.length > 0 ? { declaredApiHosts: hosts } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    // NO `fields` carry-through (fix-first 2): `llmProposalSchema` omits credential
    // field definitions, so the credentials step's labels always come from per-kind
    // transformer defaults / the registry — never from an LLM-authored proposal.
    ...(session.proposal?.pkce !== undefined ? { pkce: session.proposal.pkce } : {}),
  };
}

export function AuthWizardSheet(): ReactElement | null {
  const session = useStore(wizardStore);
  const step = useStore(wizardStepStore);
  const note = useStore(wizardNoteStore);
  const closeConfirm = useStore(wizardCloseConfirmStore);

  const [row, setRow] = useState<AuthSpecRow | undefined>(undefined);
  const [rowEpoch, setRowEpoch] = useState(0);

  // Row load — refreshed when the step advances (approval writes the row).
  useEffect(() => {
    let cancelled = false;
    setRow(undefined);
    if (session === null) return;
    void getUserDb().then((db) => {
      if (!cancelled) setRow(db.getAuthSpec(session.appId));
    });
    return () => {
      cancelled = true;
    };
  }, [session, step, rowEpoch]);

  if (session === null) return null;

  const onClose = (): void => {
    requestCloseWizard();
  };

  // AC7 (fix-first 1): the re-approval presentation is keyed off the ROW, never
  // just the session mode — a directive/error-CTA session over an already-approved
  // OR imported_unapproved row re-freezes a previously-frozen ceiling (approveWizardSpec
  // routes on the same row condition), so the sheet must SAY re-approval on exactly
  // that condition. Gated on the review step so a fresh connect flow doesn't relabel
  // itself after its own approval advances the step (the row is approved by then).
  const reapproving =
    session.mode === 'reapprove' ||
    (step === 'review' &&
      (row?.status === AUTH_SPEC_STATUS.approved || row?.status === AUTH_SPEC_STATUS.importedUnapproved));

  return (
    <Sheet title={reapproving ? 're-approve connection' : 'connect this app'} open onClose={onClose}>
      {note !== null ? <div className="hint">{note}</div> : null}
      {closeConfirm ? (
        <div className="field" role="alertdialog" aria-label="confirm close">
          <span className="hint">a sign-in is in progress — closing now discards it.</span>
          <div className="field-row">
            <Button onClick={() => wizardCloseConfirmStore.set(false)}>keep connecting</Button>
            <Button variant="danger" onClick={() => forceCloseWizard()}>
              close anyway
            </Button>
          </div>
        </div>
      ) : step === 'review' ? (
        <ReviewStep session={session} row={row} onApproved={() => setRowEpoch((n) => n + 1)} />
      ) : step === 'credentials' ? (
        <CredentialsStep session={session} row={row} />
      ) : (
        <div className="field">
          <span className="hint">connected — this app can now use the network through your approved connection.</span>
          <Button onClick={() => forceCloseWizard()}>done</Button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Review step (B1: nothing below this step exists until approval lands)
// ---------------------------------------------------------------------------

function ReviewStep({
  session,
  row,
  onApproved,
}: {
  session: WizardSession;
  row: AuthSpecRow | undefined;
  onApproved: () => void;
}): ReactElement {
  const specConfirm = session.provenance === 'inference' || session.provenance === 'user_docs';
  const [draft, setDraft] = useState<HintsDraft>(() => draftFromProposal(session));
  const [error, setError] = useState<string | undefined>(undefined);

  // A fresh proposal (e.g. an inference result landing) re-seeds the edit draft.
  useEffect(() => {
    setDraft(draftFromProposal(session));
  }, [session]);

  const proposalDriven = session.proposal !== undefined;
  const built = useMemo(
    () => (proposalDriven ? paramsToAuthSpec(draftToProposal(draft, session)) : undefined),
    [proposalDriven, draft, session],
  );

  // The spec whose derived union the user is approving.
  const pendingSpec: AuthSpec | undefined = proposalDriven
    ? (built?.spec ?? undefined)
    : session.mode === 'reapprove' && row !== undefined
      ? ({ ...row.spec, ...(parseCsv(draft.hostsCsv).length > 0 ? { declaredApiHosts: parseCsv(draft.hostsCsv) } : {}) } as AuthSpec)
      : row?.spec;

  // Re-approval draft seeds from the ROW (there is no proposal to seed from).
  useEffect(() => {
    if (!proposalDriven && row !== undefined && draft.hostsCsv === '' && draft.providerName === '') {
      setDraft({
        providerName: row.spec.provider.name,
        kindHint: row.spec.kind,
        authorizeUrl: '',
        tokenUrl: '',
        hostsCsv: csv(row.spec.declaredApiHosts),
        scopesCsv: '',
      });
    }
  }, [proposalDriven, row, draft.hostsCsv, draft.providerName]);

  const hosts = pendingSpec !== undefined ? deriveAuthAllowedHosts(pendingSpec) : [];
  // AC7 (fix-first 1): the union diff is keyed off the ROW status — the same
  // condition approveWizardSpec routes to reapproveAuthSpec on — so a directive
  // session (mode 'connect') over an approved OR imported_unapproved row (whose
  // allowedHosts carry a previously-frozen union) still renders NEW/removed flags.
  const reapproving =
    session.mode === 'reapprove' ||
    row?.status === AUTH_SPEC_STATUS.approved ||
    row?.status === AUTH_SPEC_STATUS.importedUnapproved;
  const frozen = reapproving ? (row?.allowedHosts ?? []).map(normalizeAuthHost) : undefined;
  const removed = frozen !== undefined ? frozen.filter((h) => !hosts.includes(h)) : [];

  const approve = async (): Promise<void> => {
    setError(undefined);
    const spec =
      proposalDriven || session.mode === 'reapprove'
        ? pendingSpec
        : undefined; // plain settings approval approves the stored row as-is
    const result = await approveWizardSpec(spec);
    if (!result.ok) setError(result.message);
    else onApproved();
  };

  return (
    <div className="field">
      <div className="connection-head">
        <strong>{pendingSpec?.provider.name ?? session.proposal?.providerName ?? row?.spec.provider.name ?? '…'}</strong>{' '}
        <code>{pendingSpec?.kind ?? session.proposal?.kindHint ?? row?.spec.kind ?? ''}</code>
      </div>

      {specConfirm ? (
        <SpecConfirmFields session={session} draft={draft} setDraft={setDraft} reason={built?.spec === null ? built.reason : session.reason} />
      ) : null}

      {session.mode === 'reapprove' ? (
        <div className="field">
          <label htmlFor="wizard-hosts-input">api hosts</label>
          <input
            id="wizard-hosts-input"
            aria-label="api hosts (comma-separated)"
            type="text"
            value={draft.hostsCsv}
            onInput={(e) => setDraft({ ...draft, hostsCsv: (e.target as HTMLInputElement).value })}
          />
        </div>
      ) : null}

      <span className="hint">
        every host below may receive this app’s credential once you approve — this is the complete list, and it
        freezes at approval.
      </span>
      <ul data-testid="wizard-hosts">
        {hosts.map((host) => (
          <li key={host}>
            {host}
            {frozen !== undefined && !frozen.includes(host) ? <strong> — NEW — not previously approved</strong> : null}
          </li>
        ))}
        {removed.map((host) => (
          <li key={`removed-${host}`}>
            {host} <em>— removed by this re-approval</em>
          </li>
        ))}
      </ul>

      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}

      <Button onClick={() => void approve()} disabled={hosts.length === 0}>
        {reapproving ? 're-approve connection' : 'approve connection'}
      </Button>
    </div>
  );
}

/** Deadline on the inference turn (nonBlocking 6): a hung provider call must not wedge busy. */
const INFERENCE_TIMEOUT_MS = 60_000;

function SpecConfirmFields({
  session,
  draft,
  setDraft,
  reason,
}: {
  session: WizardSession;
  draft: HintsDraft;
  setDraft: (d: HintsDraft) => void;
  reason: string | undefined;
}): ReactElement {
  const [docsText, setDocsText] = useState('');
  const [override, setOverride] = useState(false);
  const [tripped, setTripped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inferError, setInferError] = useState<string | undefined>(undefined);
  // AL-05 AC7: the paste-box names the wire the inference turn will ACTUALLY use
  // (keyed subscription = browser-direct byok), resolved from the same decision
  // ladder as the adapter itself — honest copy, no drift.
  const [wireCopy, setWireCopy] = useState('');
  useEffect(() => {
    let alive = true;
    void inferenceWireCopy()
      .then((copy) => {
        if (alive) setWireCopy(copy);
      })
      // On failure the label simply makes no wire claim — never a wrong one.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const abortRef = useRef<AbortController | null>(null);

  const infer = async (): Promise<void> => {
    setBusy(true);
    setInferError(undefined);
    // nonBlocking 6: the already-plumbed AbortSignal finally has a driver — a
    // deadline plus a user cancel affordance — and rejections escaping the run are
    // CAUGHT so busy=true can never wedge and adapter-layer throws are never
    // unhandled rejections.
    const controller = new AbortController();
    abortRef.current = controller;
    const deadline = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
    try {
      const outcome = await runWizardInference({
        providerName: draft.providerName !== '' ? draft.providerName : session.proposal?.providerName ?? '',
        ...(draft.kindHint !== '' ? { kindHint: draft.kindHint } : {}),
        ...(docsText !== '' ? { docsText } : {}),
        signal: controller.signal,
        override,
      });
      setTripped(outcome.blocked === 'tripwire');
    } catch (err) {
      setInferError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(deadline);
      abortRef.current = null;
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof HintsDraft): ReactElement => (
    <div className="field" key={key}>
      <label>{label}</label>
      <input
        aria-label={label}
        type="text"
        value={draft[key]}
        onInput={(e) => setDraft({ ...draft, [key]: (e.target as HTMLInputElement).value })}
      />
    </div>
  );

  return (
    <div className="field">
      <span className="hint">
        this connection was proposed by a model — it is a guess, not an authority. review every field before you
        approve; nothing is saved until you do.
      </span>
      {session.confidence !== undefined && needsUnsureConfidenceNote(session.confidence) ? (
        <span className="hint">the model was unsure about this — check each value against the provider’s docs.</span>
      ) : null}
      {reason !== undefined ? (
        <span className="hint">more is needed before this can be approved: {reason}</span>
      ) : null}

      {field('provider name', 'providerName')}
      {field('auth kind', 'kindHint')}
      {field('authorize url', 'authorizeUrl')}
      {field('token url', 'tokenUrl')}
      {field('api hosts (comma-separated)', 'hostsCsv')}
      {field('scopes (comma-separated)', 'scopesCsv')}

      {session.evidence.length > 0 ? (
        <ul data-testid="wizard-evidence">
          {session.evidence.map((quote, i) => (
            <li key={i}>
              <em>{quote}</em>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="field">
        <label htmlFor="wizard-docs">provider docs (optional{wireCopy !== '' ? ` — ${wireCopy}` : ''})</label>
        <textarea
          id="wizard-docs"
          aria-label="paste provider docs"
          value={docsText}
          onInput={(e) => {
            setDocsText((e.target as HTMLTextAreaElement).value);
            setTripped(false);
          }}
        />
        {tripped ? (
          <div className="error-note" role="alert">
            this looks like it contains a credential — pasted docs are sent to your model provider. remove the
            secret, or confirm below to send anyway.
          </div>
        ) : null}
        {tripped ? (
          <label className="check-label">
            <input
              type="checkbox"
              aria-label="send anyway — this is not a real credential"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
            />
            send anyway — this is not a real credential
          </label>
        ) : null}
        {inferError !== undefined ? (
          <div className="error-note" role="alert">
            {inferError}
          </div>
        ) : null}
        <div className="field-row">
          <Button onClick={() => void infer()} disabled={busy}>
            infer from docs
          </Button>
          {busy ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              cancel
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credentials step (reachable ONLY after approval — B1)
// ---------------------------------------------------------------------------

function CredentialsStep({ session, row }: { session: WizardSession; row: AuthSpecRow | undefined }): ReactElement {
  const flow = useStore(wizardFlowStatusStore);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  // UI busy guard (fix-first 4): the connect button goes dead at CLICK time — not
  // only once flow status reaches awaiting_callback — so a double-click has no
  // second live target during the mint awaits.
  const [connecting, setConnecting] = useState(false);

  if (row === undefined) return <span className="hint">loading…</span>;
  if (row.status !== AUTH_SPEC_STATUS.approved) {
    // Structurally unreachable via the step machine (B1); render fail-closed anyway.
    return <span className="hint">this connection is not approved yet — approve it first.</span>;
  }

  const spec = row.spec;
  const fields: AuthField[] =
    spec.kind === 'oauth2_auth_code' || spec.kind === 'oauth2_client_creds' ? spec.clientCreds : spec.fields;

  const inputFor = (field: AuthField): ReactElement => (
    <div className="field" key={field.key}>
      <label>{field.label}</label>
      <input
        aria-label={field.label}
        type={field.type === 'secret' || field.type === 'password' ? 'password' : 'text'}
        autoComplete="off"
        value={values[field.key] ?? ''}
        onInput={(e) => setValues({ ...values, [field.key]: (e.target as HTMLInputElement).value })}
      />
    </div>
  );

  const registration = spec.registration;

  const saveStatic = async (): Promise<void> => {
    setError(undefined);
    // nonBlocking 9: a blank required field must never show 'connected' — the old
    // path silently skipped empty values and reported success, yielding a
    // NET_AUTH_FAILED round-trip later instead of an answer now.
    const missing = fields.filter((field) => field.required !== false && (values[field.key] ?? '').trim() === '');
    if (missing.length > 0) {
      setError(`enter ${missing.map((field) => field.label).join(', ')} before saving`);
      return;
    }
    try {
      const db = await getUserDb();
      const store = new UserDbCredentialStore(db);
      for (const field of fields) {
        const value = values[field.key];
        if (value !== undefined && value !== '') await store.setCredential(session.appId, field.key, value);
      }
      setValues({}); // write-only: nothing lingers in component state or the DOM (AC10)
      wizardStepStore.set('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveClientCreds = async (): Promise<void> => {
    setError(undefined);
    try {
      await saveWizardClientCreds({ ...values });
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const connectAccount = async (): Promise<void> => {
    if (connecting) return; // busy guard — same-tick double-invoke
    setError(undefined);
    setConnecting(true);
    // Open the popup SYNCHRONOUSLY, inside the click gesture, so a default popup
    // blocker lets it through (D6). `startOAuthFlow` awaits the URL mint before the
    // authorize URL exists — a `window.open` after those awaits would be blocked.
    // By the time this button is reachable the spec is already approved (B1: the
    // credentials step is unreachable while unapproved), so opening here is post-gate.
    const popup = openBlankOAuthPopup();
    try {
      await startOAuthFlow({ ...values }, popup);
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="field">
      {registration !== undefined ? (
        <div className="field">
          <label>get your credentials</label>
          {registration.consoleUrl !== undefined ? (
            <a href={registration.consoleUrl} target="_blank" rel="noreferrer">
              {registration.consoleUrl}
            </a>
          ) : null}
          {registration.instructions !== undefined ? (
            <ol>
              {registration.instructions.map((step, i) => (
                <li key={i} className="hint">
                  {step}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {fields.map(inputFor)}

      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}

      {spec.kind === 'oauth2_auth_code' ? (
        <>
          <Button
            onClick={() => void connectAccount()}
            disabled={connecting || flow.state === 'awaiting_callback' || flow.state === 'exchanging'}
          >
            connect account
          </Button>
          {flow.state === 'awaiting_callback' ? <span className="hint">finish signing in the popup window…</span> : null}
          {flow.state === 'exchanging' ? <span className="hint">completing the connection…</span> : null}
          {flow.state === 'error' ? (
            <div className="error-note" role="alert">
              {flow.message}
              {flow.authorizeUrl !== undefined ? (
                <>
                  {' '}
                  <a href={flow.authorizeUrl} target="_blank" rel="noreferrer">
                    or open the sign-in page directly
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : spec.kind === 'oauth2_client_creds' ? (
        <Button onClick={() => void saveClientCreds()}>save &amp; connect</Button>
      ) : (
        <Button onClick={() => void saveStatic()}>save credentials</Button>
      )}
    </div>
  );
}
