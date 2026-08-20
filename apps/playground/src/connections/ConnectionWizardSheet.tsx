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

import encodeQr from '@paulmillr/qr';
import { CONNECTION_STATUS, type ConnectionField, type ConnectionRequirement } from '@snugprotocol/protocol';
import { type ConnectionRow } from '@snugprotocol/db';
import { lookupWellKnownProvider, resolveRegistryEntryByName } from '@snugprotocol/auth';

import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import {
  advanceFromRegister,
  advanceFromReview,
  cancelConnectionOAuthFlow,
  beginDeviceLink,
  refreshDeviceLinkQr,
  canLinkDevice,
  canPairLanDevice,
  completeDeviceLink,
  isLinkedDeviceRequirement,
  isTokenClaimRequirement,
  claimConnectionVerified,
  runTokenClaim,
  tokenClaimPairingFor,
  lanConnectionVerified,
  lanPairingErrorStore,
  closeConnectionWizard,
  discoverLanHosts,
  forceCloseWizard,
  isCollectableLanHost,
  isLanRequirement,
  lanHostCollected,
  lanPairingExchangeFor,
  recordLanHost,
  runLanPairing,
  LAN_HOST_REFUSAL,
  connectionFlowStatusStore,
  connectionWizardRevisionStore,
  connectionWizardStepStore,
  connectionWizardStore,
  desktopOAuthPostureFor,
  desktopOAuthRefusalFor,
  findRevokedBefore,
  migrateConnectionRegistryDrift,
  needsReapproval,
  acknowledgeConnectionWizardFailure,
  openBlankConnectionOAuthPopup,
  reapproveFromDiff,
  saveConnectionCredentials,
  startConnectionOAuthFlow,
  testConnection,
  unexpectedTestOutcome,
  type ConnectionTestOutcome,
  type ConnectionWizardSession,
  type ConnectionWizardFailure,
  type DesktopOAuthAlternative,
  type DesktopOAuthRefusal,
  type RevokedBefore,
} from '../state/connectionWizard.js';
import { chooseAuthOption } from '../state/authKindChoice.js';
import { hasLiveAppHost, notifyAppRefresh } from '../state/appHosts.js';
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
    case 'linked_device':
      return `this app links to ${provider} as an extra device on your account — the way scanning a code adds a computer — and can then read and send as you. Your ${provider} sign-in details are never given to Snug, and you can unlink the device from ${provider} at any time.`;
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
 * ADR-0029 (MIGRATED from Q3, TASK-20260815) — is the console URL CLICKABLE? Iff its
 * BYTES match the pinned registry value for the row's RESOLVED provider, whatever the
 * row's provenance.
 *
 * Provenance was the wrong key: a starter/inference row whose provider matched the
 * registry had this URL SUBSTITUTED from the registry (`applyRegistryValues` replaces
 * `registration` on every borrow hit), so the shipped Spotify starter rendered
 * copy-paste for an address Snug itself pinned. The anti-phishing rule survives intact
 * as what it always meant: rendering an attacker-influenceable destination as a one-tap
 * anchor inside the platform's own credential wizard is the phishing hand-off in its
 * purest form — so anything NOT byte-identical to our pinned value (including a
 * near-miss one character off, the class an imported user file can carry) stays
 * copy-only, with the FULL url visible, because truncating the host is what turns a
 * copy-only affordance back into a phishing aid.
 *
 * Resolution is `resolveRegistryEntryByName` — the brand-adjacent rung admission itself
 * uses — never the exact-key `lookupWellKnownProvider` (the hue lesson the drift
 * migration documents: display names are not registry keys). Options' registrations are
 * checked too: an option's console URL is as pinned as the entry's.
 */
function consoleUrlIsClickable(row: ConnectionRow): boolean {
  const consoleUrl = row.requirement.registration?.consoleUrl;
  if (consoleUrl === undefined) return false;
  const entry = resolveRegistryEntryByName(row.requirement.provider.name)?.entry;
  if (entry === undefined) return false;
  // The byte-match is against the ROW'S OWN FLOW — the entry when the row's kind is the
  // entry's, an option when it is that option's (Gate-5 review). Matching against ANY
  // pinned URL let an imported row (the R-4 channel, where substitution never re-ran)
  // pair one flow's registration STEPS with a one-tap link to a DIFFERENT flow's
  // console — still a pinned page, so not a phishing hand-off, but a walkthrough whose
  // link cannot be followed. Kind-mismatched pinned URLs fall to copy-only, fail-closed.
  return [entry, ...(entry.authOptions ?? [])].some(
    (flow) => flow.kind === row.requirement.kind && flow.registration?.consoleUrl === consoleUrl,
  );
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

/**
 * IS THIS HOST A DEVICE ON THE USER'S OWN NETWORK? (P0 security amendment 15.)
 *
 * Deliberately BROADER than the LAN-class collection check: that one decides what
 * a Hue bridge address may be, this one decides when to WARN, and the threat it
 * warns about — a prompt-injected `api_key` row aimed at a router, a NAS, a
 * printer — is not limited to RFC-1918. Loopback and link-local are private in
 * exactly the sense that matters here (a host on this machine or this segment,
 * which the user cannot audit from the outside), so they raise the band too.
 *
 * String-shaped on purpose: `192-168-1-1.attacker.example` is a PUBLIC name and
 * must not raise the band, or the band stops meaning anything.
 */
function isPrivateNetworkHost(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

// ---------------------------------------------------------------------------
// LAN-class screens (ADR-0023 D1/D2/D4)
// ---------------------------------------------------------------------------

/**
 * THE WEB DISCLOSURE, and it lands before the user does any work.
 *
 * ADR-0023 D1's portability rule in its user-facing form: a LAN row opened on
 * the web is DISCLOSED, never refused and never destroyed. A user who paired a
 * bridge on the desktop app and then opens their file in a browser must find
 * the connection exactly as they left it — the browser simply cannot reach the
 * device, and says so.
 *
 * It renders INSTEAD of the address box rather than beside it: collecting an
 * address on a platform that could never pair with it is asking for work that
 * cannot pay off, which is the same broken promise the desktop OAuth refusal
 * screen exists to prevent, one platform over.
 */
/**
 * THE LINKED-DEVICE WALL (ADR-0032) — the web disclosure for a helper-backed connection.
 *
 * Deliberately says WHY rather than "unsupported": the helper is a program on the user's own
 * computer, and a web page has no way to talk to one. That is a browser boundary, not a
 * missing feature, and a user told the real reason can act on it.
 */
function LinkedDeviceWallScreen({ row, onClose }: { row: ConnectionRow; onClose: () => void }): ReactElement {
  const provider = row.requirement.provider.name;
  const linked = row.allowedHosts.length > 0;
  return (
    <div className="field" data-testid="linked-device-wall">
      <label>{provider} runs through a helper on your computer</label>
      <span className="hint">
        {linked
          ? `this connection is set up and stays exactly as you left it — but a web browser can't talk to a program running on your computer, so ${provider} only works in the Snug desktop app.`
          : `linking ${provider} runs a small helper on your own computer, and a web browser can't start or reach one — that's a browser security boundary, not a missing feature. Set this connection up in the Snug desktop app.`}
      </span>
      <Button variant="primary" onClick={onClose}>
        take me back
      </Button>
    </div>
  );
}

/**
 * THE LINKING SCREEN — start the helper, render the QR, poll, verify, record.
 *
 * WHAT THE USER IS AGREEING TO, said plainly on the screen where they act rather than buried
 * in a consent page they clicked past: this links Snug as a device on their WhatsApp account,
 * it can read and send as them, and their phone can unlink it at any time. The ToS/ban risk
 * is stated on the review screen's registration steps (the registry entry's `instructions`,
 * rendered verbatim); this screen carries the operational half.
 *
 * NOTHING DURABLE LANDS UNTIL THE VERIFY READ PASSES (ADR-0025). `completeDeviceLink` runs
 * the proof before it hands back a token, so a failure here leaves the row exactly as it was
 * rather than half-connected.
 */
/**
 * Encode a pairing payload as an SVG QR code.
 *
 * `ecc: 'medium'` because a phone camera reads this off a screen at arm's length — plenty of
 * error correction for a clean display, without inflating the module count for a payload that
 * is already ~280 characters.
 *
 * NEVER THROWS. A pairing screen that crashed on an unexpected payload would take the whole
 * wizard down at the one moment the user is mid-flow; a visible "could not draw" beats a
 * blank sheet, and the caller still shows the retry control.
 */
function encodeQrSvg(payload: string): string {
  try {
    return encodeQr(payload, 'svg', { ecc: 'medium', border: 2 });
  } catch {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" aria-hidden="true"></svg>';
  }
}

function LinkedDeviceScreen({ row, onLinked }: { row: ConnectionRow; onLinked: () => void }): ReactElement {
  const provider = row.requirement.provider.name;
  const [qr, setQr] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);

  const instruction =
    row.requirement.kind === 'linked_device'
      ? 'On your phone, open WhatsApp → Settings → Linked devices → Link a device, then scan the code below.'
      : `Follow ${provider}'s device-linking steps, then scan the code below.`;

  // THE QR ROTATES (~20 s server-side) while the user is still fumbling for their phone, and
  // a stale code scans as expired. Re-ask on a beat faster than the rotation and swap the
  // drawing in place. `refreshDeviceLinkQr` answers `undefined` both when the helper withholds
  // the QR (link landed) and on a transient failure — in either case the frame KEEPS the last
  // code rather than blanking mid-scan.
  useEffect(() => {
    if (!waiting) return;
    const beat = setInterval(() => {
      void refreshDeviceLinkQr().then((fresh) => {
        if (fresh !== undefined) setQr((prev) => (prev === fresh ? prev : fresh));
      });
    }, 5_000);
    return () => clearInterval(beat);
  }, [waiting]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setNote(undefined);
    const started = await beginDeviceLink();
    setBusy(false);
    if (!started.ok) {
      setNote(started.message);
      return;
    }
    if ('alreadyLinked' in started) {
      // The helper is linked and there is nothing to scan (autostart + boot resume make
      // this the common case, ADR-0037): complete directly — the verify read and the mint
      // are the same path the scan button drives.
      await finish();
      return;
    }
    setQr(started.qr);
    setWaiting(true);
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    const result = await completeDeviceLink();
    setBusy(false);
    if (!result.ok) {
      // The message names what happened AND what to do; "still waiting" is a distinct,
      // non-alarming case from "we could not confirm the link".
      setNote(result.message);
      return;
    }
    setWaiting(false);
    onLinked();
  };

  return (
    <div className="field" data-testid="linked-device-link">
      <label>link {provider} to Snug</label>
      <span className="hint">
        This adds Snug as a linked device on your {provider} account — the same way WhatsApp
        Web works. Snug will be able to read and send messages in the thread you choose, your
        sign-in details are never given to Snug, and you can unlink it from your phone at any
        time.
      </span>
      {qr === undefined ? (
        <Button variant="primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'starting the helper…' : 'start linking'}
        </Button>
      ) : (
        <>
          <span className="hint">{instruction}</span>
          {/*
            DRAWN AS AN SVG, because a QR the user cannot point a phone at is not a QR.

            This replaced a `<pre>` holding the raw payload, whose comment claimed "the
            desktop surface draws it" — a surface that never existed. The owner clicked
            "start linking", got a long URL, and had nothing to scan (2026-08-17).

            Inline SVG rather than an <img>: C2 pins `img-src` to `data:`/`blob:` only and the
            CDN allowlist is fixed, so a remote QR service is out by construction — which is
            the right answer anyway, since shipping a live pairing payload to a third party
            would hand them the ability to link themselves as the user's device.

            `@paulmillr/qr` is a zero-dependency encoder; the alternative on npm pulls in a
            CLI argument parser and a PNG codec to draw a grid of squares.
          */}
          <div
            className="qr-frame"
            data-testid="linked-device-qr"
            aria-label="QR code — scan this with your phone"
            role="img"
            // The encoder returns a complete SVG document for a value THIS process just
            // received from a helper it started. It is not user input and never crosses an
            // app boundary; `svg` is markup by definition, so there is nothing to escape.
            dangerouslySetInnerHTML={{ __html: encodeQrSvg(qr) }}
          />
          <Button variant="primary" disabled={busy} onClick={() => void finish()}>
            {busy ? 'checking…' : "I've scanned it"}
          </Button>
        </>
      )}
      {note !== undefined ? (
        <span className="hint" role="status" data-testid="linked-device-note">
          {note}
        </span>
      ) : null}
      {waiting && note === undefined ? (
        <span className="hint">waiting for the code to be scanned…</span>
      ) : null}
    </div>
  );
}

function LanDesktopWallScreen({ row, onClose }: { row: ConnectionRow; onClose: () => void }): ReactElement {
  const provider = row.requirement.provider.name;
  const paired = row.allowedHosts.length > 0;
  return (
    <div className="field" data-testid="lan-desktop-wall">
      <label>{provider} lives on your home network</label>
      <span className="hint">
        {paired
          ? `this connection is set up and stays exactly as you left it — but a web browser can't reach a device on your own network, so ${provider} only works in the Snug desktop app.`
          : `${provider} is a device on your own network, and a web browser can't reach one — that's a browser security boundary, not a missing feature. Set this connection up in the Snug desktop app.`}
      </span>
      {paired ? (
        <div className="field">
          <label>where this app may send them</label>
          <HostList hosts={row.allowedHosts} testId="lan-wall-hosts" />
        </div>
      ) : null}
      <Button variant="primary" onClick={onClose}>
        take me back
      </Button>
    </div>
  );
}

/**
 * THE ADDRESS STEP. It owns the screen, and the review's approve button is not
 * on it — that ordering is the binding one (ADR-0023 D1, amendment 5):
 *
 *     collect → approve (the ceiling FREEZES around this address) → pair
 *
 * Approving a pre-collection LAN row would freeze an EMPTY ceiling, which
 * refuses every request forever with nothing on any screen to explain why. So
 * the address is collected first, and the review then shows it as the host it
 * is about to freeze.
 *
 * MANUAL ENTRY IS THE PRIMARY PATH and discovery is an optional convenience
 * beside it (D4). The model never proposes an address — the extract-never-invent
 * rule, which for a user-specific device address is not a policy choice but a
 * structural one: there is nothing to extract.
 */
function LanHostScreen({
  row,
  onCollected,
}: {
  row: ConnectionRow;
  onCollected: () => void;
}): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | undefined>(undefined);
  const [discoveryNote, setDiscoveryNote] = useState<string | undefined>(undefined);
  const label = row.requirement.lanHost?.label ?? 'Device address';
  const provider = row.requirement.provider.name;
  // Discovery rides the platform fetch, which a browser does not have for this
  // origin (the broker CORS-locks to its own). Desktop-only in fact, not policy.
  const canDiscover = getPlatform().fetchImpl !== undefined;

  const submit = (): void => {
    setError(undefined);
    // The client-side check first, so a typo answers instantly in plain words
    // rather than after a round trip through the persist gates.
    if (!isCollectableLanHost(value)) {
      setError(LAN_HOST_REFUSAL);
      return;
    }
    setSaving(true);
    void recordLanHost(value)
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onCollected();
      })
      .finally(() => setSaving(false));
  };

  const findBridge = (): void => {
    setDiscovering(true);
    setDiscoveryNote(undefined);
    void discoverLanHosts()
      .then((addresses) => {
        setDiscovered(addresses);
        if (addresses.length === 0) {
          // HONEST empty state: the broker only knows bridges that phoned home
          // from this network, and plenty never do.
          setDiscoveryNote(
            "we didn't find a bridge from here — that's common, and typing the address yourself works just as well.",
          );
        }
      })
      .catch(() => {
        setDiscovered([]);
        setDiscoveryNote("we couldn't check for bridges just now — type the address yourself below.");
      })
      .finally(() => setDiscovering(false));
  };

  return (
    <div className="field" data-testid="lan-host-step">
      <label htmlFor="lan-host-input">{label}</label>
      <span className="hint">
        {provider} is a device on your own network, so only you can say where it is. The address looks like{' '}
        <code>192.168.1.50</code> — your {provider} app shows it under its own settings.
      </span>

      <StepList steps={row.requirement.registration?.instructions ?? []} testId="lan-host-steps" />

      <input
        id="lan-host-input"
        data-testid="lan-host-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder="192.168.1.50"
        value={value}
        onInput={(event) => setValue((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          // Enter submits. There is no <form> here — C2's sandbox blocks form
          // submission before the event fires (lesson 2026-08-06), and this
          // sheet renders inside the host page rather than the app frame, but
          // the repo keeps one idiom so a copied pattern cannot land in a
          // sandbox and die silently.
          if (event.key === 'Enter') submit();
        }}
      />

      {error !== undefined ? (
        <div className="error-note" role="alert" data-testid="lan-host-error">
          {error}
        </div>
      ) : null}

      <Button variant="primary" onClick={submit} disabled={saving}>
        {saving ? 'saving…' : 'use this address'}
      </Button>

      {canDiscover ? (
        <div className="field">
          <Button onClick={findBridge} disabled={discovering}>
            {discovering ? 'looking…' : 'find my bridge'}
          </Button>
          {discovered !== undefined && discovered.length > 0 ? (
            <>
              <span className="hint">we found {discovered.length === 1 ? 'this' : 'these'} — pick one to fill it in:</span>
              {discovered.map((address, index) => (
                <Button
                  key={address}
                  data-testid={`lan-discovery-choice-${index}`}
                  onClick={() => {
                    // FILLS the box, never submits. The address is the whole
                    // decision, and a broker answer is a suggestion — the user
                    // still says yes to it.
                    setValue(address);
                    setError(undefined);
                  }}
                >
                  use {address}
                </Button>
              ))}
            </>
          ) : null}
          {discoveryNote !== undefined ? (
            <span className="hint" data-testid="lan-discovery-note">
              {discoveryNote}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * THE PAIRING STEP — the only screen in this wizard where a credential is
 * CREATED rather than pasted.
 *
 * The precondition copy is the registry's own, rendered verbatim immediately
 * before the exchange fires, because the device only hands out a key inside its
 * own consent window: this copy is the difference between a working pairing and
 * an unexplained failure. It is registry text (human-reviewed in a PR), so it is
 * shown as-is; an LLM-authored string in this position would be a phishing
 * instruction inside the platform's own credential surface.
 *
 * NOTHING FIRES UNTIL THE USER SAYS THEY PRESSED IT. An automatic attempt on
 * arrival would burn the window before the user had read the sentence telling
 * them what to do, and the second attempt would look like the first one failing.
 *
 * C1 — this component never sees the minted key. `runLanPairing` writes it to
 * `snug_secrets` and returns only ok/message; there is no value here to render,
 * log or leak, and the failure copy is written by the store from a fixed set of
 * sentences rather than assembled from the device's own answer.
 */
function LanPairScreen({ row, onPaired }: { row: ConnectionRow; onPaired: () => void }): ReactElement {
  const [pairing, setPairing] = useState(false);
  // The error lives in the STORE, not in component state: a failed attempt bumps the
  // revision (durable state changed), the bump remounts this screen through the
  // loading gate, and a local error would be eaten by exactly that remount.
  const error = useStore(lanPairingErrorStore) ?? undefined;
  const exchange = lanPairingExchangeFor(row.requirement);
  const provider = row.requirement.provider.name;
  const host = row.allowedHosts[0];

  const pair = (): void => {
    setPairing(true);
    void runLanPairing()
      .then((result) => {
        if (!result.ok) return;
        onPaired();
      })
      .finally(() => setPairing(false));
  };

  return (
    <div className="field" data-testid="lan-pair-step">
      <label>let {provider} know it&apos;s you</label>
      <span className="hint">
        {host !== undefined ? (
          <>
            we&apos;ll ask the device at <code>{host}</code> for a key of its own. Nothing to look up and nothing to
            paste — it creates the key and we keep it for you.
          </>
        ) : (
          'we’ll ask the device for a key of its own.'
        )}
      </span>

      {exchange !== undefined ? (
        <p className="hint" data-testid="lan-pair-precondition">
          {exchange.preconditionInstruction}
        </p>
      ) : null}

      {error !== undefined ? (
        <div className="error-note" role="alert" data-testid="lan-pair-error">
          {error}
        </div>
      ) : null}

      <Button variant="primary" onClick={pair} disabled={pairing}>
        {pairing ? 'talking to the device…' : "I pressed the button — connect"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token claim (ADR-0038)
// ---------------------------------------------------------------------------

/**
 * The paste-and-claim screen for a token-claim row (SimpleFIN's family): one box, one
 * verb. The pasted token is held in LOCAL state only — it is consumed by the claim and
 * must never outlive this screen — and the error is local too, unlike LanPairScreen's
 * store, because a FAILED claim writes nothing durable, bumps no revision, and so is
 * never remounted out from under its own error.
 */
function TokenClaimScreen({ row, onClaimed }: { row: ConnectionRow; onClaimed: () => void }): ReactElement {
  const [setupToken, setSetupToken] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const pairing = tokenClaimPairingFor(row.requirement);
  const provider = row.requirement.provider.name;

  const claim = (): void => {
    setClaiming(true);
    setError(undefined);
    void runTokenClaim(setupToken)
      .then((result) => {
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // The token is spent the moment the claim succeeds — clear the paste box so the
        // one-time value does not linger in component state behind a done screen.
        setSetupToken('');
        onClaimed();
      })
      .finally(() => setClaiming(false));
  };

  return (
    <div className="field" data-testid="token-claim-step">
      <label>{pairing?.tokenLabel ?? `your ${provider} setup token`}</label>
      {pairing !== undefined ? (
        <span className="hint" data-testid="token-claim-precondition">
          {pairing.preconditionInstruction}
        </span>
      ) : null}

      <textarea
        data-testid="token-claim-input"
        value={setupToken}
        onChange={(event) => setSetupToken(event.target.value)}
        rows={4}
        placeholder="paste the whole token here"
        autoComplete="off"
        spellCheck={false}
      />

      {error !== undefined ? (
        <div className="error-note" role="alert" data-testid="token-claim-error">
          {error}
        </div>
      ) : null}

      <Button variant="primary" onClick={claim} disabled={claiming || setupToken.trim() === ''}>
        {claiming ? 'claiming your access key…' : 'claim my access key'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

function ReviewScreen({ row, onApprove }: { row: ConnectionRow; onApprove: () => void }): ReactElement {
  const requirement = row.requirement;
  const fields = requirement.fields ?? [];
  const scopes = requirement.scopes ?? [];
  const registration = requirement.registration;
  // ONE resolution, both seats — the discipline P3 applied to the lint, applied here to
  // the disclosure, so the review can never fall behind what the executor will send.
  const headerTemplate = requirement.request?.headerTemplate;
  const queryTemplate = requirement.request?.queryTemplate;
  const reviewedHosts = row.allowedHosts.length > 0 ? row.allowedHosts : (requirement.declaredApiHosts ?? []);
  const privateHosts = reviewedHosts.filter(isPrivateNetworkHost);

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

      {scopes.length > 0 ? (
        <div className="field" data-testid="review-scopes">
          {/*
            THE SCOPES BOX (TASK-20260815 AC3b, ADR-0028). This box is what makes
            "pinned scopes are never silent" TRUE: the plan review found the protocol
            comment claiming "scopes is what the review renders" while no renderer
            existed — a seat that skips the review screen is admitted for free (the
            queryTemplate lesson, 2026-08-13). Rendered VERBATIM in declaration order,
            as `code`, exactly like the template boxes above: the scope strings are what
            the provider's own consent screen will list, and a friendly paraphrase here
            would leave the user meeting them for the first time on the provider's page.
          */}
          <label>what this sign-in may do</label>
          <ul>
            {/* Index-keyed (Gate-5 review): authored scopes under a non-pinned brand
                may contain duplicates, and this screen's whole job is VERBATIM
                disclosure — a colliding key must not let React drop a line. */}
            {scopes.map((scope, index) => (
              <li key={`${index}:${scope}`}>
                <code>{scope}</code>
              </li>
            ))}
          </ul>
          <span className="hint">
            the provider shows this same list on its consent screen when you sign in — nothing broader can be asked for
            without coming back here first.
          </span>
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

      {queryTemplate !== undefined ? (
        <div className="field">
          {/*
            THE CO-EQUAL PLACEMENT SEAT (P6 whole-surface BLOCKER). `queryTemplate` was
            wired through schema, Guard 2b, lint, injection and scrubbing — but not
            through THIS screen, which ADR-0017 names as the price of admitting these
            seats: the lint bounds WHAT a template may do, the review is where the user
            sees WHERE their secret goes. A query-only requirement (both shipped entries,
            openweather and coingecko) was approved with no placement disclosure at all.

            Deliberately its own box rather than merged with the headers: a credential in
            a web ADDRESS is a different risk story from one in a header — URLs land in
            server logs, proxies and browser history — and a user's intuition about that
            difference is the whole point of showing it.
          */}
          <label>added to the web address of every request</label>
          <code data-testid="review-query-template" className="redirect-uri">
            {Object.entries(queryTemplate)
              .map(([param, value]) => `?${param}=${value}`)
              .join('\n')}
          </code>
        </div>
      ) : null}

      <div className="field">
        <label>where this app may send them</label>
        {/*
          THE CEILING THE REVIEW SHOWS is the one that will freeze. On a
          `declared` row `allowedHosts` is still empty — it is written by
          `approveConnection` — so the display derives from the requirement's
          own declaration, which is what the user is being asked about. (Before
          ADR-0023 every reviewed row happened to be re-reviewed post-approval
          too, which is how an empty list here went unnoticed; a LAN row makes
          it visible because the address is the WHOLE decision.)
        */}
        <HostList hosts={reviewedHosts} testId="review-hosts" />
        {privateHosts.length > 0 ? (
          /*
            THE PRIVATE-ADDRESS CONSENT BAND (P0 security amendment 15).

            A private address is the one class of host the frozen-ceiling promise
            protects the user LEAST from, because the danger is not where the
            request goes — it is that the user cannot tell what lives there. A
            prompt-injected `api_key` row naming `192.168.1.1` passes every gate:
            the schema accepts a digit-label host, admission has no registry to
            contradict, and the executor's ADR-0021 rung deliberately allows
            explicitly-approved private literals. This band is the only thing
            between that row and a credential typed into a router.

            It WARNS rather than refuses: self-hosted services on a home network
            are a legitimate and growing use, and refusing them outright would
            trade a real capability for a threat the user is better placed to
            judge than we are. The host is NAMED so the judgement is possible.
          */
          <div className="hint" role="note" data-testid="review-private-host-warning">
            {privateHosts.map((host) => (
              <code key={host}>{host}</code>
            ))}{' '}
            {privateHosts.length === 1 ? 'is an address' : 'are addresses'} on your own network — a device in your home
            rather than a company&apos;s server. Make sure you recognize{' '}
            {privateHosts.length === 1 ? 'this address' : 'these addresses'} before pasting a credential: nobody outside
            your network can check it for you.
          </div>
        ) : null}
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
  // Memoized: the resolution walks the registry (brand-adjacent scan on miss) and this
  // screen re-renders on every copy-button click and async redirect-URI arrival, while
  // the answer can only change with the row (Gate-5 review, efficiency).
  const clickable = useMemo(() => consoleUrlIsClickable(row), [row]);
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
              {/*
                ADR-0029 §3: on desktop the link opens via the SYSTEM browser (the same
                RFC 8252 posture as the sign-in leg — the webview never navigates to a
                provider), so the anchor's default navigation is preempted when the
                platform carries an opener. The href stays real either way: hover shows
                the destination, and the web branch is exactly the old behavior.
              */}
              <a
                href={consoleUrl}
                target="_blank"
                rel="noreferrer"
                onClick={
                  platformOauth !== undefined
                    ? (event) => {
                        event.preventDefault();
                        void platformOauth.openExternal(consoleUrl);
                      }
                    : undefined
                }
              >
                {consoleUrl}
              </a>
            </span>
          ) : (
            <>
              {/*
                Copy-only (ADR-0029). The full address is shown so the user can read
                where they are being sent and decide for themselves — see
                `consoleUrlIsClickable`.
              */}
              <code className="redirect-uri" data-testid="register-console-url">
                {consoleUrl}
              </code>
              <span className="hint">
                open this address yourself — we don’t link it, because we haven’t pinned it: it came from a model or an
                app author, not from Snug’s own registry.
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
   * The refresh prompt's own state (TASK-20260819 AC1). `declined` covers BOTH honest
   * exits — the user said "not now", or the frame turned out to be unreachable — because
   * from this screen they mean the same thing: there is nothing more to offer, and the
   * prompt must not sit there implying otherwise.
   */
  const [refresh, setRefresh] = useState<'idle' | 'sent' | 'declined'>('idle');

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

  /**
   * TASK-20260815 AC6 — "connected" is EARNED, not declared. For a probeable non-LAN
   * row the heading claims a connection only after a PASSING probe; until then the
   * honest claim is that the credentials are saved. This closes the second silent path
   * of the owner's Coinbase repro: an unverifiable-but-broken credential rendered a
   * "connected" heading while public market data made the app look alive, and the
   * first real feedback was a 401 far from this screen.
   *
   * The gate is `probeable ∧ ¬LAN`, and the LAN exclusion is deliberately explicit
   * even though no LAN entry pins a testRequest today (plan-review 7a): a LAN done
   * screen reports a pairing PROVEN against a named device (ADR-0025), and a future
   * LAN probe must never downgrade that proven claim to "saved until you probe".
   */
  // ONE derivation for both the label and the hint (review finding: two inline copies
  // of `claimGated && !probeVerified` invite the exact split-truth this AC prevents).
  const awaitingProbe = probeable && !isLanRequirement(row.requirement) && outcome?.ok !== true;

  const runTest = (): void => {
    setTesting(true);
    setOutcome(undefined);
    void testConnection()
      .then(setOutcome)
      // AC5 belt-and-braces: `testConnection` is total, but a rejection reaching this
      // chain must still render a line, never a blank result area. The outcome comes
      // from the ONE shared construction (fixed sentence, err.name only — C5).
      .catch((err: unknown) => setOutcome(unexpectedTestOutcome(err)))
      .finally(() => setTesting(false));
  };

  return (
    <div className="field">
      <label>
        {awaitingProbe
          ? `${row.requirement.provider.name} credentials saved`
          : `${row.requirement.provider.name} is connected`}
      </label>
      <span className="hint">
        {isLanRequirement(row.requirement) ? (
          /*
            AC6 (ADR-0025) — the LAN done copy names the PROVEN fact and the device it
            was proven against. This branch is only reachable through the verified-fact
            gate in the render chain, so "verified" here is a report, never a promise.
            The host is guarded the same way LanPairScreen guards it: an empty ceiling
            must degrade the sentence, never render a claim about a device it cannot
            name.
          */
          <>
            paired and verified with{' '}
            {row.allowedHosts[0] !== undefined ? (
              <>
                the device at <code>{row.allowedHosts[0]}</code>
              </>
            ) : (
              'your device'
            )}{' '}
            — it accepted the new key when we checked. You can disconnect it any time from Settings → Connections.
          </>
        ) : (
          <>
            this app can now reach {row.allowedHosts.join(', ')} on your behalf.{' '}
            {awaitingProbe ? 'Run the test below to confirm the connection works. ' : ''}You can
            disconnect it any time from Settings → Connections.
          </>
        )}
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
        TASK-20260819 AC1 — the refresh prompt. Until this existed, the wizard proved a
        connection worked and then discarded that knowledge: the user returned to an app
        still rendering its sample data, with nothing on screen admitting it had not
        caught up. Two things make it honest:

        GATED ON VERIFIED, NOT SAVED. `awaitingProbe` is the same derivation the heading
        uses (TASK-20260815 AC6 — "connected" is earned, not declared), so a probeable
        row must PASS its probe first. Offering to replace real data on the strength of an
        unproven credential would teach exactly the misplaced trust AC6 prevents. OAuth
        kinds are unprobeable by design because the minted token IS the round trip, so
        they qualify on arrival — which matters, since that is the kind Inbox Copilot uses.

        OFFERED ONLY WHEN THERE IS SOMETHING TO TELL. `hasLiveAppHost` is asked because
        this sheet also opens from Settings, where no frame is mounted; promising a
        refresh into a void would be a button that lies.
      */}
      {!awaitingProbe && hasLiveAppHost(row.appId) && refresh !== 'declined' ? (
        <div className="field" data-testid="connection-refresh-prompt">
          <span className="hint">
            {refresh === 'sent' ? (
              <>
                asked the app to load your real data — the sample data it was showing is on its way out.
              </>
            ) : (
              <>
                <strong>This app is still showing sample data.</strong> Load your real{' '}
                {row.requirement.provider.name} data now? It replaces the example data on screen —
                nothing in your {row.requirement.provider.name} account is changed.
              </>
            )}
          </span>
          {refresh === 'idle' ? (
            <div className="row">
              <Button
                variant="primary"
                onClick={() => {
                  setRefresh(notifyAppRefresh(row.appId, row.slot) ? 'sent' : 'declined');
                }}
              >
                load my real data
              </Button>
              {/*
                Declining is a real choice with its own button, not "close the sheet and
                hope". Someone who wants to keep exploring the demo before pointing the
                app at their own account is doing something legitimate.
              */}
              <Button onClick={() => setRefresh('declined')}>not now</Button>
            </div>
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
  // ADR-0028 (TASK-20260815 AC3b): without this delta, a scopes-ONLY staged edit — the
  // exact edit the scope-drift migration stages — rendered as a diff whose every line
  // read unchanged: an approval request for nothing the user could see.
  const scopeLines = diffLines(row.requirement.scopes ?? [], pending.scopes ?? []);

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
        {scopeLines.length > 0 ? (
          <div className="field">
            <label>what this sign-in may do</label>
            <ul data-testid="reapproval-scope-diff">{scopeLines.map(render)}</ul>
          </div>
        ) : null}
      </div>
      <Button variant="primary" onClick={onReapprove}>
        approve these changes
      </Button>
      <Button onClick={onDismiss}>keep the current connection</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The attention gate — Step 0 (TASK-20260819)
// ---------------------------------------------------------------------------

/**
 * THE DIAGNOSIS SCREEN a provider refusal opens onto.
 *
 * WHERE IT CAME FROM. Until 2026-08-19 this content was a full-bleed maroon block
 * rendered INSIDE the running app (`AuthRepairBanner`). It displaced the app's own UI,
 * and because the host cannot tell an expected refusal from a broken credential, it
 * greeted the owner on every launch of a perfectly healthy Spotify connection. Owner
 * decision D2 moved the diagnosis here — where a connection is already the subject and a
 * full screen is not an intrusion — and left the run surface a quiet chip.
 *
 * WHY IT IS A GATE AND NOT A STEP (D5). See the derivation at the call site: `nextStep`
 * early-returns for LAN rows, `showDiff` is step-keyed, and three unproven-row catch-alls
 * key on `step !== 'review'` — a new step member would have interacted with all three.
 * This is a condition on the session, exactly like `showDiff` is a condition on the row.
 *
 * C1 — `detail` is the provider's own error sentence, extracted host-side from the
 * gate-10-scrubbed delivered body and capped at 160 chars. No credential, no URL, no raw
 * response bytes can reach it, and it renders as TEXT ONLY: never markup, never a link
 * (the hostile-copy rule the registration steps carry, pinned by test).
 */
function AttentionScreen({
  provider,
  failure,
  onContinue,
  onDismiss,
}: {
  provider: string;
  failure: ConnectionWizardFailure;
  onContinue: () => void;
  onDismiss: () => void;
}): ReactElement {
  return (
    <div className="field" data-testid="connection-attention">
      <label>{provider} isn’t accepting this app’s key</label>
      <p className="hint">
        The app keeps running — only the parts that need {provider} are affected. The key may be wrong, expired, or
        revoked ({failure.status}).
      </p>
      {failure.detail !== undefined ? (
        <p className="hint" data-testid="auth-repair-detail">
          {/* The provider's own diagnosis, verbatim — plain text by construction. */}
          {provider} says: “{failure.detail}”
        </p>
      ) : null}
      <Button variant="primary" onClick={onContinue}>
        check this connection
      </Button>
      <Button onClick={onDismiss}>dismiss</Button>
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
  /**
   * Has the ADR-0025 verify read PROVEN this LAN connection? A BOOLEAN, never the
   * state object — the `_connection` KV carries the pin, and this component must not
   * hold what it has no reason to render (C1). The one reader of that state is the
   * store layer's `lanConnectionVerified`; this component only keeps its answer.
   */
  const [lanVerified, setLanVerified] = useState(false);
  const [linkVerified, setLinkVerified] = useState(false);
  /**
   * Has the claim already run for this token-claim row? LOADED FROM THE ROW'S state on
   * every (re)open, unlike `linkVerified` — a setup token works exactly once (AC5), so
   * a wizard reopened on a claimed row must land on done rather than on a paste box
   * whose submission could only burn a token and fail.
   */
  const [claimVerified, setClaimVerified] = useState(false);
  /**
   * The revision whose row the effect below has actually re-read (ADR-0025 §6). The
   * step store moves SYNCHRONOUSLY on a transition while the row refreshes async — and
   * a chain evaluated with a fresh step against a stale row once rendered a success
   * screen for a pairing that had not run. Rendering is therefore gated on
   * `loadedRevision === revision`: between a store write and the re-read, the sheet
   * says "loading" rather than guessing. `-1` doubles as "never loaded" — the open
   * path always bumps the revision to ≥1, so the mismatch covers the first render too
   * (the former separate `loaded` boolean was this same fact stored twice, and two
   * lockstep setters are one early-return away from disagreeing).
   */
  const [loadedRevision, setLoadedRevision] = useState(-1);
  /** Set only when the store REFUSES a close because a sign-in is mid-flight (M9). */
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const appId = session?.appId;
  const slot = session?.slot;

  useEffect(() => {
    if (appId === undefined || slot === undefined) {
      setRow(undefined);
      setRevoked(undefined);
      setLanVerified(false);
      setClaimVerified(false);
      setLoadedRevision(-1);
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
      const verified =
        found !== undefined && isLanRequirement(found.requirement)
          ? await lanConnectionVerified(db, appId, slot)
          : false;
      const claimed =
        found !== undefined && isTokenClaimRequirement(found.requirement)
          ? await claimConnectionVerified(db, appId, slot)
          : false;
      if (!alive) return;
      setRow(found);
      setRevoked(found === undefined ? undefined : findRevokedBefore(db, appId, found.requirement, slot));
      setLanVerified(verified);
      setClaimVerified(claimed);
      setLoadedRevision(revision);
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
   * THE ATTENTION GATE (TASK-20260819) — derived from the SESSION's failure copy, exactly
   * as `showDiff` is derived from the row. Not a step: `nextStep` early-returns 'done' for
   * a LAN requirement, `showDiff` is keyed on `step === 'review'`, and the three
   * unproven-row catch-alls below key on `step !== 'review'` — a new step member would
   * have collided with all three (the fresh-context plan review walked each one).
   *
   * `!showDiff` IS THE PRECEDENCE RULE (owner decision D3), and it is the case this task
   * creates for every existing Spotify user: adding a registry scope means their next
   * launch both 403s on the old token AND stages a re-approval. The staged diff is the
   * CURE for that failure, so it leads; showing the diagnosis first would hand the user an
   * unexplained consent delta one tap later. Keyed on `step === 'review'` for the same
   * reason `showDiff` is — once the user walks into the credential half, the gate is
   * behind them.
   */
  const showAttention = session?.failure !== undefined && step === 'review' && !showDiff;

  /**
   * The AC6 refusal gate, derived from the ROW (this file's doctrine) and the platform.
   * On web it is always undefined; on desktop it replaces every credential-half screen
   * for postures the shell does not implement — the refusal must land BEFORE a
   * credential is pasted, and before a dashboard registration is walked through for a
   * flow that would then refuse. The review screen still renders: what the app is
   * asking for remains readable even when connecting it here is not possible.
   */
  const desktopRefusal = useMemo(() => (row === undefined ? undefined : desktopOAuthRefusalFor(row.requirement)), [row]);

  /**
   * The three LAN gates, derived from the ROW and the platform (this file's
   * doctrine) rather than from the step machine.
   *
   * WHY NOT NEW STEPS. `nextStep` derives the machine from the requirement so a
   * requirement edited between two screens cannot strand the user on a route
   * that no longer matches — adding LAN steps to that enum would mean the
   * machine could sit on `lan-host` for a row whose address is already
   * collected. These are conditions on the current row instead, so they stop
   * being true the moment the fact they describe stops being true, which is the
   * same reason `showDiff` is derived rather than stored.
   */
  const isLanRow = row !== undefined && isLanRequirement(row.requirement);
  /** Web: disclose and stop. `canPairLanDevice` is the honest capability test. */
  const lanWall = isLanRow && !canPairLanDevice();
  /** Pre-collection: no address on the row yet, so nothing to review or freeze. */
  const lanNeedsHost = isLanRow && !lanWall && !lanHostCollected(row.requirement);
  /**
   * Past the review, pre-PROOF: everything a LAN row may show between the review
   * screen and the done screen is the pairing step. Keyed on the VERIFIED fact rather
   * than on a step, a status, or key presence (ADR-0025 §3): a wizard reopened after a
   * half-finished pairing — or after a pairing whose claim nothing ever proved, which
   * is every row the pre-ADR-0025 code left behind — must land back on the pairing
   * step rather than on a done screen claiming a connection no proof backs.
   *
   * DELIBERATELY A CATCH-ALL (Gate-5 finding): no `status === approved` conjunct and
   * placed ABOVE the step-keyed branches, so no step value — however it was arrived
   * at — can walk an unproven LAN row into the register/credentials screens or the
   * done screen. A row that reaches here in a state pairing cannot serve gets the
   * pairing screen's own refusal on click, which names what to do next; that is
   * strictly more honest than any screen the step branches could render.
   */
  const lanNeedsPairing = isLanRow && !lanWall && !lanNeedsHost && step !== 'review' && !lanVerified;

  /**
   * THE LINKED-DEVICE FAMILY (ADR-0032) — its own two booleans beside the three above, for
   * the reason the whole phase exists: `isLanRequirement` is `lanHost !== undefined`, and a
   * linked-device row carries no `lanHost` (the schema refuses the combination), so it
   * cannot be routed by widening those gates without dragging it into a pairing path that
   * demands a TLS pin a unix socket can never produce.
   *
   * Derived from the ROW and the platform, like every gate in this file, so each stops being
   * true the moment the fact it describes stops being true.
   */
  const isLinkedDeviceRow = row !== undefined && isLinkedDeviceRequirement(row.requirement);
  /** Web (or a shell without the seats): disclose and stop. Same posture as `lanWall`. */
  const linkWall = isLinkedDeviceRow && !canLinkDevice();
  /**
   * Past the review, pre-PROOF. Keyed on the VERIFIED fact rather than on a step or on key
   * presence, for ADR-0025's reason: a wizard reopened after a half-finished link must land
   * back on the linking screen rather than on a done screen claiming a connection nothing
   * proved. A catch-all placed above the step-keyed branches, so no step value can walk an
   * unproven row into the credentials or done screens.
   */
  const linkNeedsPairing = isLinkedDeviceRow && !linkWall && step !== 'review' && !linkVerified;

  /**
   * THE TOKEN-CLAIM FAMILY (ADR-0038) — one boolean, derived from the ROW like every
   * gate here. No wall: the claim is plain HTTPS with verified CORS, so it works on
   * web and desktop alike. The `register` exemption is deliberate and unique to this
   * family: the walkthrough is where the user goes to GET the setup token, so it must
   * render before the paste box — while every OTHER step value (credentials, connect,
   * done, however arrived at) is caught, so no unproven row can reach the typed
   * credentials screen or a done screen no claim backs (the ADR-0025 catch-all
   * doctrine, with one named door).
   */
  const isTokenClaimRow = row !== undefined && isTokenClaimRequirement(row.requirement);
  const claimNeedsToken = isTokenClaimRow && step !== 'review' && step !== 'register' && !claimVerified;

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

      {loadedRevision !== revision ? (
        /*
          ADR-0025 §6 — the row for THIS revision has not landed yet. A store
          transition moves the step synchronously and the row refresh is async;
          rendering from the pair would be rendering a guess, and the one guess this
          chain once produced was a success screen for a pairing that had not run.
        */
        <span className="hint">loading this connection…</span>
      ) : row === undefined ? (
        <MissingRowScreen session={session} onClose={requestClose} />
      ) : linkWall ? (
        /*
          THE LINKED-DEVICE WALL, ahead of everything for the same reason the LAN wall is:
          a browser tab cannot open a unix socket, so every screen behind this one would
          ask for work that cannot pay off. Disclosure, never breakage — the row stays
          intact and a desktop-linked connection opened here still reads as connected.
        */
        <LinkedDeviceWallScreen row={row} onClose={requestClose} />
      ) : lanWall ? (
        /*
          THE LAN WEB WALL, ahead of every other screen including the diff.

          A browser cannot pair with a device on the user's network, so every
          screen behind this one would ask for work that cannot pay off. It is
          a DISCLOSURE and nothing else: the row is untouched, and a
          desktop-minted connection opened here is shown as the working
          connection it still is (ADR-0023 D1's portability rule).
        */
        <LanDesktopWallScreen row={row} onClose={requestClose} />
      ) : showAttention ? (
        <AttentionScreen
          provider={row?.requirement.provider.name ?? session.slot}
          failure={session.failure!}
          onContinue={() => acknowledgeConnectionWizardFailure()}
          onDismiss={requestClose}
        />
      ) : showDiff ? (
        <ReapprovalDiffScreen
          row={row}
          onReapprove={() => void reapproveFromDiff()}
          onDismiss={requestClose}
        />
      ) : lanNeedsHost ? (
        /*
          THE BINDING ORDER, expressed as a screen that comes BEFORE the review:
          a pre-collection LAN row has no host to freeze, so approving it would
          freeze an empty ceiling that refuses everything with nothing on any
          screen to explain it.
        */
        <LanHostScreen row={row} onCollected={() => undefined} />
      ) : step === 'review' ? (
        <ReviewScreen row={row} onApprove={() => void advanceFromReview()} />
      ) : linkNeedsPairing ? (
        /*
          LINKING REPLACES THE CREDENTIALS SCREEN, exactly as pairing does for a LAN row:
          the token is minted by the link, not typed, so the ordinary credentials screen
          would show a box nothing can fill.
        */
        <LinkedDeviceScreen row={row} onLinked={() => setLinkVerified(true)} />
      ) : lanNeedsPairing ? (
        /*
          PAIRING REPLACES THE CREDENTIALS SCREEN for a LAN row, because the
          credential is minted rather than typed: the field exists so the secret
          has a named slot, and there is nothing for the user to paste into it.
          Rendering the ordinary credentials screen here would show a box no Hue
          surface can fill.
        */
        <LanPairScreen row={row} onPaired={() => undefined} />
      ) : claimNeedsToken ? (
        /*
          THE CLAIM REPLACES THE CREDENTIALS SCREEN for a token-claim row (ADR-0038):
          the basic pair is minted by the claim, never typed, so the ordinary screen
          would show two boxes nothing can fill — and `saveConnectionCredentials`
          refuses this family anyway (the belt to this brace).
        */
        <TokenClaimScreen row={row} onClaimed={() => setClaimVerified(true)} />
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
        /*
          A LAN row can only be here VERIFIED: the catch-all pairing branch above
          intercepts every unproven LAN row before the step-keyed branches, so the done
          screen's "paired and verified" claim is structurally impossible to render
          unproven (ADR-0025 §6).
        */
        <DoneScreen row={row} onClose={requestClose} />
      )}
      </div>
    </Sheet>
  );
}

/** Re-exported for the Settings card so the two surfaces share one status vocabulary. */
export { CONNECTION_STATUS };
