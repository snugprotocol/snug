/**
 * AuthChoiceCard — "this provider has more than one way in; you pick"
 * (TASK-20260812-auth-kind-choice, D4/AC8).
 *
 * GATED ON THE LIVE ROW, not on the message that mounted it: the card reads the
 * connection row at render (re-reading on every wizard revision) and shows NOTHING
 * unless the row is `declared` with non-`user` provenance. Anything else — the user
 * already chose, the row is approved, the row is gone — would make every button here a
 * dead re-bind that Gate 5 silently no-ops: the F4 silence class this lineage kills.
 *
 * WHERE OPTIONS COME FROM (the doorbell rule): a registry provider's options are read
 * from the PINNED REGISTRY right here at render — the seed contributed nothing but the
 * (appId, slot) pointer, so no message payload can add, remove, or relabel an option.
 * Only an unregistered provider renders its (re-admitted) inference alternatives.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { CONNECTION_STATUS, canonicalRequirementHash } from '@snugprotocol/protocol';
import type { ConnectionRow } from '@snugprotocol/db';
import { lookupWellKnownProvider, requirementFromRegistryEntry } from '@snugprotocol/auth';

import type { AuthChoiceSeed } from '../agent/authChoiceCard.js';
import { chooseAuthOption } from '../state/authKindChoice.js';
import { connectionWizardRevisionStore } from '../state/connectionWizard.js';
import { getUserDb } from '../state/userdb.js';
import { useStore } from '../state/store.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';

/** Plain-language option labels for inference alternatives (no registry copy exists). */
const KIND_LABELS: Record<string, string> = {
  api_key: 'API key',
  bearer_token: 'Access token',
  basic_auth: 'Username & password',
  oauth2_client_creds: 'Service credentials',
  oauth2_auth_code: 'Sign in with your account (OAuth)',
  none: 'No credentials needed',
};

interface CardOption {
  id: string;
  label: string;
  requirement: unknown;
  hash: string;
}

export function AuthChoiceCard({ choice }: { choice: AuthChoiceSeed }): ReactElement | null {
  const revision = useStore(connectionWizardRevisionStore);
  // undefined = still loading (render nothing yet, honestly); null = no row.
  const [row, setRow] = useState<ConnectionRow | null | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getUserDb().then((db) => {
      if (!alive) return;
      setRow(db.getConnection(choice.appId, choice.slot) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [choice.appId, choice.slot, revision]);

  if (row === undefined || row === null) return null;
  if (row.status !== CONNECTION_STATUS.declared || row.provenance === 'user') return null;

  const entry = lookupWellKnownProvider(choice.providerName);
  const options: CardOption[] =
    entry !== undefined
      ? (entry.authOptions ?? []).length === 0
        ? []
        : [
            {
              id: 'default',
              label: entry.optionLabel ?? 'Standard setup',
              requirement: requirementFromRegistryEntry(entry, choice.providerName, choice.slot),
              hash: canonicalRequirementHash(requirementFromRegistryEntry(entry, choice.providerName, choice.slot)),
            },
            ...(entry.authOptions ?? []).map((option) => {
              const requirement = requirementFromRegistryEntry(entry, choice.providerName, choice.slot, option);
              return { id: option.id, label: option.label, requirement, hash: canonicalRequirementHash(requirement) };
            }),
          ]
      : (choice.alternatives ?? []).map((alternative, index) => ({
          id: `alt-${index}`,
          label: KIND_LABELS[alternative.kind] ?? alternative.kind,
          requirement: alternative,
          hash: canonicalRequirementHash(alternative),
        }));
  if (options.length === 0) return null;

  const currentHash = canonicalRequirementHash(row.requirement);
  const pick = (requirement: unknown): void => {
    setNote(null);
    void chooseAuthOption({ appId: choice.appId, slot: choice.slot, requirement }).then((outcome) => {
      // A refused choice must say so — the old row stands and the user hears why (F4 rule).
      if (!outcome.ok) setNote(outcome.message);
    });
  };

  return (
    <Card className="artifact-card" data-testid="auth-choice-card">
      <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
        🔀
      </span>
      <span className="artifact-name">{choice.providerName} offers more than one way to connect</span>
      <div className="field" role="group" aria-label={`choose how to connect ${choice.providerName}`}>
        {options.map((option) => (
          <div key={option.id} className="field-row" data-testid={`auth-choice-${option.id}`}>
            <span>{option.label}</span>
            {option.hash === currentHash ? (
              <span className="hint">current</span>
            ) : (
              <Button variant="ghost" onClick={() => pick(option.requirement)}>
                use this
              </Button>
            )}
          </div>
        ))}
      </div>
      {note !== null ? (
        <div className="error-note" role="alert" data-testid="auth-choice-error">
          {note}
        </div>
      ) : null}
    </Card>
  );
}
