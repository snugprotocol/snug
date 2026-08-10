// TASK-20260810-p2-pipeline — FOLD of the three-lens review. The P2 fold's regression
// suite for the BLOCKER every lens found independently: the pipeline was built at
// `artifactSink.write()` but NO production caller ever reached it, and the AC2 gate
// therefore refused every real connected build.
//
// WHY THESE TESTS LOOK DIFFERENT FROM connectionPipeline.test.ts. That file constructs
// the options bag by hand (`sink.write(html, title, { reply })`) — which is exactly how
// an unwired seam reports green. Everything here drives the PRODUCTION shapes instead:
//   - the real `artifact_write` tool from `agent/tools.ts` (all non-webllm modes),
//   - the real post-turn finalizer `finalizeConnectionDeclaration` (where the reply text
//     actually exists), which is the seam the wiring now uses.
//
// THE ORDERING FACT THAT DROVE THE FIX. `artifact_write` is a MID-TURN tool call; the KB
// (90-auth-and-connected-apis.md) instructs the model to emit the directive AFTER the app
// write, as the closing fenced block of the reply. So the reply text — and therefore the
// directive — does not exist when `write()` runs. Threading `reply` into `write()` could
// never have worked; the declaration has to land in a POST-TURN step. That is what this
// file pins, in both directions.

import { describe, expect, it } from 'vitest';
import { CONNECTION_REQUIREMENT_DIRECTIVE_KIND, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { createAppTargetSink } from '../agent/artifactSink.js';
import { finalizeConnectionDeclaration } from '../agent/connectionPipeline.js';
import { buildByokTools, ARTIFACT_WRITE_TOOL_NAME } from '../agent/tools.js';
import { installTestUserDb } from './userdbTestHelper.js';

const SLOT = 'coinbase';

/** Connected HTML — it calls the ONE hook that reaches an external host. */
const CONNECTED_HTML =
  '<!doctype html><html><body><script>const { fetch: f } = useConnectedFetch("coinbase");</script></body></html>';

const PLAIN_HTML = '<!doctype html><html><body><h1>Tic Tac Toe</h1></body></html>';

const coinbaseRequirement = {
  slot: SLOT,
  provider: { name: 'Coinbase Exchange', docsUrl: 'https://docs.cdp.coinbase.com/exchange' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API Key', type: 'text', required: true },
    { key: 'api_secret', label: 'API Secret', type: 'secret', required: true },
    { key: 'passphrase', label: 'Passphrase', type: 'secret', required: true },
  ],
  registration: {
    consoleUrl: 'https://exchange.coinbase.com/profile/api',
    instructions: ['Open Profile then API.', 'Create a key with View permission.'],
  },
  request: {
    headerTemplate: {
      'CB-ACCESS-KEY': '{{api_key}}',
      'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
      'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
      'CB-ACCESS-SIGN':
        '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
    },
  },
  declaredApiHosts: ['api.exchange.coinbase.com'],
} as const;

/** A build reply in the shape the KB teaches: prose, then ONE closing fenced directive. */
function replyWithDirective(requirement: unknown = coinbaseRequirement): string {
  return [
    'I built the tracker. It needs your Coinbase Exchange key before it can load balances.',
    '',
    '```json',
    JSON.stringify({ v: PROTOCOL_VERSION, kind: CONNECTION_REQUIREMENT_DIRECTIVE_KIND, requirement }),
    '```',
  ].join('\n');
}

function toolsFor(sink: ReturnType<typeof createAppTargetSink>, written: { id?: string }) {
  return buildByokTools(sink, {
    onArtifact: (artifact) => {
      written.id = artifact.id;
    },
  });
}

async function runArtifactWrite(
  sink: ReturnType<typeof createAppTargetSink>,
  content: string,
  title: string,
): Promise<{ result: string; appId: string | undefined }> {
  const written: { id?: string } = {};
  const tool = toolsFor(sink, written).find((t) => t.def.name === ARTIFACT_WRITE_TOOL_NAME);
  if (tool === undefined) throw new Error('artifact_write tool not found');
  const result = await tool.run({ content, title });
  return { result: typeof result === 'string' ? result : String(result), appId: written.id };
}

// ------------------------------------------------------- the regression the review found

describe('P2 FOLD — the pipeline is reachable from the PRODUCTION caller', () => {
  it('the real artifact_write tool saves a CONNECTED app (the AC2 gate must not refuse the shipping path)', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });

    // The exact production call shape: content + title, no options bag. Before the fold
    // this threw ConnectedBuildRejected and the turn failed.
    const { result, appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');

    expect(result).toContain('Created');
    expect(result).not.toContain('Error');
    expect(appId).toBeDefined();
    expect(db.getApp(appId!)?.displayName).toBe('Coinbase Tracker');
    await db.close();
  });

  it('the post-turn finalizer lands the declared row from the reply text — before first run', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });

    const { appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');
    expect(db.listConnections(appId!)).toEqual([]); // mid-turn: no directive exists yet

    // POST-TURN: the reply text now exists, and this is the seam that sees it.
    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: CONNECTED_HTML,
      reply: replyWithDirective(),
      channel: 'inference',
    });

    expect(outcome).not.toBeUndefined();
    expect(outcome!.ok).toBe(true);
    expect(outcome!.ok === true && outcome!.action).toBe('created');

    const row = db.getConnection(appId!, SLOT);
    expect(row).toBeDefined();
    expect(row!.status).toBe('declared');
    expect(row!.provenance).toBe('inference');
    expect(row!.requirement.provider.name).toBe('Coinbase Exchange');
    await db.close();
  });

  it('a plain, non-connected build declares nothing and finalizes to undefined', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });

    const { result, appId } = await runArtifactWrite(sink, PLAIN_HTML, 'Tic Tac Toe');
    expect(result).toContain('Created');

    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: PLAIN_HTML,
      reply: 'Here is your tic tac toe game. No connection needed.',
      channel: 'inference',
    });
    expect(outcome).toBeUndefined();
    expect(db.listConnections(appId!)).toEqual([]);
    await db.close();
  });

  it('a v3 auth_wizard directive is NOT a requirement — the B1 cutover keeps both surfaces apart', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });
    const { appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');

    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: CONNECTED_HTML,
      reply: ['```json', JSON.stringify({ v: PROTOCOL_VERSION, kind: 'auth_wizard', spec: {} }), '```'].join('\n'),
      channel: 'inference',
    });

    // Not a connection_requirement ⇒ this pipeline declines it and leaves it to the v3 path.
    expect(outcome === undefined || outcome.ok === false).toBe(true);
    expect(db.listConnections(appId!)).toEqual([]);
    await db.close();
  });
});

// ------------------------------- the AC2 gate, re-sited where `declared` can be populated

describe('P2 FOLD — the connected-build gate reports at the seam that can see the reply', () => {
  it('connected HTML with NO directive is reported as unconnectable, and the app still saves', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });
    const { appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');

    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: CONNECTED_HTML,
      reply: 'Here you go! It pulls your balances live.',
      channel: 'inference',
    });

    // The user's HTML is never discarded over a model's missing declaration — but the
    // condition IS surfaced, so a connected-but-unconnectable app is never silent.
    expect(outcome).toBeDefined();
    expect(outcome!.ok).toBe(false);
    expect(outcome!.ok === false && outcome!.reason).toBe('connected_html_without_requirement');
    expect(db.getApp(appId!)).toBeDefined();
    expect(db.listConnections(appId!)).toEqual([]);
    await db.close();
  });

  // The MAJOR the testability lens raised: presence-only gating means a directive that
  // PARSES but is refused at persist yields a saved connected app with zero rows. That is
  // the deliberate contract (do not lose the user's work) — but it must be SURFACED and
  // it must be pinned, in both refusal modes.
  it('a directive refused by the TEMPLATE LINT surfaces a refusal and writes no row', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });
    const { appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');

    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: CONNECTED_HTML,
      reply: replyWithDirective({
        ...coinbaseRequirement,
        request: { headerTemplate: { 'CB-ACCESS-SIGN': '{{md5(api_secret)}}' } },
      }),
      channel: 'inference',
    });

    expect(outcome!.ok).toBe(false);
    expect(outcome!.ok === false && outcome!.reason).toBe('template_lint_failed');
    expect(db.getApp(appId!)).toBeDefined(); // the user's work survives
    expect(db.listConnections(appId!)).toEqual([]);
    await db.close();
  });

  it('a directive refused by ADMISSION (registry borrow) surfaces a refusal and writes no row', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: async () => db });
    const { appId } = await runArtifactWrite(sink, CONNECTED_HTML, 'Coinbase Tracker');

    const outcome = await finalizeConnectionDeclaration(db, {
      appId: appId!,
      html: CONNECTED_HTML,
      // A well-known provider name with hosts the registry does not pin: the borrow ban.
      reply: replyWithDirective({
        ...coinbaseRequirement,
        slot: 'spotify',
        provider: { name: 'Spotify' },
        kind: 'oauth2',
        declaredApiHosts: ['evil.example'],
        request: { headerTemplate: { Authorization: 'Bearer {{api_key}}' } },
      }),
      channel: 'inference',
    });

    expect(outcome!.ok).toBe(false);
    expect(db.getApp(appId!)).toBeDefined();
    expect(db.listConnections(appId!)).toEqual([]);
    await db.close();
  });
});
