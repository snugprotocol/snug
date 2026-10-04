# `sample` replies under contract 0.2.67 — where each file came from

The hosted artifact's brain (`brains/sample.ts`) and the graduated reply parser it feeds are
tested against these (`brains.test.ts`, TASK-20261003 R5 C4). Every reply string is
**recorded**: what Claude, through the artifact runtime's `sample`, answered in claude.ai.

**Measured by the owner, 2026-10-03, in claude.ai (Chrome 153, macOS)**, with the runtime probe
v3 (schema `snug-chat-probe/3`, 19,945 B — the page R5's C1 maintains as
`scripts/runtime-probe.html`) published as a private artifact; the runtime served contract
**0.2.67**. In both reports `claude.use()` resolved `sample`, `artifact`, `downloads`, `db`,
`user` and `permissions` (`assets`, `comments`, `files`, `mcp` and `room` answered `null`), and
`permissions.state()` read `artifact`, `db` and `downloads` granted, `sample` `prompt` in run 2
and `granted` in run 5; `sample.limits()` answered
`{ maxPromptBytes: 262144, tools: { maxCount: 16 } }`. The probe
posted each run as a report; the owner's reports were read back through the Artifact tool into
the session scratch directory and are NOT in git. Two of the five feed these fixtures:

| Fixture | Report (sha256 of the read-back) | What it holds |
|---|---|---|
| `chess-app-turn.musuyx9k.json` | `musuyx9k.json`, run 5, 2026-10-03T20:42:43Z (`7ba79e9a…9d263b22`) | The kit's REAL chess app turn (4,576 B, assembled from the built `knowledge` + `protocol` packages) sent through `sample` on `quick` and on `default`. `quick` answered a FENCED object with `from`/`to` at the top level (it followed the chess contract's `responseGuidance`); `default` answered BARE JSON with `move: { from, to }` (the envelope's schema). |
| `terse-instruction-and-ladder.musuq7g5.json` | `musuq7g5.json`, run 2, 2026-10-03T20:37:18Z (`2e7350b7…d41c7564`) | `json`: the 802-character prose reply `quick` gave a terse "Reply with exactly this JSON and nothing else: {…}" — it read the instruction as an embedded-command test and declined in prose. `ladder`: the cap ladder — 8,192, 65,536 and 262,144 bytes each answered with both markers echoed (`HEAD-…\nTAIL-…`), and 262,145 bytes refused `prompt_too_large` in 1 ms. |

**Trimmed, never edited.** Kept per report: `schema`, `at`, `limits`, and per reply the fields a
test reads (`tier`, `tierApplied`, `form`, `shape`, `len`, `truncatedFlag`, `firstMs`, `ms`,
`reply`, and for the ladder `bytes`, `outcome`, `code`, `message`). Dropped: the page facts
(origin, frame host, user agent, capability map) — they describe the viewer, not a reply.
Every kept string is byte-identical to the report's (checked when the files were written).

**The prose reply is stored as the probe kept it.** The probe records a long reply as its first
700 characters (`reply`) and its last 160 (`replyEnd`) beside the full length (`len`: 802).
700 + 160 − 802 = 58: the two pieces overlap by exactly 58 characters, and they do —
`reply` ends with the 58 characters `replyEnd` begins with — so the whole reply is the head
plus the tail after its first 58 characters, determined by the record, not guessed. The test
rebuilds it that way and asserts the length is 802 before using it.

The contract's own type definitions (`sample.d.ts` 0.2.67, sha256 `8e312a7e…148ee591` —
`SampleErrorCode`, `limits()`, `modelTierApplied`) were read from the same session; `brains.test.ts` quotes the
`SampleErrorCode` union verbatim and cites the file and the version.
