# TASK-20260905-host-bindings-spikes: go/no-go spikes for the host bindings (T1 of TASK-20260904-skill-only-snug)

- **Status**: in-progress (started 2026-09-05 after the owner approved the program with defaults)
- **Owner**: Jeetu
- **Risk tier**: low — scratch probes under `scripts/spikes/` (deleted at Gate 6), no product code, no protocol, no sandbox change; the only durable output is numbers and decisions in this journal and in the parent record
- **Branch**: `feat/TASK-20260905-host-bindings-spikes` — stacked on `feat/TASK-20260904-skill-only-snug` (PR #171); rebases onto `main` when #171 merges
- **Packages touched**: none (scratch only); `docs/` (this file, the parent record, `lessons.md` at Gate 6)
- **Spec impact**: none
- **Related**: parent [TASK-20260904-skill-only-snug](TASK-20260904-skill-only-snug.md) (D2, D3, D11, D14 depend on these answers); ADR-0065 (proposed); the `artifact-capabilities` skill (runtime contract 0.2.41 — `sample.d.ts`, `artifact.d.ts`, `downloads.d.ts`, `db.d.ts`); `packages/runner/src/csp.ts` (`RUNNER_CSP`, "srcdoc documents also inherit the EMBEDDER's CSP"); `examples/chess/` (the envelope + runtime contract the probes use)

## Spec (what & why)

The program's design rests on facts about foreign hosts that no test in this repo can establish: whether a sandboxed srcdoc runner survives inside a Claude artifact, which CDNs a chat artifact may load from, how `sample.json` behaves as the envelope brain, whether the artifact's files-form publish holds a binary user file across the Artifact tool's own republish, and whether a Babel-pre-compiled React starter fits OpenClaw's 256 KB widget. Each spike is a **go/no-go with a pre-declared fallback** (never a third path invented on the spot). Spikes that need Hermes, OpenClaw or Codex installed (S5, S6, S8) are deferred to the start of T3, T5 and T9 — those tools are not on this machine and installing them is an owner act.

**Acceptance criteria** (one per spike; "passes" = the number or observation is journaled with a date and the decision it drives is written into the parent's D-list):

1. **S1 — nesting.** A hosted artifact (published from a file) whose page nests `<iframe sandbox="allow-scripts" srcdoc="…">` with an inline script that `postMessage`s to its parent, plus a `securitypolicyviolation` listener in both frames, and the same page pasted as a chat artifact. Pass: the child loads and the message arrives in both runtimes; the violation log names only what `RUNNER_CSP` itself forbids. Fail → D2's in-page mode for that runtime (`sandbox:'host'` disclosure).
2. **S2 — chat-artifact CDN.** From a chat artifact, load one script each from `cdn.jsdelivr.net/npm/…`, `cdn.jsdelivr.net/gh/…` and `cdnjs.cloudflare.com/…` and report which executed. Pass: at least one jsDelivr path. Fail → the chat bootstrap must come from cdnjs (owner act to get a listing) or A2 ships later.
3. **S3 — `sample` as the envelope.** A hosted artifact page that sends the Chess runtime contract + a real Chess envelope to `sample.json` as (a) one concatenated user turn and (b) two user turns, on `quick` and `default` tiers, 10 calls each, `cache:false`; records latency per call, first-try JSON validity, the consent prompt's position (first call only?), and cache behaviour when `state` changes. Pass: median `quick` ≤ 3 s and ≥ 9/10 first-try parses on at least one turn shape. Fail → `sample()` text + Snug's graduated parser; if still poor, A ships turn-based starters only.
4. **S4 — custody in a hosted artifact.** (a) files-form `artifact.publish({"data/user.snug": Blob})` of ~2 MB binary with an explicit content type (try `application/octet-stream`, then `application/vnd.sqlite3`, then a base64 `.txt`/`.json` wrapper if binary is refused); reload; a same-origin `fetch('data/user.snug')` restores byte-identical content. (b) The Artifact TOOL then republishes the page html — is `data/user.snug` still served? (c) `downloads.save({filename:'snug-user.snug.json', data})` is offered and accepted. (d) publish latency ≤ 5 s; the version history is readable. Pass: a–d. Fail on (a) or (b) → `artifact-html` (embedded base64, html republish); fail again → `artifact-db` chunks; last resort `localStorage` + export.
5. **S7 — widget size.** Babel-transform `examples/chess/app.html` host-side (`@babel/standalone` in Node, `presets: ['react']`), inline React + ReactDOM UMD, and measure the single file plus a stub micro-runner. Pass: ≤ 256 KB total. Fail → Binding C limited to starters authored without JSX/React.
6. **S9 — Cowork.** In Cowork: does the Artifact tool exist with `capabilities`, and can the sandbox download a GitHub Release asset? Pass: both. Fail → D11 flips to committed kits; A1 on Cowork rides the committed copy.
7. **S10 — chat-artifact storage and export.** In the same pasted page as S2: `window.storage` before and after publishing; whether `<a download>` or the clipboard works as an export path. Pass: a documented story. Fail → A2 ships as "in memory until published, export by copy" and says so.
8. **Deferred, recorded here for the ledger:** S5 (Hermes `:8642` + a `claude -p` shim through the playground's `local` mode — T3), S6 (OpenClaw `show_widget` round trip + approval count — T5), S8 (`codex exec --output-schema` shim — T9).

**Out of scope:** any product code; any change under `packages/` or `apps/`; publishing anything public (probe artifacts stay private and are unpublished at Gate 6); driving the owner's browser; installing Hermes / OpenClaw / Codex.

## Plan

### How results come back without copy-paste (D14)

Every hosted probe page declares `capabilities: {db: {}, …}` and writes its measurements to `results/<spike>` with `db.doc(...).set(...)`; the session reads them with the Artifact tool's `read_db` (`db_op: get`). The owner's part is: open the artifact once, click "run" where a viewer gesture is required (`sample` consent, `downloads.save`), and say "done". Chat probes (S2, S10) show their result on screen and the owner pastes the one-line JSON the page prints.

### Files (all scratch, all deleted at Gate 6)

- `scripts/spikes/s1-nesting.html` — outer page with a `securitypolicyviolation` log, a nested `allow-scripts` srcdoc child that posts `{hello:1}` up, a visible pass/fail, `db` write of `{childLoaded, messageArrived, violations[]}`. Published twice: as a hosted artifact (`capabilities: {db:{}}`) and as the S2/S10 chat page's first section.
- `scripts/spikes/s2-s10-chat.html` — three `<script src>` probes with `onload`/`onerror` flags (jsDelivr `/npm/` — a tiny known package; jsDelivr `/gh/` — a pinned file from this public repo; cdnjs — a known library), a `window.storage` probe (set → read → reload note; before/after publish), an `<a download>` and a clipboard button; prints a one-line JSON summary. The owner pastes it into claude.ai chat, opens it, publishes it, reopens it.
- `scripts/spikes/s3-sample.html` — declares `{sample:{}, db:{}}`; embeds `examples/chess/runtime-contract.json` rendered the way `renderRuntimeContract` does (copied text, not an import — scratch) and one canned Chess envelope from the KB's worked example; 4 arms × 10 calls (turn shape × tier), `cache:false`, `signal` per call, `onText` timestamps for first-token; parses each reply with a strict `JSON.parse` and records `{arm, i, ms, firstTokenMs, parsed, truncated, modelTierApplied, code?}`; a final arm re-sends arm (a) with `cache` default and a changed `state` to observe replay vs miss. Consent: the page notes at which call the prompt appeared.
- `scripts/spikes/s4-custody.html` — declares `{artifact:{}, downloads:true, db:{}}`; builds a 2 MB `Uint8Array` with a deterministic pattern + sha256; publishes it through the files form under each content type until one succeeds; reloads; fetches and hashes; offers `downloads.save`; writes `{contentTypeAccepted, publishMs, restoredSha, downloadOffered}`. Step (b) is performed by the session: republish the same html through the Artifact tool, then the owner reloads and the page re-checks `data/user.snug`.
- `scripts/spikes/s7-widget-size.mjs` — Node: read `examples/chess/app.html`, transform the `text/babel` block with `@babel/standalone` (`presets: ['react']`), replace the three CDN `<script src>` tags with the UMD bodies of `react@18`/`react-dom@18` fetched once into `scripts/spikes/vendor/` (gitignored), append a 6 KB stub "micro-runner" shell, write `scripts/spikes/out/chess-widget.html`, print byte counts per component and the total; run the same over every `examples/*/app.html` and print a table (which fit under 256 KB).
- `scripts/spikes/s9-cowork.md` — the owner's Cowork checklist (three questions, the exact commands to try, what to paste back).

### Order

S7 first (no owner needed; pure Node) → S1 + S4 published (owner opens both; results via `db`) → S3 published (owner opens, allows `sample`, runs the arms — ~10 minutes of wall time) → S2/S10 page handed to the owner for claude.ai chat → S9 checklist handed to the owner for Cowork. Numbers into the journal as they arrive; the parent's D2/D3/D11 lines updated in the same commit as each result.

### Test plan

Spikes carry no product tests. The verification standard is the pass condition per AC, recorded with: the artifact URL, the UTC time, the raw `db` document or pasted JSON, and the decision taken. Where a probe page has logic worth trusting (the sha256 round-trip in S4, the parser tally in S3), the page shows its own inputs so a wrong number cannot hide behind a green label (lesson 2026-08-20: assert the signal, not the API's return value; lesson 2026-07-31: use `securitypolicyviolation` events, never a call's success).

### Gate 6 obligations

Delete `scripts/spikes/`; unpublish the probe artifacts (or leave them private and list their URLs — owner's call); `lessons.md` gets one rule per surprise; the parent record's D-list and "Decisions & surprises" carry every number; `next-steps.md` untouched unless a spike created follow-up work.

## Decisions & surprises

- **2026-09-05 — incidental starter defect (not this task's to fix; queue in next-steps at Gate 6):** `examples/chess/runtime-contract.json`'s `responseGuidance` tells the model to reply `{"from","to","say"}`, while the app's `RESPONSE_SCHEMA` (rides in every envelope) and its reader (`app.html` ~line 580: `d.move.from`, `d.move.to`, `d.message`) expect `{move:{from,to}, message}`. A contract-obedient reply is handled as "it answered off-script — a legal move was played for it". The S3 probe tallies BOTH shapes so the finding gets a number (which instruction the model follows, per tier).
- **2026-09-05 — S7 RESULT: GO (widget binding can carry React starters).** `scripts/spikes/s7-widget-size.mjs` (Node 22; `@babel/standalone` 7.29.8, preset `react` only, no env pass, no source maps; react 18.3.1 = 10,751 B, react-dom 18.3.1 = 131,835 B, both from jsDelivr with versions read from `x-jsd-version`; a 6,555 B handshake-only stub micro-runner that nests the app in an `allow-scripts` srcdoc with `RUNNER_CSP` injected and posts a protocol-correct `snug:host-ready`). **Chess: 182,199 bytes / 182,100 chars — fits under 262,144 with ~80 KB of headroom**; Playwright chromium render check PASSED with the harness as the ONLY attempted request, 0 aborted, 0 console/page errors (pass rule requires the enforcement signal, not just a rendered root; the positive control is whatsapp's external chart.js tag, which the harness recorded as attempted AND aborted). **10 of 12 starters fit** (adventure-quest, chess, flying-pig, github, gmail, hue, ledger, quiz-me, spotify, weather); trade-copilot (270,460 B) and whatsapp (262,493 B + an un-inlined chart.js) do not; with a whitespace-compacted JS variant all 12 fit by size (only chess's compact variant was render-checked). **Fixed floor per widget = 149,243 B** (React + stub), leaving ~113 KB chars for the compiled app — and T5's real `WidgetBridge` + state-in-page shim will spend part of it. Caveats for T5: the sizes are the optimistic bound (in-browser `@babel/standalone` with no `data-presets` would also apply `env` + inline source maps — the pre-compile step must ship preset `react` only); the 256 KB cap's unit (bytes vs chars) is assumed from the docs and is verified only by S6. Full table: `scripts/spikes/out/s7-report.md` (scratch; the numbers here are the durable record).
- **2026-09-05 — Chromium observation from the S1 harness (headless, not yet the real artifact):** an embedder policy of `frame-src 'none'; child-src 'none'` did NOT stop an `about:srcdoc` child from loading in Chromium, while a missing `'unsafe-eval'` in the embedder's policy WAS inherited by the srcdoc child (the runner's own CSP grants it, the intersection does not). So what decides S1 in the real artifact is the viewer's actual CSP, which the probe records violation by violation, attributing each to the embedder or to `RUNNER_CSP`.
- **2026-09-05 — S3 fixture facts:** the exact runtime turn is 3,439 bytes of system text (`buildHostSystemPrompt({appRuntime:true})` + separator + `renderRuntimeContract`) + a 1,392-byte wire = 4,831 bytes per call, well under `sample`'s 65,536-byte input cap; the chess contract's `maxOutputTokens` is 512 but a schema-bearing wire is never bound by it (transport.ts lines 155–169).

## Session journal (append-only, newest last)

### 2026-09-05 00:40 UTC — Jeetu (via Claude Code) — session (Gate 1–2, created with the parent)
- Done: task file drafted from the parent's spike table; probe designs written; result loop through the artifact `db` chosen so the owner never pastes hosted results.
- State: planned; waits for the program's plan approval.
- Next step: `/pickup TASK-20260905-host-bindings-spikes` → branch → S7 → publish S1 + S4 → publish S3 → hand S2/S10 and S9 to the owner.
- Open questions: none beyond the parent's D-batch.

### 2026-09-05 03:50 UTC — Jeetu (via Claude Code) — session (Gate 3–4: probes authored)
- Done: branch cut (stacked on #171); `.gitignore` entries for `scripts/spikes/{vendor,out}/`; `scripts/spikes/fixtures.mjs` generates the exact Chess runtime system text + wire into `out/chess-fixtures.json`; `scripts/spikes/s9-cowork.md` written (both URLs verified: the release asset answers 302 → asset, jsDelivr `/gh/` answers 200); the four probe pages + the S7 script are being authored and adversarially verified by a workflow (two lenses each: contract conformance vs the 0.2.41 `.d.ts` files, measurement validity vs this file's pass conditions; fix; re-verify).
- State: waiting on the workflow; nothing published yet.
- Next step: publish S1 + S4 (private), run S7's report into this journal, publish S3, hand `s2-s10-chat.html` + `s9-cowork.md` to the owner.
- Open questions: none.

### 2026-09-05 05:45 UTC — Jeetu (via Claude Code) — session (probes published, owner walks handed over)
- Done: the four probe pages went through two workflow rounds (author → contract + measurement verifiers → fix → re-check → fix → final skeptic; 33 agents in all) plus two hand-applied final fixes (S3's "done" gate now refuses when the final db write FAILED; S4 stashes to sessionStorage BEFORE any db round trip) — both re-verified with the skeptics' Playwright harnesses. Published PRIVATE under the owner's account:
  - **S1** https://claude.ai/code/artifact/9b0182d2-3f6c-41c3-ab96-5d0b2323e948 (`capabilities {db}`) — nothing to click; done when the db line reads "wrote results/s1 … (final)".
  - **S4** https://claude.ai/code/artifact/59dfe0a8-cbc0-46de-9633-27c95e72f557 (`{artifact, downloads, db}`) — six-button walk; step 4 needs the session to republish the page (build tag r1 → r2) between the owner's clicks.
  - **S3** https://claude.ai/code/artifact/d5df9417-0781-435e-8da0-d995d7438507 (`{sample, db}`) — "run all arms" (48 calls, ~10–12 min, consent on call #1), then "done".
  - `scripts/spikes/s2-s10-chat.html` (160 lines, complete document) is attached to a claude.ai chat by the owner ("render verbatim"); four pastes back (draft/1, draft/2, published/1, published/2). `scripts/spikes/s9-cowork.md` is the Cowork checklist.
- State: S7 GO (journaled above). S1/S3/S4 await the owner's opens; S2/S10 and S9 await the owner's pastes. Nothing else blocks.
- Next step: read `results/s1`, `results/s4`, `results/s3` with `read_db` as the owner reports; republish S4 as r2 when told "verified"; fill `sessionChecks` on results/s4; journal every number; update the parent's D2/D3/D11.
- Open questions: none.

