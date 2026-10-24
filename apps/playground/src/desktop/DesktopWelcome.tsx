// DesktopWelcome — the one-screen desktop first run (TASK-20260812 P3 item 1; the third card
// TASK-20261023-siwc-chatgpt-plan §12 L5-1).
//
// One idea per screen: where should the AI part live? Two or three big choices and a skip,
// nothing else. ZERO JARGON is a contract here — no "BYOK", no "LLM", no "endpoint", no "OAuth",
// no "token"; the happy path speaks in things a person owns (your computer, a key, a file, a
// plan you already pay for). The Ollama choice is enabled only when the platform probe actually
// found models, and the ChatGPT-plan card exists only where the shell carries the custody seat —
// offering a button that cannot work is the failure this screen exists to avoid.
//
// THE PLAN CARD DOES NOT CHOOSE THE MODE (L5-1). "Continue with ChatGPT" starts the sign-in and
// the Welcome stays, in an awaiting state with a visible cancel (AC2); only a sign-in that came
// back `ok` sets the mode and finishes the first run — a mode set before that would leave a
// person who cancelled on a brain that refuses every turn. A named failure is said under the
// card it came from; the other two cards stay live.
//
// ANOTHER CHOICE CANCELS A PENDING SIGN-IN (Gate 5 G5-A9). The keeper keeps a sign-in open for ten
// minutes; a person who picks another card or skips while the browser is still out has decided, so
// the pending sign-in is cancelled first — and a completion that lands late anyway (the browser
// finished a moment after) is not allowed to set the mode over that later choice: only the sign-in
// attempt the Welcome is still waiting on may finish the first run.

import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { getPlatform } from '../platform/platform.js';
import { cancelChatgptSignIn, signInToChatgpt, useChatgptSignInPending } from '../state/chatgptPlan.js';
import { setMode } from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ExternalLink } from '../ui/ExternalLink.js';
import { ChatgptButton } from './ChatgptButton.js';
import { ChatgptSignInWait } from './ChatgptSignInWait.js';
import { completeDesktopFirstRun } from './firstRun.js';

const OLLAMA_SITE = 'https://ollama.com';

export function DesktopWelcome(): ReactElement {
  const ollama = useOllama();
  const navigate = useNavigate();
  const models = ollama !== 'unknown' && ollama.running ? ollama.models : [];
  const localReady = models.length > 0;
  // Static for the life of the shell (D10): the seat is the desktop's, present or not from boot.
  const planSeat = getPlatform().chatgptPlan !== undefined;
  const signingIn = useChatgptSignInPending();
  const [planFailure, setPlanFailure] = useState<string | undefined>(undefined);
  /** The sign-in attempt the Welcome is waiting on; another choice moves past it, so a late completion finds itself stale. */
  const attempt = useRef(0);

  /** The person chose something else (or skipped): whatever sign-in is still out is cancelled and may no longer choose the mode. */
  const abandonPlanSignIn = (): void => {
    attempt.current += 1;
    void cancelChatgptSignIn();
  };

  const chooseLocal = (): void => {
    abandonPlanSignIn();
    setMode('local');
    completeDesktopFirstRun();
  };

  const chooseServiceKey = (): void => {
    abandonPlanSignIn();
    setMode('byok');
    completeDesktopFirstRun();
    navigate('/settings');
  };

  const skip = (): void => {
    abandonPlanSignIn();
    completeDesktopFirstRun();
  };

  const choosePlan = (): void => {
    setPlanFailure(undefined);
    const mine = ++attempt.current;
    void signInToChatgpt().then((result) => {
      if (mine !== attempt.current) return; // the person chose otherwise meanwhile — this completion is not theirs to act on
      if (result.ok) {
        // The hub is where the one-time notice shows (AC11) — no navigate to Settings.
        setMode('chatgpt');
        completeDesktopFirstRun();
        return;
      }
      setPlanFailure(result.message);
    });
  };

  return (
    <div data-testid="desktop-welcome">
      <div className="hub-hero">
        <h1>welcome</h1>
        <p>Snug runs on your computer. Your data stays in one file that belongs to you.</p>
      </div>

      <p className="hint" style={{ margin: '0 0 var(--space-3)' }}>
        one thing to pick: how should your apps think? You can change this any time in settings.
      </p>

      <div className="tile-grid">
        <Card>
          <div className="field">
            <Button
              variant="primary"
              data-testid="welcome-local"
              disabled={!localReady}
              onClick={chooseLocal}
            >
              use your computer&apos;s AI
            </Button>
            {localReady ? (
              <span className="hint">
                {models.length} {models.length === 1 ? 'model' : 'models'} found on this computer — free, private,
                and nothing to sign up for.
              </span>
            ) : (
              <span className="hint">
                Install Ollama (free) to run AI without an account —{' '}
                {/* The side-effect-free system-browser seat (`openExternalUrl`), never the OAuth opener,
                    which binds a pending flow's loopback listener (ui/ExternalLink.tsx). */}
                <ExternalLink href={OLLAMA_SITE} data-testid="welcome-ollama-link">
                  ollama.com
                </ExternalLink>
                . Come back here when it&apos;s installed.
              </span>
            )}
          </div>
        </Card>

        <Card>
          <div className="field">
            <Button variant="primary" data-testid="welcome-service-key" onClick={chooseServiceKey}>
              use an AI service key
            </Button>
            <span className="hint">
              paste a key from an AI service you already use — it stays in your file, on this computer.
            </span>
          </div>
        </Card>

        {planSeat ? (
          <Card>
            <div className="field">
              {signingIn ? <ChatgptSignInWait /> : <ChatgptButton data-testid="welcome-chatgpt-plan" onClick={choosePlan} />}
              <span className="hint">
                use your ChatGPT plan — sign in with the ChatGPT account you already have. the sign-in stays on this
                computer, outside your file.
              </span>
              {planFailure !== undefined ? (
                <span className="error-note" role="alert" data-testid="welcome-chatgpt-failure">
                  {planFailure}
                </span>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="ghost" data-testid="welcome-skip" onClick={skip}>
          I&apos;ll look around first
        </Button>
      </div>
    </div>
  );
}
