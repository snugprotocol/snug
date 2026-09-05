// TASK-20260905-host-bindings-spikes — S3 fixtures: the EXACT system text and wire a
// runtime Chess turn carries in the playground (apps/playground/src/agent/transport.ts
// lines 108–169), so the sample() probe measures reality, not an approximation.
// Scratch: deleted at Gate 6. Run from the repo root after `pnpm build`.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const knowledge = await import(require.resolve('@snugprotocol/knowledge', { paths: [process.cwd() + '/apps/playground'] }));
const protocol = await import(require.resolve('@snugprotocol/protocol', { paths: [process.cwd() + '/apps/playground'] }));
const { buildHostSystemPrompt, renderRuntimeContract, SYSTEM_BLOCK_SEPARATOR } = knowledge;
const { buildAppRequest, parseRuntimeContract } = protocol;

const contract = parseRuntimeContract(readFileSync('examples/chess/runtime-contract.json', 'utf8'));
if (contract === undefined) throw new Error('examples/chess/runtime-contract.json did not parse against runtimeContractSchema');

const baseSystem = buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true, platform: 'web' });
const system = `${baseSystem}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`;

// Position after 1.e4 e5 2.Nf3 — black to move; the app sends every legal reply.
const RESPONSE_SCHEMA = {
  move: { from: "string: square the piece moves from, e.g. 'e7'", to: "string: square it moves to, e.g. 'e5'" },
  message: 'string: one or two short lines of in-character table talk about the position (ALWAYS include)',
  gameOver: 'boolean (optional): true only if you believe the game just ended',
  winner: "string (optional): 'player' | 'ai' | 'draw'",
};
const legal = [
  ['b8','a6'],['b8','c6'],['g8','e7'],['g8','f6'],['g8','h6'],['f8','e7'],['f8','d6'],['f8','c5'],['f8','b4'],['f8','a3'],
  ['d8','e7'],['d8','f6'],['d8','g5'],['d8','h4'],['e8','e7'],
  ['a7','a6'],['a7','a5'],['b7','b6'],['b7','b5'],['c7','c6'],['c7','c5'],['d7','d6'],['d7','d5'],['f7','f6'],['f7','f5'],['g7','g6'],['g7','g5'],['h7','h6'],['h7','h5'],
].map(([from, to]) => ({ from, to }));
const envelope = {
  appId: 'chess',
  instanceId: '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  requestId: 'req-000',
  action: 'player_move',
  payload: { yourColor: 'black', yourLegalMoves: legal, personality: 'ember' },
  state: { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', moveHistory: ['e4', 'e5', 'Nf3'] },
  responseSchema: RESPONSE_SCHEMA,
};
const wire = buildAppRequest(envelope);

mkdirSync('scripts/spikes/out', { recursive: true });
writeFileSync('scripts/spikes/out/chess-system.txt', system);
writeFileSync('scripts/spikes/out/chess-wire.txt', wire);
writeFileSync('scripts/spikes/out/chess-fixtures.json', JSON.stringify({ system, wire, contract, maxOutputTokens: contract.maxOutputTokens }, null, 2));
console.log('system bytes', Buffer.byteLength(system), '| wire bytes', Buffer.byteLength(wire), '| total', Buffer.byteLength(system) + Buffer.byteLength(wire));
