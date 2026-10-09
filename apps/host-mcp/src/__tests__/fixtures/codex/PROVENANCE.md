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

**Logged-in `login status` lines — TRANSCRIBED, NOT recorded** (marked 2026-10-04, Gate 5
tests/F3). Only the logged-OUT `login status` above was ever run. The driver's `ready` rests on
the ChatGPT line alone (criterion B5), and every test that reaches `ready` feeds a
transcription of it — kept in `fake-codex-child.ts`, not in a file here:

| Constant | Line | Where it came from |
|---|---|---|
| `CODEX_LOGIN_STATUS_CHATGPT_TRANSCRIBED` | `Logged in using ChatGPT` (stderr, exit 0) | `run_login_status` in `codex-rs/cli/src/login.rs` at tag `rust-v0.160.0` (read 2026-10-04): `eprintln!("Logged in using ChatGPT")` on the `AuthMode::Chatgpt \| AuthMode::ChatgptAuthTokens` branch, then `exit(0)` |
| `CODEX_LOGIN_STATUS_API_KEY_TRANSCRIBED` | `Logged in using an API key - sk-proj-***ABCDE` (stderr, exit 0) | the same function's `AuthMode::ApiKey` branch: `eprintln!("Logged in using an API key - {}", safe_format_key(&api_key))` — the first 8 and last 5 characters around `***`; the key shown is invented in that shape |

The same function prints the RECORDED `Not logged in` with the same `eprintln!` and exit 1, which
is the one check the transcription has against reality. Used by: `brain-codex.test.ts`
(`LOGGED_IN`, which every logged-in driver test starts from, and the readiness and API-key
cases) and `brain-live.test.ts` (the walk's fake CLI). The owner's walk (criterion B7, step 1)
is the first time the line is seen printed: record it as `login-status-chatgpt.recorded.stdout`
/ `.stderr` and point `CODEX_LOGIN_STATUS_CHATGPT_TRANSCRIBED` at the files.
