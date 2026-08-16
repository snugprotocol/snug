# trade-copilot — authoring provenance

**Baseline (v1, this folder's `app.html`):** not authored by prompts in this repo — it
is a byte-preserving port of the owner's hub-built "Coinbase Trade Copilot"
(`~/Snug/user.sqlite`, app `ef7c383a-c3fa…`, version 1, exported 2026-08-15). The
app-authored code (everything from the `RESPONSE_SCHEMA` banner down, 781 lines) is
verbatim; the embedded hooks block was replaced with the then-current
`packages/sdk/embedded/snug-hooks.js` reference because the original predated it.
The original build happened interactively in the hub — its durable record is the
per-app wiki the hub kept, shipped unmodified in `../docs/`.

**System-side assembly for later prompts in this folder:** the app-builder KB store at
the repo SHA each prompt file names in its own header
(`packages/knowledge/prompts/`, layers per `buildHostSystemPrompt` — see the store
README's assembly-order table).

Numbered files that follow (`01-…`, `02-…`) are the verbatim user-slot prompts used at
dev time for every change after the baseline, in order.
