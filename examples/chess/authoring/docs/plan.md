# Plan

Built in three layers, referee-first (shipped with the playground hub,
TASK-20260731-playground-hub; requests leaned out in TASK-20260811, ADR-0018):

1. **The referee** — a compact legal-move generator in about 120 lines: FEN
   parse/serialise, per-piece pseudo-moves (sliders walk rays, knights jump, pawns
   push and capture), attack detection, the legal filter that discards any move
   leaving its own king in check, mate/stalemate from an empty reply list, and
   auto-queen promotion. Castling and en passant are cut on purpose, and the source
   says so.
2. **The conversation** — one action, `player_move`. The payload carries derived facts
   (`yourColor`, the full `yourLegalMoves` list, the persona id); `state` carries the
   situation once (FEN plus the last 12 plies); `RESPONSE_SCHEMA` asks for
   `{move: {from, to}, message}`. The reply is checked against the app's own list — a
   miss plays a random legal move with an honest note; an error leaves a "poke the
   agent" retry. The persona prose itself lives in `runtime-contract.json`.
3. **The table** — single-file React over the mandatory hook block: an 8×8 button grid
   (44 px touch targets; dots, rings and highlights for targets, selection, last move
   and check), a status pill, the table-talk bubble with persona avatar and chips, the
   move rail, and new game. The whole game is one
   `usePersistedState('ember-chess-game')` object — FEN, history, capped banter,
   result, personality — so a reload resumes mid-match; theme follows the host.

Test spine: `examples/validate.test.mjs` — the per-app single-file/CDN and hook-block
byte-sync checks, the agent-driven posture check (sendMessage + responseSchema + a
schema-valid runtime contract), and the chess-specific lean-request regression ("sends
its board state ONCE"); `starterRuntimeContract.test.ts` for contract seeding at
install; `starterMeta.test.ts` for `starter.json`; and the Playwright passes that use
chess as their fixture app — `no-server`, `dedup`, `mobile` (375 px board), and
`owner-report` (a chess move proving BYOK frames reach the inspector).
