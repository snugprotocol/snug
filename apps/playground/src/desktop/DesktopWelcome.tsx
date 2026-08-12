// DesktopWelcome — the one-screen desktop first run (TASK-20260812 P3 item 1).
//
// One idea per screen: where should the AI part live? Two big choices and a skip,
// nothing else. ZERO JARGON is a contract here — no "BYOK", no "LLM", no "endpoint";
// the happy path speaks in things a person owns (your computer, a key, a file).
// The Ollama choice is enabled only when the platform probe actually found models —
// offering a button that cannot work is the failure this screen exists to avoid.

import type { MouseEvent, ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { getPlatform } from '../platform/platform.js';
import { setMode } from '../state/mode.js';
import { useOllama } from '../state/ollama.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { completeDesktopFirstRun } from './firstRun.js';

const OLLAMA_SITE = 'https://ollama.com';

export function DesktopWelcome(): ReactElement {
  const ollama = useOllama();
  const navigate = useNavigate();
  const models = ollama !== 'unknown' && ollama.running ? ollama.models : [];
  const localReady = models.length > 0;

  const chooseLocal = (): void => {
    setMode('local');
    completeDesktopFirstRun();
  };

  const chooseServiceKey = (): void => {
    setMode('byok');
    completeDesktopFirstRun();
    navigate('/settings');
  };

  /** Prefer the shell's system-browser opener; the href keeps the link honest. */
  const openOllamaSite = (event: MouseEvent<HTMLAnchorElement>): void => {
    const opener = getPlatform().oauth?.openExternal;
    if (opener !== undefined) {
      event.preventDefault();
      void opener(OLLAMA_SITE);
    }
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
                <a
                  href={OLLAMA_SITE}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="welcome-ollama-link"
                  onClick={openOllamaSite}
                >
                  ollama.com
                </a>
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
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <Button variant="ghost" data-testid="welcome-skip" onClick={() => completeDesktopFirstRun()}>
          I&apos;ll look around first
        </Button>
      </div>
    </div>
  );
}
