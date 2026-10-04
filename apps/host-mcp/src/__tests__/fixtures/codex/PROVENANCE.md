# Codex fixtures — where each file came from

The `codex` brain driver (ADR-0071) is tested against these. Two kinds, and the file name
says which:

**`*.recorded.*` — captured from the real CLI.** `codex-cli 0.160.0`, run on 2026-10-03 from a
scratch directory with its own `CODEX_HOME`, **logged out**; nothing was installed into the
owner's machine and no model call succeeded.

| File | Command |
|---|---|
| `login-status.recorded.stdout` / `.stderr` | `codex login status` (exit 1; the line is on stderr, stdout is empty) |
| `features-list.recorded.txt` | `codex features list` |
| `exec-logged-out.recorded.jsonl` / `.stderr` | `codex exec --json … -` (exit 1 after ~15 s of retries) |

**`debug-models-bundled.trimmed.json` — recorded, then trimmed.** `codex debug models --bundled`
prints 659 KB (each model carries its whole base instructions). Kept per model: `slug`,
`display_name`, `visibility`, `priority`, `default_reasoning_level`,
`supported_reasoning_levels` — the fields the driver reads. Nothing was edited.

**`*.transcribed.jsonl` — NOT recorded.** A successful turn needs the owner's ChatGPT login,
which this task never had. These streams were written by hand from the upstream event
definitions (`codex-rs/exec/src/exec_events.rs` at 0.160.0: `ThreadEvent`, `ThreadItem`,
`ThreadItemDetails`, `Usage`), so they are right about the SHAPE the CLI documents and prove
nothing about what a real turn emits. The owner's logged-in walk (criterion B7) replaces
them with recordings; until then the driver is `verified: false`.
