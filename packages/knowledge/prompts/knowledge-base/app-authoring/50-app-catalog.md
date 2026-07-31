<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM matches a user idea to an app type or builds a game; reachable only when the app-builder capability is enabled
blast-radius: which app archetypes get built and how — the chess example is the canonical worked pattern many generations copy
source: rewritten for Snug v0.1 from ancestor KBs (internal/05); app-type catalog carried from the richer ancestor
-->

# App Catalog

## Choosing an App Type

Match the user's idea to an archetype, then apply its guidance. Every archetype uses the
same template and hooks; they differ in what rides in `state`, what the `responseSchema`
asks for, and how much logic lives in the app vs the agent.

| Archetype | Examples | Agent's role |
|---|---|---|
| Board games | Chess, Checkers, Connect Four, Tic-tac-toe, Go | Opponent: pick a legal move, add commentary |
| Card games | Blackjack, Poker, Memory match | Opponent/dealer + banter |
| Word games | Hangman, 20 Questions, Word chain | Word source, guesser, or judge |
| Puzzles | Sudoku hints, crossword clues, riddles | Hint/clue generator |
| Education | Quiz builder, flashcard trainer, language tutor | Content generator + grader |
| Trackers | Workout log, habit tracker, budget | Coach + SQL analyst over the app DB |
| Data tools | CSV analyzer, chart builder | SQL author + insight writer |
| Creative | Story builder, drawing prompts, music ideas | Co-author |
| Simulations | Game of Life, ecosystem sim | Commentator + scenario author |

## Per-Type Guidance

### Games (board, card, word)

- The APP enforces the rules deterministically in JavaScript: legal-move generation, win
  detection, turn order. The AGENT only chooses among options and talks. Never let the
  agent be the rules engine — validate every agent move before applying it, and re-request
  (once) with an `illegal_move` action naming the rejected move if validation fails.
- Represent game state compactly and canonically (see the chess example) so requests stay
  small and the agent reasons well.
- Include difficulty in state (`'easy' | 'medium' | 'hard'`) and let the schema tell the
  agent to play accordingly.

### Trackers and data tools

- SQL tier (`useAppDB`) for records; key-value tier for UI preferences.
- Lead with the "agent writes SQL against your schema" pattern from "Persistence and the
  App Database" — it is the killer feature of a tracker.
- Ship a small amount of demo/sample data behind an obvious "load sample data" button so
  the app is not an empty shell on first open.

### Education and creative

- Batch content generation: ask for 10 flashcards in one request (an array in the
  responseSchema), not 10 requests.
- Grade locally when the answer is objective; send to the agent when judgment is needed.
- Stream (`opts.onStream`) for long-form creative text so the user watches it appear.

## Worked Example: Chess

The canonical board-game build. Key decisions:

### State: FEN plus history

Keep the board as a FEN string — compact, standard, unambiguous to the agent — plus a move
list in algebraic notation:

```javascript
const [game, setGame] = usePersistedState('chess-state', {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  moveHistory: [],                    // ['e4', 'e5', 'Nf3', ...]
  captured: { player: [], ai: [] },
  status: 'playing',                  // 'playing' | 'check' | 'checkmate' | 'draw'
  playerColor: 'white',
  difficulty: 'medium',
});
```

Implement the chess rules in plain JavaScript in the app (board array + move generation +
check detection + FEN serialization), or load a known-good UMD chess library from the
pinned table in "CDN Compatibility". The app decides legality; the agent just picks moves.

### Response schema for moves

```javascript
const RESPONSE_SCHEMA = {
  kind: "string: 'move' | 'resign'",
  move: { from: 'string square, e.g. "e7"', to: 'string square, e.g. "e5"',
          promotion: "string (optional): 'q' | 'r' | 'b' | 'n'" },
  message: 'string: in-character commentary on the position (ALWAYS include)',
};
```

### The request

```javascript
const result = await sendMessage('player_move', { move: { from, to } }, {
  state: game,                        // FEN + history + difficulty — fully self-contained
  responseSchema: RESPONSE_SCHEMA,
});
if (result.ok && result.data.kind === 'move') {
  if (isLegalMove(game.fen, result.data.move)) {
    applyMove(result.data.move, result.data.message);
  } else {
    retryOnceWithIllegalMoveNotice(result.data.move);
  }
}
```

### AI-personality prompt tips

Personality rides in the schema and state, not in extra prose turns:

- Put a persona line in state: `persona: 'a cheerful grandmaster who teaches while playing'`
  and say in the schema's `message` description: "stay in character as state.persona".
- Tie strength to `difficulty` in the schema description: "at difficulty 'easy', prefer
  plausible but suboptimal moves and explain simply".
- Render `message` prominently (a speech bubble next to the board) — the commentary is half
  the fun of playing an AI.
