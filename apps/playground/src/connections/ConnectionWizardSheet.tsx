/**
 * ConnectionWizardSheet — the v4 "grandma wizard" (TASK-20260810-p3-wizard, plan §6).
 *
 * ONE app-level mount (App.tsx), like its v3 predecessor: the three entry points — the
 * chat directive card, the Settings slot row, the run-header error CTA — live in
 * different views, and a per-view mount would strand the minutes-lived singleton the
 * moment the user navigated.
 *
 * THE DESIGN RULE THIS COMPONENT IS BUILT AROUND: one decision per screen, and no screen
 * without a decision. A person connecting Coinbase is being asked to do four unfamiliar
 * things — understand what is being requested, go to a console and mint a key, paste
 * three secrets, and (for OAuth) sign in. Putting those on one screen is what produced
 * the defect this phase exists to fix: the user could not tell which of three pasted
 * values went where. So each is its own screen, each screen states its own decision, and
 * every forward button is VERB-NAMED ("I've got my credentials") rather than "next" —
 * a verb tells you what you are asserting; "next" tells you only that there is more.
 *
 * WHAT IS RENDERED IS THE ROW, ALWAYS. Every screen reads `snug_connections` live rather
 * than a session snapshot. The review screen in particular renders EVERY seat the
 * requirement carries, verbatim — including the header template's mustaches — because
 * the v4 bargain (ADR-0017) is that the richer authoring channel is paid for by the user
 * seeing exactly what it expresses. A "prettified" template would hide what gets signed.
 *
 * C1 — credential VALUES live in this component's local `values` state and nowhere else.
 * They are write-only: handed to `saveConnectionCredentials` (which writes straight to
 * `snug_secrets`), then cleared. They are never rendered into a review, never put on a
 * row, never sent anywhere an LLM, iframe, or publisher could read.
 *
 * AC5 — `registration.instructions` are LLM-authored prose rendered immediately before
 * the user pastes a secret, so they are printed as TEXT CHILDREN of `<li>`, never parsed
 * as markup and never auto-linkified. React escapes text children by construction; the
 * point of saying so here is that any future "make the links clickable" improvement would
 * be turning a phishing primitive on inside a surface the user trusts because we drew it.
 * There is no `dangerouslySetInnerHTML` in this file and there must never be one.
 *
 * Q5 — NO inference affordance exists here, on any screen, in any session. Removed, not
 * hidden: there is no paste-docs textarea and no import of an inferrer.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { CONNECTION_STATUS, type ConnectionField, type ConnectionRequirement } from '@snugprotocol/protocol';
import type { ConnectionRow } from '@snugprotocol/db';
import { lookupWellKnownProvider } from '@snugprotocol/auth';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import {
  advanceFromRegister,
  advanceFromReview,
  cancelConnectionOAuthFlow,
  closeConnectionWizard,
  forceCloseWizard,
  connectionFlowStatusStore,
  connectionWizardRevisionStore,
  connectionWizardStepStore,
  connectionWizardStore,
  desktopOAuthPostureFor,
  desktopOAuthRefusalFor,
  findRevokedBefore,
  migrateConnectionRegistryDrift,
  needsReapproval,
  openBlankConnectionOAuthPopup,
  reapproveFromDiff,
  saveConnectionCredentials,
  startConnectionOAuthFlow,
  testConnection,
  type ConnectionTestOutcome,
  type ConnectionWizardSession,
  type DesktopOAuthAlternative,
  type DesktopOAuthRefusal,
  type RevokedBefore,
} from '../state/connectionWizard.js';
import { chooseAuthOption } from '../state/authKindChoice.js';
import { getPlatform } from '../platform/platform.js';
import { Button } from '../ui/Button.js';
import { Sheet } from '../ui/Sheet.js';

/**
 * ADR-0014 clause 5, VERBATIM (fold F-M1). The wording is load-bearing and this constant
 * is why: it is a HUB-CUSTODY claim, and that distinction is the whole reason the ADR
 * writes the sentence out rather than paraphrasing it.
 *
 * The tempting shorter form is any absolute of the shape "your keys never leave the copy
 * of your file on this machine". It is simply FALSE the moment the user connects a
 * personal sync origin, because their file — `snug_secrets` included — then legitimately
 * travels to the storage they chose. A false custody promise is worse than no promise: it
 * is the one claim a user cannot verify for themselves and will most reasonably rely on.
 * Neither this constant nor any copy in this file may be strengthened into that absolute.
 */
const CUSTODY_CLAUSE_5 =
  'your keys never reach our servers — your file, including keys, goes only to storage you choose';

/** Below this, the review adds the "the model was unsure" band. Copy grading only. */
const CONFIDENCE_NOTE_THRESHOLD = 0.7;

/**
 * PLAIN-WORDS kind copy (AC2). The raw discriminator (`api_key`, `oauth2_auth_code`) is
 * an implementation detail that tells a non-technical reader nothing about what is about
 * to happen to their account, so the review states the CONSEQUENCE instead and the enum
 * never reaches the screen.
 */
function plainKind(requirement: ConnectionRequirement): string {
  const provider = requirement.provider.name;
  switch (requirement.kind) {
    case 'oauth2_auth_code':
      return `this app signs you in to ${provider} and uses the access it is granted — you approve the access at ${provider}, and can withdraw it there.`;
    case 'oauth2_client_creds':
      return `this app uses secret values from your ${provider} account to get its own access token — nobody signs in.`;
    case 'basic_auth':
      return `this app uses a username and secret value from your ${provider} account to identify itself on every request.`;
    case 'bearer_token':
      return `this app uses a secret value from your ${provider} account to identify itself on every request.`;
    case 'api_key':
      return `this app uses secrets from your ${provider} account to identify itself on every request.`;
    case 'none':
      return `this app talks to ${provider} without any credentials — nothing of yours is used.`;
  }
}

/** Provenance copy, split so the model-guess framing NEVER rides on a pinned channel. */
function provenanceCopy(row: ConnectionRow): string {
  switch (row.provenance) {
    case 'registry':
      return 'these details are pinned by Snug for this provider — not proposed by a model.';
    case 'starter':
      return 'this connection ships with this starter, as its author wrote it.';
    case 'user':
      return 'you entered these details yourself.';
    case 'user_docs':
      return 'a model read the provider documentation you pasted and proposed this — a guess, not an authority. Check it against what you know.';
    case 'inference':
      return 'a model proposed this from what it knows about this provider — a guess, not an authority. Check it against what you know.';
  }
}

/**
 * Q3 — is the console URL CLICKABLE? Only for `registry`, where the URL is one WE pinned.
 *
 * Everywhere else the URL came from a model or an app author, and rendering an
 * attacker-influenceable destination as a one-tap anchor inside the platform's own
 * credential wizard is the phishing hand-off in its purest form. Copy-only is the
 * mitigation — and the FULL url stays visible, because truncating the host is what turns
 * a copy-only affordance back into a phishing aid: a user who cannot read where they are
 * being sent cannot refuse to go.
 */
function consoleUrlIsClickable(row: ConnectionRow): boolean {
  return row.provenance === 'registry';
}

/** Plain-text step list. Text children only — see the AC5 note in the module doc. */
function StepList({ steps, testId }: { steps: readonly string[]; testId: string }): ReactElement | null {
  if (steps.length === 0) return null;
  return (
    <ol data-testid={testId}>
      {steps.map((step, index) => (
        <li key={index} className="hint">
          {step}
        </li>
      ))}
    </ol>
  );
}

function HostList({ hosts, testId }: { hosts: readonly string[]; testId: string }): ReactElement {
  return (
    <ul data-testid={testId}>
      {hosts.map((host) => (
        <li key={host}>
          <code>{host}</code>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function ReviewScreen({ row, onApprove }: { row: ConnectionRow; onApprove: () => void }): ReactElement {
  const requirement = row.requirement;
  const fields = requirement.fields ?? [];
  const registration = requirement.registration;
  const headerTemplate = requirement.request?.headerTemplate;

  return (
    <div className="field">
      <h3>{requirement.provider.name}</h3>
      <p className="hint" data-testid="review-kind-plain">
        {plainKind(requirement)}
      </p>
      <p className="hint" data-testid="review-provenance">
        {provenanceCopy(row)}
      </p>
      {row.confidence !== undefined && row.confidence < CONFIDENCE_NOTE_THRESHOLD ? (
        <p className="hint" data-testid="review-low-confidence">
          the model was unsure about this one — read it especially carefully, and check it against the provider’s own
          documentation before you approve.
        </p>
      ) : null}

      {fields.length > 0 ? (
        <div className="field" data-testid="review-fields">
          <label>what you will be asked for</label>
          <ul>
            {fields.map((field) => (
              <li key={field.key}>
                <strong>{field.label}</strong>
                {field.description !== undefined ? <span className="hint"> — {field.description}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {registration !== undefined ? (
        <div className="field">
          <label>how you get them</label>
          <StepList steps={registration.instructions ?? []} testId="review-registration-steps" />
        </div>
      ) : null}

      {headerTemplate !== undefined ? (
        <div className="field">
          <label>what gets sent with every request</label>
          {/*
            VERBATIM, mustaches and all. The template is what will be computed HOST-side
            and attached to real outbound requests, so this code box is the user's only
            chance to see that (say) their API SECRET is used to sign a timestamp rather
            than being sent as-is. Rendering a friendly summary here would defeat the
            entire reason the v4 channel is allowed to carry a template.
          */}
          <code data-testid="review-header-template" className="redirect-uri">
            {Object.entries(headerTemplate)
              .map(([header, value]) => `${header}: ${value}`)
              .join('\n')}
          </code>
        </div>
      ) : null}

      <div className="field">
        <label>where this app may send them</label>
        <HostList hosts={row.allowedHosts} testId="review-hosts" />
        <span className="hint">
          this list freezes at approval — the app can never reach anywhere else, and widening it needs your approval
          again.
        </span>
      </div>

      <Button variant="primary" onClick={onApprove}>
        approve this connection
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function RegisterScreen({ row, onForward }: { row: ConnectionRow; onForward: () => void }): ReactElement {
  const registration = row.requirement.registration;
  const consoleUrl = registration?.consoleUrl;
  const clickable = consoleUrlIsClickable(row);
  const [copied, setCopied] = useState(false);

  /**
   * The callback URL the user must register with their provider (harvested from the
   * parked AL-09 branch, fold F-M3). Owner report 2026-08-09: connecting Spotify failed
   * at the provider with "redirect_uri: Not matching configuration". The hub already
   * computes this exact string for both the authorize call and the token exchange, so
   * asking the user to ASSEMBLE it from prose is asking them to hand-build a value that
   * must match byte-for-byte at the provider — the most common way a BYO registration
   * fails.
   *
   * ONE SOURCE with the service (TASK-20260812, Decision 3): on web it is the same
   * `window.location.origin` literal the service derives, synchronously; on desktop it
   * is the platform's `redirectUriFor` — the recorded-string provider the flow itself
   * uses — resolved async into state. A second derivation on either platform is a
   * second chance to differ from what is actually sent.
   *
   * It lives on the REGISTER screen because that is the provider-side step: this URL has
   * to be registered before the provider will issue the client id pasted on the NEXT
   * screen. OAuth kinds ONLY — a redirect URI means nothing for api_key/bearer/basic, and
   * showing one there would imply a registration step that does not exist.
   */
  const isOAuth = row.requirement.kind === 'oauth2_auth_code';
  const platformOauth = getPlatform().oauth;
  const providerName = row.requirement.provider.name;
  const posture = isOAuth ? desktopOAuthPostureFor(row.requirement) : undefined;
  // `pkce === false` excluded (finding C): the refusal screen renders instead of this one,
  // and asking the platform for a URI would bind a listener for a flow that must not run.
  const loopbackPosture =
    (posture === 'loopback' || posture === 'loopback-fixed-port') && row.requirement.pkce !== false ? posture : undefined;
  const [platformRedirectUri, setPlatformRedirectUri] = useState<string | undefined>(undefined);
  const [redirectCopied, setRedirectCopied] = useState(false);

  useEffect(() => {
    // Unsupported postures never reach this screen (the refusal gate renders instead),
    // so the guard here is only about not calling the platform for non-loopback rows.
    if (platformOauth === undefined || loopbackPosture === undefined) return;
    let alive = true;
    void platformOauth.redirectUriFor({ provider: providerName, posture: loopbackPosture }).then((uri) => {
      if (alive) setPlatformRedirectUri(uri);
    });
    return () => {
      alive = false;
    };
  }, [platformOauth, loopbackPosture, providerName]);

  const redirectUri = !isOAuth
    ? undefined
    : platformOauth === undefined
      ? `${window.location.origin}/oauth/callback`
      : platformRedirectUri;

  return (
    <div className="field">
      <label>get your {row.requirement.provider.name} credentials</label>
      {consoleUrl !== undefined ? (
        <div className="field" data-testid="register-console">
          {clickable ? (
            <span data-testid="register-console-link">
              <a href={consoleUrl} target="_blank" rel="noreferrer">
                {consoleUrl}
              </a>
            </span>
          ) : (
            <>
              {/*
                Copy-only (Q3). The full address is shown so the user can read where they
                are being sent and decide for themselves — see `consoleUrlIsClickable`.
              */}
              <code className="redirect-uri" data-testid="register-console-url">
                {consoleUrl}
              </code>
              <span className="hint">
                open this address yourself — we don’t link it, because a model proposed it rather than us pinning it.
              </span>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText?.(consoleUrl);
                  setCopied(true);
                }}
              >
                copy this address
              </Button>
              {copied ? <span className="hint">copied — paste it into your browser’s address bar.</span> : null}
            </>
          )}
        </div>
      ) : null}

      {redirectUri !== undefined ? (
        <div className="field">
          <label htmlFor="register-redirect-uri">redirect URI to register</label>
          <code id="register-redirect-uri" className="redirect-uri" data-testid="register-redirect-uri">
            {redirectUri}
          </code>
          <span className="hint">
            add this to your provider app&apos;s allowed redirect URIs, exactly as shown — providers match it
            character for character, and a mismatch is refused before sign-in.
          </span>
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText?.(redirectUri);
              setRedirectCopied(true);
            }}
          >
            copy this address
          </Button>
          {redirectCopied ? <span className="hint">copied — paste it into the provider&apos;s form.</span> : null}
          {platformOauth === undefined ? (
            /*
              Answers a question a careful user WILL have (owner, 2026-08-09): every app on
              this hub shares one callback address, so does each app need its own
              registration — and can apps capture each other's sign-ins? No on both counts.
              Which app a callback belongs to travels in the HMAC-signed `state`, verified
              before anything is read and bound to both appId and flowId, so the URL never
              carries identity.
            */
            <span className="hint">
              every app on this hub uses this same address, so you only need to register once per provider —
              sign-ins are matched to the right app by a signed token, not by the address.
            </span>
          ) : loopbackPosture === 'loopback-fixed-port' ? (
            /*
              The fixed-port walkthrough (Decision 2): ONE stable copy-paste address that
              survives restarts, because this provider matches the registered URI exactly.
            */
            <span className="hint">
              the desktop app always signs in on this exact address, so you only need to register it once per
              provider — it stays the same every time you use the app. Paste this exactly — one character off and
              the sign-in can&apos;t come home.
            </span>
          ) : (
            <span className="hint">
              this address points at the desktop app on your own computer — it only answers during a sign-in you
              started.
            </span>
          )}
        </div>
      ) : null}

      <StepList steps={registration?.instructions ?? []} testId="register-steps" />

      {/*
        VERB-NAMED, and ASCII-apostrophed on purpose: this label is an assertion the user
        makes ("I have them in hand"), not a direction of travel, and a typographic ’ here
        would break every straight-quote search — including the tests that pin the label.
      */}
      <Button variant="primary" onClick={onForward}>
        I&apos;ve got my credentials
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * One masked input per DECLARED field. `secret`/`password` types render as
 * `type="password"` with a reveal toggle — masking protects against a shoulder, and the
 * reveal protects against the far more common failure of a mistyped key the user cannot
 * see to correct.
 *
 * Values are TRIMMED on the way in. Copying an API key out of a console reliably brings a
 * trailing newline or space, and a credential that fails only because of invisible
 * whitespace is the single most demoralizing way for this flow to end.
 */
function CredentialInput({
  field,
  value,
  onChange,
}: {
  field: ConnectionField;
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const masked = field.type === 'secret' || field.type === 'password';
  return (
    <div className="field">
      <label htmlFor={`connection-field-${field.key}`}>{field.label}</label>
      {field.description !== undefined ? <span className="hint">{field.description}</span> : null}
      <input
        id={`connection-field-${field.key}`}
        data-field-key={field.key}
        type={masked && !revealed ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
        value={value}
        onInput={(event) => onChange((event.target as HTMLInputElement).value.trim())}
      />
      {masked ? (
        <Button onClick={() => setRevealed(!revealed)}>{revealed ? `hide my ${field.label}` : `show my ${field.label}`}</Button>
      ) : null}
    </div>
  );
}

function CredentialsScreen({
  row,
  onSaved,
}: {
  row: ConnectionRow;
  onSaved: () => void;
}): ReactElement {
  const requirement = row.requirement;
  const fields = requirement.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const isOAuth = requirement.kind === 'oauth2_auth_code';

  /**
   * The BYOK-CORS disclosure (2026-08-12 advisory; AC6's `browserCallable` half),
   * BEFORE credentials are pasted. Tri-state on purpose: only a REVIEWED `false` in the
   * registry earns the line — an absent seat is unknown and makes no claim either way,
   * because "works in a browser" is exactly the promise an absent fact cannot back. On
   * desktop the wall does not exist (native fetch), so nothing is claimed there either.
   */
  const disclosedBrowserWall =
    getPlatform().kind === 'web' && lookupWellKnownProvider(requirement.provider.name)?.browserCallable === false;

  /**
   * THE POPUP IS OPENED SYNCHRONOUSLY, INSIDE THE CLICK, BEFORE ANY AWAIT.
   *
   * This is the popup-blocker escape and the ordering is the entire fix: a blank
   * `about:blank` window created while the user's gesture is still live rides that gesture
   * through a default blocker, and is navigated to the authorize URL once the mint
   * resolves. `window.open` called AFTER `saveConnectionCredentials` and `generateAuthUrl`
   * have awaited is no longer gesture-associated, and every mainstream blocker refuses it.
   * A bail closes it, so a blank window is never orphaned on the user's screen.
   */
  const save = (): void => {
    setError(undefined);
    const missing = fields.filter((field) => field.required !== false && (values[field.key] ?? '').trim() === '');
    if (missing.length > 0) {
      // A blank required field must never report success: the old v3 path skipped empty
      // values silently and showed 'connected', turning an answerable problem now into a
      // NET_AUTH_FAILED round trip later.
      setError(`enter ${missing.map((field) => field.label).join(', ')} before saving`);
      return;
    }
    // Amendment 7: the blank pre-open is a POPUP-BLOCKER escape, and only the web popup
    // path needs one — the desktop platform's OS opener is not gesture-gated, and a
    // blank webview window would linger over a sign-in happening in the system browser.
    const preOpened = isOAuth && getPlatform().oauth === undefined ? openBlankConnectionOAuthPopup() : null;
    const oauthValues = isOAuth ? { ...values } : {};
    void (async () => {
      const result = await saveConnectionCredentials(values);
      setValues({}); // write-only: nothing lingers in component state or the DOM
      if (!result.ok) {
        preOpened?.close?.();
        setError(result.message);
        return;
      }
      if (isOAuth) {
        // The credentials save advanced the machine to `connect`; start the flow straight
        // away rather than making the user click a second button for the same intent they
        // already expressed with "connect my <provider> account".
        try {
          await startConnectionOAuthFlow(oauthValues, preOpened);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      onSaved();
    })();
  };

  return (
    <div className="field">
      <label>paste your {requirement.provider.name} credentials</label>
      <p className="hint" data-testid="credentials-custody">
        {CUSTODY_CLAUSE_5}.
      </p>

      {disclosedBrowserWall ? (
        <p className="hint" data-testid="browser-callable-disclosure">
          one thing to know first: {requirement.provider.name} does not accept requests sent from a web browser, so
          this connection may fail here even with the right credentials. It works in the Snug desktop app.
        </p>
      ) : null}

      {fields.map((field) => (
        <CredentialInput
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          onChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
        />
      ))}

      {error !== undefined ? (
        <div className="error-note" role="alert">
          {error}
        </div>
      ) : null}

      <Button variant="primary" onClick={save}>
        {isOAuth ? `connect my ${requirement.provider.name} account` : 'save my credentials'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect (OAuth only) and done
// ---------------------------------------------------------------------------

/**
 * The OAuth connect screen. THIS SCREEN MUST ALWAYS OFFER A WAY FORWARD.
 *
 * It briefly did not, and that is the defect this rebuild repairs: it rendered two
 * paragraphs, one of them promising "a sign-in window will open", and no button — a
 * terminal dead end where every OAuth user's journey ended. Copy that describes behavior
 * the code does not perform is worse than no copy, because the user waits for it.
 *
 * THE STATUS GRAMMAR is OProject's, ported with it: every state a flow can be in gets a
 * sentence that NAMES THE PROVIDER and says what the user should do next. "waiting for
 * Spotify sign-in…" tells a person which window to look for; "something went wrong" tells
 * them nothing they can act on. The blocked-popup state is the one that matters most — it
 * carries the authorize URL so the user has a route through even with a blocker on.
 */
function ConnectScreen({ row, onStart }: { row: ConnectionRow; onStart: () => Promise<void> }): ReactElement {
  const status = useStore(connectionFlowStatusStore);
  const provider = row.requirement.provider.name;
  const [starting, setStarting] = useState(false);
  const handleStart = (): void => {
    if (starting) return;
    setStarting(true);
    void onStart().finally(() => setStarting(false));
  };
  // P3 item 4c: on desktop the sign-in lives in the SYSTEM browser, not a popup this
  // window owns — the wait copy must point the user THERE, and the cancel affordance
  // is the only in-app control on the screen, so it reads as the primary action.
  const desktopOpener = getPlatform().oauth !== undefined;

  return (
    <div className="field">
      <label>finish signing in to {provider}</label>
      <p className="hint" data-testid="connect-custody">
        {CUSTODY_CLAUSE_5}.
      </p>

      {status.state === 'awaiting_callback' ? (
        <>
          <span className="hint" data-testid="connect-status">
            {desktopOpener
              ? // The provider is named by the screen's own label just above; this line's
                // job is pointing at the right WINDOW.
                "we opened your browser — finish signing in there. we're listening."
              : `waiting for ${provider} sign-in — approve the access in the window that opened, then come back here.`}
          </span>
          {/*
            The explicit abandonment affordance (P0 amendment 7). On desktop the sign-in
            lives in the SYSTEM browser — there is no popup handle whose closing we could
            observe — so without this button the only exits from the wait are delivery
            and the flow TTL. Offered on web too: one abandonment story, both platforms.
          */}
          <Button
            variant={desktopOpener ? 'primary' : 'default'}
            onClick={() => cancelConnectionOAuthFlow()}
            data-testid="connect-cancel"
          >
            cancel this sign-in
          </Button>
        </>
      ) : status.state === 'exchanging' ? (
        <span className="hint" data-testid="connect-status">
          finishing your {provider} sign-in…
        </span>
      ) : status.state === 'connected' ? (
        <span className="hint" data-testid="connect-status">
          connected to {provider}.
        </span>
      ) : status.state === 'error' ? (
        <div className="error-note" role="alert" data-testid="connect-error">
          {status.message}
          {status.authorizeUrl !== undefined ? (
            <>
              {/*
                The blocked-popup fallback, and the ONE place in this file an anchor to a
                model-influenceable URL would be unacceptable — which is why it is not one.
                This href is the authorize URL the SERVICE minted from the APPROVED row's
                endpoints, not anything a requirement proposed at click time, and the click
                is the user's own gesture so no blocker refuses it.
              */}
              <br />
              <a href={status.authorizeUrl} target="_blank" rel="noreferrer" data-testid="connect-fallback-link">
                open the {provider} sign-in page in a new tab
              </a>
            </>
          ) : null}
        </div>
      ) : (
        <span className="hint" data-testid="connect-status">
          a sign-in window will open — approve the access there, then come back here.
        </span>
      )}

      {status.state !== 'awaiting_callback' && status.state !== 'exchanging' && status.state !== 'connected' ? (
        /*
          LATCHED while a start is in flight (whole-surface review finding B, UI half).
          The status stays `idle` across the db open, the mint and the OS opener, so this
          button used to stay clickable through the whole window — and a second click
          produced two overlapping starts that killed each other's channel and listener.
          The store refuses the duplicate too (its own latch); this is the half that makes
          the refusal visible rather than a click that silently does nothing.
        */
        <Button variant="primary" onClick={handleStart} disabled={starting} data-testid="connect-start">
          {starting
            ? `opening ${provider} sign-in…`
            : status.state === 'error'
              ? `try signing in to ${provider} again`
              : `sign in to ${provider}`}
        </Button>
      ) : null}
    </div>
  );
}

function DoneScreen({ row, onClose }: { row: ConnectionRow; onClose: () => void }): ReactElement {
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<ConnectionTestOutcome | undefined>(undefined);

  /**
   * Q7 — the probe, offered ONLY when the requirement declares one.
   *
   * WHY IT BELONGS HERE. This is the only moment where a person has just pasted three
   * secrets and has no idea whether they work. Without it, the first feedback is a
   * NET_AUTH_FAILED inside their running app — far from the screen where the repair is a
   * two-second re-paste, and phrased in a vocabulary they never chose.
   *
   * WHY IT IS CONDITIONAL, and why nothing is invented for the connections that lack one:
   * synthesizing a plausible path ('/', '/me', …) would be the host guessing at a
   * provider's API surface and sending live credentials at the guess. A connection with no
   * declared probe is not probeable, and saying nothing is the honest form of that.
   *
   * OAUTH KINDS ARE SKIPPED (Q7 as decided): a minted token already proves the round trip
   * completed, so a probe would re-assert what the connect step just established.
   */
  const probeable = row.requirement.testRequest !== undefined && row.requirement.kind !== 'oauth2_auth_code';

  const runTest = (): void => {
    setTesting(true);
    setOutcome(undefined);
    void testConnection()
      .then(setOutcome)
      .finally(() => setTesting(false));
  };

  return (
    <div className="field">
      <label>{row.requirement.provider.name} is connected</label>
      <span className="hint">
        this app can now reach {row.allowedHosts.join(', ')} on your behalf. You can disconnect it any time from
        Settings → Connections.
      </span>

      {probeable ? (
        <div className="field">
          <Button onClick={runTest} disabled={testing}>
            {testing ? 'testing…' : 'test this connection'}
          </Button>
          {outcome !== undefined ? (
            /*
              The result, rendered from the executor's ALREADY-SCRUBBED outcome. Only the
              status code and the refusal message are shown — never a response body and
              never a header, because a provider's error body is the most likely place for
              a credential echo, and this screen is the worst place to print one.
            */
            <span
              className="hint"
              role="status"
              data-testid="connection-test-result"
              data-ok={outcome.ok ? 'true' : 'false'}
            >
              {outcome.ok
                ? `it works — ${row.requirement.provider.name} answered (${outcome.status}).`
                : `that didn't work: ${outcome.message}`}
            </span>
          ) : null}
        </div>
      ) : null}

      {/*
        Exactly "done": this button ENDS the flow rather than advancing it, so it is the
        one place a verb-name would mislead — there is nothing left to assert.
      */}
      <Button variant="primary" onClick={onClose}>
        done
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The desktop posture refusal (TASK-20260812, AC6 / Decision 5)
// ---------------------------------------------------------------------------

/**
 * The honest-refusal screen: this provider's sign-in cannot be received by the running
 * shell build, and the user learns that BEFORE pasting anything — never mid-flow. It
 * renders in place of every credential-half screen (register/credentials/connect):
 * walking someone through a provider dashboard registration for a flow that will then
 * refuse is the same broken promise, one screen earlier.
 *
 * Plain language, provider-named, and it STEERS (P3 item 4b): when the registry carries
 * another way in (GitHub → personal access token), a PRIMARY button routes straight to
 * that option's flow — the rebind goes through `chooseAuthOption`, the ONE `user`
 * channel writer, so the full gate chain and the review still run. No credential input
 * exists on this screen and no forward affordance leads to one.
 */
function DesktopOAuthRefusalScreen({
  refusal,
  appId,
  slot,
  onClose,
}: {
  refusal: DesktopOAuthRefusal;
  appId: string;
  slot: string;
  onClose: () => void;
}): ReactElement {
  const [routeError, setRouteError] = useState<string | undefined>(undefined);

  const routeTo = (alternative: DesktopOAuthAlternative): void => {
    setRouteError(undefined);
    void chooseAuthOption({ appId, slot, requirement: alternative.requirement }).then((outcome) => {
      // A refused rebind must say so (F4) — never silently keep the dead end.
      if (!outcome.ok) setRouteError(outcome.message);
    });
  };

  return (
    <div className="field" data-testid="desktop-oauth-refusal">
      <label>
        {refusal.reason === 'pkce-required'
          ? `this ${refusal.providerName} sign-in skips a security step`
          : `${refusal.providerName} sign-in isn't available in the desktop app yet`}
      </label>
      <span className="hint" data-testid="desktop-oauth-refusal-reason">
        {refusal.reason === 'pkce-required'
          ? // Plain language, no acronym-only sentence: the user is being told that a
            // protection the desktop sign-in depends on was asked to be turned off, and
            // that we would rather stop than sign them in without it. Never coerced
            // silently — that would change what they approved.
            `this connection asks to skip a security step (called PKCE) that the desktop sign-in needs to stay safe, so we won't set it up here. without it, another program on this computer could step into the middle of the sign-in.`
          : refusal.posture === 'unvouched'
            ? `we haven't verified a safe way for the desktop app to receive ${refusal.providerName}'s sign-in, so this connection can't be set up here yet.`
            : `${refusal.providerName} hands its sign-in back in a way the desktop app doesn't support yet, so this connection can't be set up here.`}
      </span>
      {refusal.alternatives.length > 0 ? (
        <>
          <span className="hint" data-testid="desktop-oauth-refusal-alternatives">
            good news: {refusal.providerName} has another way in that works on this computer.
          </span>
          {refusal.alternatives.map((alternative) => (
            <Button key={alternative.label} variant="primary" onClick={() => routeTo(alternative)}>
              connect with {alternative.label}
            </Button>
          ))}
        </>
      ) : null}
      {routeError !== undefined ? (
        <div className="error-note" role="alert">
          {routeError}
        </div>
      ) : null}
      <Button variant={refusal.alternatives.length > 0 ? 'default' : 'primary'} onClick={onClose}>
        take me back
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The re-approval diff (AC8)
// ---------------------------------------------------------------------------

interface DiffLine {
  label: string;
  state: 'added' | 'removed' | 'unchanged';
}

/**
 * Field-by-field and host-by-host old→pending.
 *
 * A diff that flags EVERYTHING teaches the user to approve without reading, which is
 * precisely the failure this screen exists to stop — so unchanged rows are rendered and
 * marked unchanged rather than omitted. Seeing "api.coinbase.com — unchanged" beside
 * "api.exchange.coinbase.com — added" is what makes the addition legible as an addition.
 */
function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const lines: DiffLine[] = [];
  for (const item of after) lines.push({ label: item, state: beforeSet.has(item) ? 'unchanged' : 'added' });
  for (const item of before) if (!afterSet.has(item)) lines.push({ label: item, state: 'removed' });
  return lines;
}

function ReapprovalDiffScreen({
  row,
  onReapprove,
  onDismiss,
}: {
  row: ConnectionRow;
  onReapprove: () => void;
  onDismiss: () => void;
}): ReactElement {
  const pending = row.pendingRequirement!;
  const fieldLines = diffLines(
    (row.requirement.fields ?? []).map((field) => field.label),
    (pending.fields ?? []).map((field) => field.label),
  );
  // The OLD side is the FROZEN ceiling (`allowedHosts`), not the old requirement's
  // declared list: what the user is being asked to widen is the grant that is actually
  // serving, and those are the same only until an admission substitution says otherwise.
  // `?? []` since ADR-0023: a LAN-class pending requirement whose address has not
  // been collected declares no hosts, and the diff then honestly shows the frozen
  // ceiling's hosts as REMOVED — which is what such a pending edit would do.
  const hostLines = diffLines(row.allowedHosts, pending.declaredApiHosts ?? []);

  const render = (line: DiffLine): ReactElement => (
    <li key={`${line.state}:${line.label}`} data-diff={line.state}>
      {line.label}
      {line.state === 'added' ? <span className="hint"> — newly requested</span> : null}
      {line.state === 'removed' ? <span className="hint"> — no longer requested</span> : null}
    </li>
  );

  return (
    <div className="field">
      <label>{row.requirement.provider.name} wants to change this connection</label>
      <p className="hint">
        the connection you approved is still working exactly as it was. Nothing below takes effect until you approve it.
      </p>
      <div data-testid="reapproval-diff">
        <div className="field">
          <label>what you’ll be asked for</label>
          <ul>{fieldLines.map(render)}</ul>
        </div>
        <div className="field">
          <label>where this app may send them</label>
          <ul>{hostLines.map(render)}</ul>
        </div>
      </div>
      <Button variant="primary" onClick={onReapprove}>
        approve these changes
      </Button>
      <Button onClick={onDismiss}>keep the current connection</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing-row fallback (AC6)
// ---------------------------------------------------------------------------

/**
 * No row for this slot — a legacy or misbuilt app reached the connected surface without
 * ever declaring what it needs.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO is guess. The tempting move is to offer
 * "let a model work out what this provider needs" right here, and Q5 removes it: the user
 * arrived because they wanted to USE their app, and asking them to adjudicate a model's
 * guess about an auth scheme at that moment is the worst possible time to ask. The repair
 * belongs where authoring belongs — the app's edit chat, where the model is already the
 * author and the user is already reviewing its work.
 */
function MissingRowScreen({ session, onClose }: { session: ConnectionWizardSession; onClose: () => void }): ReactElement {
  return (
    <div className="field">
      <label>this app hasn’t said what it needs to connect</label>
      <span className="hint">
        there’s no connection set up for “{session.slot}”, so there is nothing here to approve yet. Ask for it in the
        app’s edit chat — describe the service you want it to reach, and it will be set up there for you to review.
      </span>
      <Button variant="primary" onClick={onClose}>
        take me back
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function ConnectionWizardSheet(): ReactElement | null {
  const session = useStore(connectionWizardStore);
  const step = useStore(connectionWizardStepStore);
  const revision = useStore(connectionWizardRevisionStore);
  const [row, setRow] = useState<ConnectionRow | undefined>(undefined);
  const [revoked, setRevoked] = useState<RevokedBefore | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  /** Set only when the store REFUSES a close because a sign-in is mid-flight (M9). */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const appId = session?.appId;
  const slot = session?.slot;

  useEffect(() => {
    if (appId === undefined || slot === undefined) {
      setRow(undefined);
      setRevoked(undefined);
      setLoaded(false);
      return;
    }
    let alive = true;
    void getUserDb().then(async (db) => {
      // Amendment 3 (TASK-20260812-desktop-auth-awareness; ADR-0022 consequences):
      // registry drift is reconciled BEFORE the row is first rendered, so every open
      // route — Settings, the chat card, the net-error CTA, the AC5 repair banner —
      // reviews the row the registry would mint TODAY, not the one an older registry
      // minted once. Idempotent (a migrated row reports no drift), and a failure falls
      // back to rendering the row exactly as stored — the pre-migration behavior,
      // never a blocked wizard.
      await migrateConnectionRegistryDrift(appId, slot).catch(() => undefined);
      if (!alive) return;
      const found = db.getConnection(appId, slot);
      setRow(found);
      setRevoked(found === undefined ? undefined : findRevokedBefore(db, appId, found.requirement, slot));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // `revision` is in the deps precisely so a write performed by the store (approve,
    // re-approve, credential save) re-reads the row rather than rendering a stale one.
  }, [appId, slot, revision]);

  /**
   * THE DIFF IS DERIVED FROM THE ROW, NEVER FROM THE SESSION MODE (fold).
   *
   * It used to also require `session.mode === 'reapprove'`, and that conjunct was a lie
   * waiting for a call site to tell it. Two shipped entry points — the run-view connect CTA
   * and the chat directive card — call `openConnectionWizard` with no mode at all, which
   * defaults to 'connect'. A user arriving from either one was shown the plain "approve
   * this connection" review while a staged widening (a NEW HOST included) sat unmentioned
   * on the row: the review screen listed only the frozen hosts, and the pending one never
   * reached the screen. Nothing was silently GRANTED — `advanceFromReview` no-ops on an
   * already-approved row and `approveConnection` discards pending regardless — but a
   * review that omits what is being asked for is exactly the failure this surface exists
   * to prevent.
   *
   * `needsReapproval(row)` is the single derived definition the Settings pill already
   * reads, so deriving from it makes the two surfaces structurally incapable of
   * disagreeing, and removes the entire class of bug where a NEW call site forgets to pass
   * a mode. `session.mode` survives only as the OPEN-TIME slot-picking hint it always was
   * (`openConnectionWizardForApp`); it is no longer allowed to decide what is rendered,
   * which is this file's own "what is rendered is the row, always" doctrine applied to the
   * one place that had drifted from it.
   */
  const showDiff = useMemo(() => needsReapproval(row) && step === 'review', [row, step]);

  /**
   * The AC6 refusal gate, derived from the ROW (this file's doctrine) and the platform.
   * On web it is always undefined; on desktop it replaces every credential-half screen
   * for postures the shell does not implement — the refusal must land BEFORE a
   * credential is pasted, and before a dashboard registration is walked through for a
   * flow that would then refuse. The review screen still renders: what the app is
   * asking for remains readable even when connecting it here is not possible.
   */
  const desktopRefusal = useMemo(() => (row === undefined ? undefined : desktopOAuthRefusalFor(row.requirement)), [row]);

  if (session === null) return null;

  const title = row === undefined ? 'connect' : `connect ${row.requirement.provider.name}`;

  // Dismissal is GATED while a sign-in is mid-flight (owner decision 2026-08-10). The store
  // decides — this component only asks the question and routes the answer, so the rule
  // lives in one place and the Esc key, the backdrop and the close button all obey it.
  const requestClose = (): void => {
    if (closeConnectionWizard() === 'needs_confirm') setConfirmDiscard(true);
  };

  return (
    <Sheet title={title} open onClose={requestClose}>
      <div data-testid="connection-wizard">
      {confirmDiscard ? (
        <div className="hint" role="alertdialog" data-testid="discard-signin-confirm">
          <p>
            you are in the middle of signing in to {row?.requirement.provider.name ?? 'this provider'}. close anyway and
            the sign-in is discarded — you can start it again.
          </p>
          <button type="button" onClick={() => setConfirmDiscard(false)}>
            keep signing in
          </button>
          <button
            type="button"
            data-testid="discard-signin-confirm-yes"
            onClick={() => {
              setConfirmDiscard(false);
              forceCloseWizard();
            }}
          >
            discard the sign-in
          </button>
        </div>
      ) : null}

      {revoked !== undefined ? (
        <div className="hint" data-testid="revoked-before-notice">
          you revoked {revoked.providerName} for this app before
          {revoked.revokedAt !== undefined ? ` on ${revoked.revokedAt.slice(0, 10)}` : ''} — connecting again gives it
          fresh access.
        </div>
      ) : null}

      {!loaded ? (
        <span className="hint">loading this connection…</span>
      ) : row === undefined ? (
        <MissingRowScreen session={session} onClose={requestClose} />
      ) : showDiff ? (
        <ReapprovalDiffScreen
          row={row}
          onReapprove={() => void reapproveFromDiff()}
          onDismiss={requestClose}
        />
      ) : step === 'review' ? (
        <ReviewScreen row={row} onApprove={() => void advanceFromReview()} />
      ) : desktopRefusal !== undefined && step !== 'done' ? (
        <DesktopOAuthRefusalScreen refusal={desktopRefusal} appId={session.appId} slot={session.slot} onClose={requestClose} />
      ) : step === 'register' ? (
        <RegisterScreen row={row} onForward={() => void advanceFromRegister()} />
      ) : step === 'credentials' ? (
        <CredentialsScreen row={row} onSaved={() => undefined} />
      ) : step === 'connect' ? (
        <ConnectScreen
          row={row}
          onStart={() => {
            // Synchronous pre-open inside the gesture — see the note on `save` above.
            // Skipped on desktop (amendment 7): the OS opener is not gesture-gated.
            const preOpened = getPlatform().oauth === undefined ? openBlankConnectionOAuthPopup() : null;
            // CAUGHT, never `void`-discarded (AC8, TASK-20260812). Several paths throw
            // BEFORE any flow status is written — the B1 approval wall, the non-OAuth
            // kind guard, the mint's missing-client_id — and the old `void` form made
            // this button silently do nothing for every one of them. The catch routes
            // the thrown copy into the flow status store, which is exactly the error
            // region ConnectScreen already renders with a retry (AC7).
            return startConnectionOAuthFlow({}, preOpened).catch((err) => {
              connectionFlowStatusStore.set({
                state: 'error',
                message: err instanceof Error ? err.message : String(err),
              });
            });
          }}
        />
      ) : (
        <DoneScreen row={row} onClose={requestClose} />
      )}
      </div>
    </Sheet>
  );
}

/** Re-exported for the Settings card so the two surfaces share one status vocabulary. */
export { CONNECTION_STATUS };
