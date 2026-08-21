// ReleaseNotesSheet — the starter's cumulative changelog, rendered for the person who
// will decide whether to take an update (TASK-20260820-starter-updates, ADR-0045 §8).
//
// The data is the bundle's `starter.json` (via `starterUpdateStatus`), so the sheet can
// show releases NEWER than the copy the user is on — that is the point: "new" entries
// are the pitch for the update button, the "installed" tag anchors where they are now.
// Nothing here writes; the one write act stays on the update button in the header.

import type { ReactElement } from 'react';

import type { StarterUpdateStatus } from '../starter/starterUpdate.js';
import { Button } from '../ui/Button.js';

export interface ReleaseNotesSheetProps {
  status: StarterUpdateStatus;
  onClose: () => void;
}

export function ReleaseNotesSheet({ status, onClose }: ReleaseNotesSheetProps): ReactElement {
  return (
    <div className="net-confirm-overlay" role="dialog" aria-modal="true" aria-label="release notes">
      <div className="net-confirm-card release-notes-card">
        <div className="release-notes-head">
          <h2 className="net-confirm-title">release notes</h2>
          <Button variant="ghost" aria-label="close release notes" onClick={onClose}>
            ✕ close
          </Button>
        </div>
        <div className="release-notes-scroll">
          {status.meta.changelog.map((entry) => (
            <section key={entry.version} className="release-entry">
              <div className="release-entry-head">
                <h3 className="release-entry-title">
                  v{entry.version}
                  {entry.title !== undefined ? ` — ${entry.title}` : ''}
                </h3>
                <span className="release-entry-date">{entry.date}</span>
                {entry.version === status.installedVersion ? (
                  <span className="release-tag" data-testid={`release-installed-v${entry.version}`}>
                    installed
                  </span>
                ) : entry.version > status.installedVersion ? (
                  <span className="release-tag release-tag-new" data-testid={`release-new-v${entry.version}`}>
                    new
                  </span>
                ) : null}
              </div>
              {entry.sections.map((section) => (
                <div key={section.title} className="release-section">
                  <h4 className="release-section-title">{section.title}</h4>
                  <ul className="release-section-items">
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
