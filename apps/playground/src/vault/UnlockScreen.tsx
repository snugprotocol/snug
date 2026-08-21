// UnlockScreen — the door to a protected Snug file (TASK-20260820, ADR-0043).
//
// THE PERSON THIS IS FOR. They opened Snug and it asked for a passphrase. Almost
// always they know it and mistyped it. Occasionally they genuinely cannot remember,
// and this screen is the moment they find out whether that is survivable.
//
// So the design does three things, in this order of importance:
//
//   1. TELL THE TRUTH EARLY. "No one can reset this" appears BEFORE they are stuck,
//      not after they have tried nine times and started bargaining. Learning it late
//      feels like a trap; learning it up front feels like custody.
//   2. KEEP THE COMMON CASE CALM. A wrong passphrase is a typo, not an incident. No
//      red alarm, no attempt counter, no lockout — the words "corrupt", "damaged" and
//      "lost" never appear, because none of them is true and all of them frighten.
//   3. PUT THE SECOND KEY WHERE DESPAIR HAPPENS. The Recovery Key is one quiet click
//      away, on the screen where someone realises they need it.
//
// And one thing it deliberately does NOT do: offer any escape that destroys data.
// There is no "start fresh" here. At 1am a tired person will click whatever ends the
// friction, and this screen must never be the thing that lets them trade a decade of
// their own data for relief.
import { useState, type FormEvent, type ReactElement } from 'react';

import { unlockUserDb } from '../state/userdb.js';
import { Button } from '../ui/Button.js';

type Mode = 'passphrase' | 'recovery';

export function UnlockScreen(): ReactElement {
  const [mode, setMode] = useState<Mode>('passphrase');
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const usingRecovery = mode === 'recovery';
  const trimmed = usingRecovery ? value.trim() : value;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await unlockUserDb(usingRecovery ? { recoveryKey: trimmed } : { passphrase: trimmed });
    // On success the status store flips to 'ready' and App swaps this screen out, so
    // there is nothing to do here but stop spinning if it did not.
    if (!ok) setFailed(true);
    setBusy(false);
  };

  const switchTo = (next: Mode): void => {
    setMode(next);
    setValue('');
    setFailed(false);
    setReveal(false);
  };

  return (
    <div className="shell">
      <main className="shell-main">
        <div className="hub-hero" data-testid="userdb-locked">
          <h1>your file is protected</h1>
          <p>
            {usingRecovery
              ? 'enter the Recovery Key you saved when you turned protection on.'
              : 'enter your passphrase to open it. everything is exactly where you left it.'}
          </p>
        </div>

        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="vault-secret">{usingRecovery ? 'Recovery Key' : 'passphrase'}</label>
            <div className="row">
              <input
                id="vault-secret"
                type={reveal || usingRecovery ? 'text' : 'password'}
                value={value}
                autoFocus
                autoComplete={usingRecovery ? 'off' : 'current-password'}
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                  setFailed(false);
                }}
              />
              {/* A long passphrase typed blind is the most common reason a CORRECT one
                  "does not work". Revealing it is a kindness, not a risk, on a screen
                  the owner is already sitting in front of. */}
              {!usingRecovery ? (
                <Button type="button" onClick={() => setReveal((on) => !on)}>
                  {reveal ? 'hide' : 'show'}
                </Button>
              ) : null}
            </div>
          </div>

          {failed ? (
            <p className="error-note" role="alert">
              that {usingRecovery ? 'Recovery Key' : 'passphrase'} did not open this file. try again — nothing has
              changed, and your file is untouched.
            </p>
          ) : null}

          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            <Button type="submit" variant="primary" disabled={busy || trimmed.length === 0}>
              {busy ? 'opening…' : 'unlock'}
            </Button>
            <Button type="button" onClick={() => switchTo(usingRecovery ? 'passphrase' : 'recovery')}>
              {usingRecovery ? 'use my passphrase instead' : 'use my Recovery Key instead'}
            </Button>
          </div>
        </form>

        {/* Said here, plainly, while they can still act on it — not after they are
            stuck. This is the whole trade they accepted when they turned protection
            on, and repeating it honestly is what makes the trade fair. */}
        <p className="hint" style={{ marginTop: 'var(--space-4)' }}>
          Snug cannot reset this for you and no one else can either — not us, not anyone. that is what keeps the file
          yours. if the passphrase is gone, the Recovery Key is the other way in.
        </p>
      </main>
    </div>
  );
}
