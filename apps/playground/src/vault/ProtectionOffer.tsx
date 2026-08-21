// ProtectionOffer — the offer, inside the hub rather than in front of it.
//
// WHY THIS IS A BANNER AND NOT A SCREEN. It was a full-screen gate for about an hour.
// The e2e suite caught it: 24 specs timed out waiting for a starter tile, because a
// brand-new profile met "protect this file?" and never reached the shelf. The test
// failure was the symptom; the product defect is the real finding — asking someone to
// protect a file before they have seen a single app is asking them to value something
// they have not been shown yet.
//
// So: visible, honest, and skippable in one click, sitting above the shelf instead of
// replacing it. D3 asked for a PROMINENT offer, not a mandatory one, and prominence
// that blocks is just a modal with extra steps.
import { useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ProtectSetupFlow } from './ProtectSetupFlow.js';
import { deferProtectOffer, declineProtectOfferPermanently, useProtectOffer } from './protectOffer.js';

export function ProtectionOffer(): ReactElement | null {
  const offered = useProtectOffer();
  const [setupOpen, setSetupOpen] = useState(false);

  if (!offered) return null;
  // Once the user opts in, the flow DOES take the screen — at that point they have
  // asked for it, and each of its three steps is one idea deep.
  // Straight to the passphrase: the banner above IS step 1, and showing it again
  // would read as the app not having heard the click.
  if (setupOpen) return <ProtectSetupFlow startAt={2} onDone={() => setSetupOpen(false)} />;

  return (
    <Card>
      <div className="field" data-testid="protection-offer">
        <label>protect this file?</label>
        <span className="hint">
          your Snug file holds your apps, their data, your chats and your keys. right now anything running on this
          computer can read it. a passphrase scrambles it so only you can open it — here, or on any device you carry
          it to. <strong>no one can reset a Snug passphrase</strong>, so you get a Recovery Key as a second way in.
        </span>
        <div className="field-row">
          <Button variant="primary" onClick={() => setSetupOpen(true)}>
            protect my file
          </Button>
          <Button onClick={() => deferProtectOffer()}>not now</Button>
          <Button onClick={() => declineProtectOfferPermanently()}>don&apos;t ask again</Button>
        </div>
      </div>
    </Card>
  );
}
