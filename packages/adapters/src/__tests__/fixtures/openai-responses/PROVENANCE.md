# Recorded OpenAI Responses streams — provenance (TASK-20261023-siwc-chatgpt-plan; ADR-0071's provenance rule)

**RECORDED, not transcribed.** Captured 2026-10-23 21:28 UTC by the owner with the spike's `node spike.mjs capture` (`spikes/siwc/`, outside the repo; run summary `results/run-2026-10-23T21-28-32-735Z.json`) against `POST https://api.openai.com/v1/responses` on the owner's own ChatGPT plan: model `gpt-6.1-sol`, `store:false`, `stream:true`, `instructions` set, HTTP **200 with no `content-type` header** on all three (the AC12 finding, measured again).

| File | What it is | Bytes as received |
|---|---|---|
| `stream-text.sse` | a plain answer: `response.created` → `reasoning` item → `message` item with `output_text.delta`×N → `response.completed` (usage incl. `reasoning_tokens`) | 13 971 |
| `stream-toolcall-1.sse` | the first leg of a function-tool round trip: a `function_call` output item assembled from `function_call_arguments.delta`/`.done` | 9 259 |
| `stream-toolcall-2.sse` | the second leg: the full context resent with a `function_call_output` item, completing with text | 12 276 |

**One edit, applied identically to all three:** the value of `safety_identifier` (`user-…`, an account identifier OpenAI stamps on every `response` object) was replaced with `user-REDACTED`. Nothing else changed — byte order, event order, `prompt_cache_key`s and response ids are as received. The spike's leak gate and a second check at check-in found no bearer, no `eyJ…` token, no refresh token and no e-mail address in any stream.

A test that replays these byte-split (lesson L268, `stream-fidelity`) is the proof that the adapter's parser is honest about the real wire — a transcribed fixture can only prove it is honest about the docs.
