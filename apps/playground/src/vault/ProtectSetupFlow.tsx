// ProtectSetupFlow — turning on protection (TASK-20260820, D2/D3, ADR-0043).
//
// THE HARDEST SCREEN IN SNUG. It asks for something most software never asks: accept a
// consequence nobody can undo for you, in exchange for protection that is real. Both
// failure directions are expensive. Undersell the cost and someone turns it on, forgets
// the passphrase, and loses a decade of their own life. Oversell it and nobody turns it
// on, and the feature is decoration that improves nothing.
//
// Three steps, one idea each:
//   1. the trade, stated whole — what it protects AND what it costs, together, before
//      any commitment. Splitting those across screens would make the consent worthless.
//   2. the passphrase — length is the only rule. No "must contain a symbol" theatre:
//      arbitrary composition rules are how people end up at Password1! on a sticky note.
//   3. the Recovery Key — generated, shown ONCE, copyable and downloadable, and gated
//      behind a mandatory acknowledgement (a checkbox since TASK-20260821 — owner
//      call; originally a typed phrase), because clicking through this screen unread
//      is precisely the path that ends in lost data.
import { useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { enableProtection } from './enableProtection.js';
import { deferProtectOffer, declineProtectOfferPermanently, markProtectionEnabled } from './protectOffer.js';

/** Long enough to matter; short enough that a memorable phrase qualifies. */
const MIN_PASSPHRASE = 12;

export function ProtectSetupFlow({
  onDone,
  /**
   * Where to start. The in-hub banner (`ProtectionOffer`) already states the trade and
   * carries the three choices, so entering from there begins at the passphrase and does
   * not repeat step 1 back at the user. Settings enters the same way. Step 1 remains for
   * any caller that has not already made the offer.
   */
  startAt = 1,
}: {
  onDone: () => void;
  startAt?: 1 | 2;
}): ReactElement {
  const [step, setStep] = useState<1 | 2 | 3>(startAt);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');

  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canContinue = passphrase.length >= MIN_PASSPHRASE && confirm === passphrase;

  const create = async (): Promise<void> => {
    if (!canContinue || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await enableProtection(passphrase);
      setRecoveryKey(result.recoveryKey);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = (): void => {
    markProtectionEnabled();
    onDone();
  };

  const copyKey = (): void => {
    void navigator.clipboard?.writeText(recoveryKey);
  };

  const downloadKey = (): void => {
    const blob = new Blob([`Snug Recovery Key\n\n${recoveryKey}\n\nKeep this somewhere safe and offline.\n`], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'snug-recovery-key.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (step === 1) {
    return (
      <Card>
        <div className="hub-hero">
          <h1>protect this file?</h1>
          <p>
            your Snug file holds your apps, their data, your chats and your keys. right now anything running on this
            computer can read it. a passphrase scrambles the file so only you can open it — here, or on any other
            device you carry it to.
          </p>
        </div>
        {/* The cost, on the same screen as the offer. Never on a later one. */}
        <p className="hint">
          the trade: <strong>no one can reset a Snug passphrase</strong> — not us, not anyone. we will give you a
          Recovery Key as a second way in, and if you lose both, the data is gone for good.
        </p>
        <div className="field-row" style={{ marginTop: 'var(--space-3)' }}>
          <Button variant="primary" onClick={() => setStep(2)}>
            protect my file
          </Button>
          <Button onClick={() => (deferProtectOffer(), onDone())}>not now</Button>
          <Button onClick={() => (declineProtectOfferPermanently(), onDone())}>don&apos;t ask again</Button>
        </div>
      </Card>
    );
  }

  if (step === 2) {
    return (
      <Card>
        <div className="hub-hero">
          <h1>choose a passphrase</h1>
          <p>a phrase you will still remember in a year. longer beats complicated.</p>
        </div>
        <div className="field">
          <label htmlFor="vault-new">choose a passphrase</label>
          <div className="field-row">
            <input
              id="vault-new"
              type={reveal ? 'text' : 'password'}
              value={passphrase}
              autoFocus
              spellCheck={false}
              autoComplete="new-password"
              onChange={(event) => setPassphrase(event.target.value)}
            />
            <Button type="button" onClick={() => setReveal((on) => !on)}>
              {reveal ? 'hide' : 'show'}
            </Button>
          </div>
          {/* Length only. Composition rules do not make passphrases stronger in
              practice; they make them shorter, angrier and written on a note. */}
          <span className="hint">{tooShort ? `at least ${MIN_PASSPHRASE} characters` : 'at least 12 characters'}</span>
        </div>
        <div className="field">
          <label htmlFor="vault-confirm">confirm it again</label>
          <input
            id="vault-confirm"
            type={reveal ? 'text' : 'password'}
            value={confirm}
            spellCheck={false}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
          {mismatch ? <span className="hint">these do not match yet</span> : null}
        </div>
        {error !== '' ? (
          <p className="error-note" role="alert">
            {error}
          </p>
        ) : null}
        <div className="field-row" style={{ marginTop: 'var(--space-3)' }}>
          <Button variant="primary" disabled={!canContinue || busy} onClick={() => void create()}>
            {busy ? 'protecting…' : 'continue'}
          </Button>
          <Button onClick={() => setStep(1)}>back</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="hub-hero">
        <h1>save your Recovery Key</h1>
        <p>
          this is the <strong>only other way in</strong> if you forget your passphrase. we are showing it once, and we
          do not keep a copy.
        </p>
      </div>
      <p className="recovery-key" data-testid="recovery-key" style={{ fontFamily: 'monospace', fontSize: '1.1rem' }}>
        {recoveryKey}
      </p>
      <div className="field-row">
        <Button onClick={copyKey}>copy</Button>
        <Button onClick={downloadKey}>download</Button>
        <Button onClick={() => window.print()}>print</Button>
      </div>
      <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
        put it somewhere that is not this computer — a password manager, a printout in a drawer. a copy sitting next to
        the file it unlocks protects nobody.
      </p>
      <div className="field" style={{ marginTop: 'var(--space-3)' }}>
        {/* Mandatory acknowledgement — a checkbox since TASK-20260821-site-playground-
            polish AC5 (owner call; previously a typed phrase). The gate itself is
            unchanged: no acknowledgement, no way forward. */}
        <label className="check-label">
          <input
            type="checkbox"
            data-testid="vault-ack"
            checked={ack}
            onChange={(event) => setAck(event.target.checked)}
          />
          I saved my Recovery Key somewhere safe — not on this computer
        </label>
      </div>
      <div className="field-row" style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="primary" disabled={!ack} onClick={finish}>
          done
        </Button>
      </div>
    </Card>
  );
}
