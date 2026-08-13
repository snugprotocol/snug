// The SHIPPED hue manifest, driven through the production gates (AC8).
//
// WHY THIS FILE EXISTS AT ALL, and why it reads the real bytes rather than a
// fixture (lesson 2026-08-08): every other suite that touches this manifest
// either injects one (`starterDeclaration` uses `__setDeclarationManifestsForTests`,
// whose injected branch returns BEFORE the production glob is reached) or
// validates it as JSON against a schema (`examples/connection-manifests`). Neither
// answers the question a user's first click asks — "when this starter installs,
// does a working connection row appear?" — because a manifest can satisfy the
// schema perfectly and still be REFUSED by admission, which is the gate that
// stands between the file and the row.
//
// That refusal is the specific hazard here. Hue's manifest borrows a registry
// brand on the `starter` channel, and Guard 2b refuses a borrowing channel that
// authors `fields` or `request`. A well-meaning edit adding a `fields` array
// "so the user knows what to expect" would produce a manifest that passes every
// other suite in the repo and installs an app whose connection can never be
// created — with nothing on screen to explain it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connectionRequirementSchema, deriveConnectionAllowedHosts } from '@snugprotocol/protocol';
import { admitConnectionRequirement } from '@snugprotocol/auth';

/** apps/playground → repo root → examples/hue-lights-party/connection.json */
const MANIFEST_PATH = path.resolve(process.cwd(), '..', '..', 'examples', 'hue-lights-party', 'connection.json');

function shippedManifest(): unknown {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

describe('the shipped hue-lights-party manifest', () => {
  it('parses as a v4 connection requirement', () => {
    const parsed = connectionRequirementSchema.safeParse(shippedManifest());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it('is ADMITTED on the starter channel — the gate a bare manifest must survive', () => {
    const parsed = connectionRequirementSchema.parse(shippedManifest());
    const admitted = admitConnectionRequirement(parsed, { channel: 'starter' });
    expect(admitted.ok, admitted.ok ? '' : admitted.issues.map((i) => `${i.path}: ${i.message}`).join('; ')).toBe(true);
  });

  it('admission SUBSTITUTES the registry seats the manifest deliberately omits', () => {
    // The other half of "bare": omitting the seats is only correct because the
    // registry fills them. If substitution stopped happening, the manifest would
    // still be admitted and the row would carry no header template at all — a
    // connection that pairs and then sends the key nowhere.
    const parsed = connectionRequirementSchema.parse(shippedManifest());
    const admitted = admitConnectionRequirement(parsed, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const requirement = admitted.requirement as {
      fields?: Array<{ key: string }>;
      request?: { headerTemplate?: Record<string, string> };
      lanHost?: { class: string };
    };
    expect(requirement.fields?.map((field) => field.key)).toEqual(['application_key']);
    expect(requirement.request?.headerTemplate).toEqual({ 'hue-application-key': '{{application_key}}' });
    // …and the LAN seat SURVIVES substitution: it is what makes the wizard show an
    // address step instead of an approve button.
    expect(requirement.lanHost?.class).toBe('rfc1918-ipv4-literal');
  });

  it('derives an EMPTY ceiling before collection — which is why the wizard order is binding', () => {
    // Stated as an outcome rather than a comment: a row approved at this moment
    // would freeze a ceiling that refuses every host, forever, silently. The
    // address step exists to make that state unreachable.
    const parsed = connectionRequirementSchema.parse(shippedManifest());
    expect(deriveConnectionAllowedHosts(parsed)).toEqual([]);
  });

  it('is refused if it authors a credential-prompt seat (the edit this pin exists to catch)', () => {
    // The mutation, written as a test: a manifest that "helpfully" declares its
    // own fields is refused by Guard 2b, and would install an app whose
    // connection can never be created.
    const parsed = connectionRequirementSchema.parse({
      ...(shippedManifest() as Record<string, unknown>),
      fields: [{ key: 'application_key', label: 'Bridge key', type: 'secret' }],
    });
    const admitted = admitConnectionRequirement(parsed, { channel: 'starter' });
    expect(admitted.ok).toBe(false);
  });
});
