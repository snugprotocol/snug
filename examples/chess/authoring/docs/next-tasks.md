# Next tasks

- Castling and en passant — the two declared engine gaps. The referee and the
  advertised `yourLegalMoves` list grow together, so the agent side needs no change.
- Draw rules the referee cannot yet see: threefold repetition and the fifty-move rule
  (`toFen` hard-codes the clocks to `0 1`), plus insufficient-material detection.
- Promotion choice — auto-queen is the only option today; underpromotion needs a
  picker and a promotion field in the response schema.
- Honour or drop the schema's `gameOver`/`winner` fields: the app detects mate and
  stalemate itself and never reads them, so today they are dead schema text the model
  is asked to fill for nothing.
- A play-black option with board flip — the user is currently hard-coded as white.
- Move history in SAN: the rail renders `e2→e4` arrows, fine at a glance, unreadable
  as a game record to replay or share.
