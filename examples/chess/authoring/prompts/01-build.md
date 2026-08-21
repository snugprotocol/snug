*Reconstructed retrospectively (2026-08-21, TASK-20260821-hardening-polish): no verbatim prompt provenance exists for this starter — this page describes the build brief its code implies, so app-attached chat has honest context.*

# Build prompt — ember chess

The brief the shipped code implies, in the owner's voice:

---

Build a chess starter for the playground shelf that demonstrates the core Snug claim:
the app is a body, the agent is the mind. I play white; the host agent plays black.

No chess engine. Each time I move, send the agent the position as FEN, the recent
history, and — this is the important part — its complete list of legal moves, with a
`responseSchema` asking for `{move: {from, to}, message}`. The app must be the
referee: a compact in-app move generator decides legality, and if the agent replies
with an illegal move, or with something that isn't JSON at all, play a random legal
move on its behalf and say so honestly. If the request errors, give me a button to
poke it again.

Give the opponent a personality I can switch — a gracious rival, a trash talker, a
patient coach — that changes its table talk, not its strength. Show the talk in a
speech bubble beside the board, in character, one or two short lines.

Scope the rules to a compact demo referee: standard moves, captures, check, checkmate,
stalemate, automatic promotion to queen. Skip castling and en passant, and note the
cut in the source so nobody mistakes it for a bug.

Single file, React from the CDN allowlist, hook block copied exactly. Persist the game
— position, history, banter, chosen personality — so a reload resumes mid-match. Warm
board-café look, playable on a phone, following the host theme.
