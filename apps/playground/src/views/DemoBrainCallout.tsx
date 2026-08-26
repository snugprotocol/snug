// DemoBrainCallout — the one-time first-contact note (TASK-20260826, ADR-0059).
//
// Inline and dismissible, NEVER a gate: it sits above the builder chat, says what
// the demo brain is in one breath, and offers the two exits — the settings door
// (which latches on the way out; navigating to add a key IS engagement) and a
// plain "keep poking". Copy is shared with the brain chip so the product tells one
// story; the honesty sentence is the byte-pinned BYOK claim (ADR-0059 rule 4).
// Once a real brain is active this renders nothing regardless of the latch — the
// ambient chip carries the story from then on.

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useActiveBrain } from '../state/activeBrain.js';
import { dismissDemoCallout, useDemoCallout } from '../state/demoCallout.js';
import { Button } from '../ui/Button.js';
import { BYOK_HONESTY_COPY, DEMO_BRAIN_BODY } from './BrainChip.js';

export function DemoBrainCallout(): ReactElement | null {
  const brain = useActiveBrain();
  const eligible = useDemoCallout();
  if (brain !== 'demo' || !eligible) return null;
  return (
    <div className="demo-brain-callout" data-testid="demo-brain-callout" role="note">
      <div className="demo-brain-callout-text">
        <strong>you’re on the demo brain 🧪</strong>
        <span>
          {DEMO_BRAIN_BODY} poke around freely — then bring your own AI to build with real answers and real data.
        </span>
        <span className="hint">{BYOK_HONESTY_COPY}</span>
      </div>
      <div className="demo-brain-callout-actions">
        <Link
          to="/settings"
          className="btn btn-primary"
          data-testid="demo-callout-settings"
          onClick={() => dismissDemoCallout()}
        >
          use my own AI
        </Link>
        <Button variant="ghost" data-testid="demo-callout-dismiss" onClick={() => dismissDemoCallout()}>
          keep poking
        </Button>
      </div>
    </div>
  );
}
