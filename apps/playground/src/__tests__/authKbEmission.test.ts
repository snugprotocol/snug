// AL-05 (TASK-20260806-auth-kb) AC4b: the emission format the KB TEACHES is the
// format the playground's real scanner FINDS — cross-package, no copies. The KB's
// rendered example rides a realistic builder reply that also carries a competing
// non-directive fenced json block BEFORE the directive (first-valid-wins probed),
// and a directive-free reply with ordinary fenced JSON scans to null (never-case).
//   M52: break the scanner's fence candidate path → the taught format stops being
//        found → RED. (Evidenced against the scanner, not the fixture.)
//   M57: give the never-case reply a directive → the null assertion → RED.
//
// P2 (TASK-20260810-p2-pipeline): the KB now teaches the `connection_requirement`
// directive, so this test follows it. The GUARANTEE is unchanged and still cross-package
// with no copies — the KB's own rendered example is fed to the real scanner — and it is
// now strictly stronger, because the successor schema validates the full requirement
// (fields, header template, registration copy) rather than a three-key hint. The v3
// `auth_wizard` path itself is untouched and still scans; its retirement is P4's item.
import { describe, expect, it } from 'vitest';
import { getKnowledgeBase } from '@snugprotocol/knowledge';
import { CONNECTION_REQUIREMENT_DIRECTIVE_KIND } from '@snugprotocol/protocol';

import { scanForRenderDirective } from '../agent/renderDirective.js';

const KB_AUTH_FILE = 'knowledge-base/app-authoring/90-auth-and-connected-apis.md';

/** The KB's canonical rendered directive example (P2: the three-value Coinbase example). */
function kbExampleBlock(): string {
  const doc = getKnowledgeBase().find((d) => d.file === KB_AUTH_FILE);
  expect(doc, `${KB_AUTH_FILE} missing from the knowledge base`).toBeDefined();
  const blocks = [...doc!.text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]!.trim());
  expect(blocks.length).toBeGreaterThanOrEqual(1);
  return blocks[0]!;
}

/** Ordinary fenced JSON a closing reply plausibly carries — parseable, NOT a directive. */
const COMPETING_JSON_BLOCK = [
  '```json',
  '{"kind": "string: \'move\' | \'game_over\'", "message": "sample RESPONSE_SCHEMA fragment"}',
  '```',
].join('\n');

describe('AC4b — the KB-taught emission format round-trips the real scanner', () => {
  it('finds and validates the taught directive in a realistic reply, past an earlier non-directive json block', () => {
    const reply = [
      "your weather dashboard is ready. it answers the app's runtime requests with JSON like:",
      COMPETING_JSON_BLOCK,
      'it needs a provider connection before live data will flow:',
      '```json',
      kbExampleBlock(),
      '```',
      'review and approve it in the connect card above.',
    ].join('\n\n');

    const scan = scanForRenderDirective(reply);
    expect(scan).not.toBeNull();
    expect(scan).not.toHaveProperty('malformed');
    if (scan !== null && 'directive' in scan) {
      expect(scan.directive.kind).toBe(CONNECTION_REQUIREMENT_DIRECTIVE_KIND);
      if (scan.directive.kind === CONNECTION_REQUIREMENT_DIRECTIVE_KIND) {
        expect(scan.directive.requirement.provider.name).toBe('Coinbase Exchange');
        // The re-admitted seats survive the KB→scanner round trip. This is the half the
        // v3 assertion could not make: a three-key hint had nothing to check.
        expect(scan.directive.requirement.fields?.map((f) => f.key)).toEqual([
          'api_key',
          'api_secret',
          'passphrase',
        ]);
      }
    }
  });

  it('never-case: a directive-free reply with ordinary fenced JSON scans to null — no card, no note (M57)', () => {
    const reply = [
      'your to-do list app is ready — data persists on the device through the host.',
      COMPETING_JSON_BLOCK,
      'try adding your first item.',
    ].join('\n\n');

    expect(scanForRenderDirective(reply)).toBeNull();
  });
});
