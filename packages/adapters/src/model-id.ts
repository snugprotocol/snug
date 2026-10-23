// model-id.ts — the one shape a model id must have before it is stored or sent
// (TASK-20261023-siwc-chatgpt-plan D6, AC8; C5: validate at the settings boundary). Moved here
// from the host runner's `brains/brain.ts` so the browser-safe playground can import it; the
// runner keeps its copy with a source-parity test until it migrates (next-steps).
//
// Leading alphanumeric, then letters, digits, `.`, `_`, `:`, `[`, `]` and `-`, at most 200
// characters — enough for every vendor's ids (`gpt-6.1-sol`, `claude-sonnet-4-5`,
// `qwen2.5:7b`) and nothing a URL path, a shell, or a header could be hurt by: no whitespace,
// no control characters, no slashes.

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,199}$/;

export const isModelId = (value: unknown): value is string => typeof value === 'string' && MODEL_ID_PATTERN.test(value);
