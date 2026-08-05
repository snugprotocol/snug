# `prompts/` — the central layered prompt store (ADR-0004)

Every LLM-bound prompt in the Snug repo lives here. Nothing prompt-shaped may exist
anywhere else — a repo-level centralization lint enforces it. Loaders in
`packages/knowledge/src` expose each layer as a TYPED export (no generic string-keyed
loader); protocol constants are injected at load time and never retyped in prompt text.

## Tree

```
prompts/
├── README.md                        ← this map
├── system/                          ← host system prompt blocks, numbered by injection order
│   ├── 10-host-identity.md          ← always on
│   ├── 20-capability-file-creation.md  ← iff artifacts capability
│   ├── 30-app-builder-summary.md    ← iff app-builder capability (KB summary appended below it)
│   └── 40-app-response-format.md    ← iff app-builder capability
├── knowledge-base/
│   └── app-authoring/               ← the app-builder KB, section-searchable
│       ├── 00-summary.md            ← ~600-char blurb injected into the system prompt; NOT part
│       │                               of the searchable KB/search corpus (it duplicates content)
│       ├── 10-overview-and-contract.md
│       ├── 20-html-template.md      ← mandatory skeleton + copy-exactly SDK hooks
│       ├── 30-bridge-protocol.md
│       ├── 40-persistence-and-db.md
│       ├── 50-app-catalog.md        ← app types + worked chess example
│       ├── 60-design-quality.md
│       ├── 70-defensive-coding.md
│       └── 80-cdn-compatibility.md  ← incl. pinned known-good CDN table (DATA section)
├── tools/                           ← tool + parameter descriptions
│   ├── app-builder.md
│   └── artifact-write.md
├── skills/                          ← skill-builder prompts (workstream B)
│   ├── skill-creator/               ← VENDORED Anthropic skill-creator — verbatim, commit-pinned,
│   │                                   Apache-2.0 (LICENSE.txt + NOTICE.md); NO header comments here
│   ├── builder-preamble.md
│   └── modes/
├── templates/
│   └── user-identity.md             ← tenant template; runtime {{{triple-brace}}} placeholders only
└── ui/
    └── build-app-prompt.md          ← Playground user-message template + suggestion chips
```

## Layers

| Layer | Reaches the LLM as | Typed loader |
|---|---|---|
| `system` | Blocks of the host system prompt, in numeric order, capability-gated | `buildHostSystemPrompt({appBuilder, artifacts})` |
| `knowledge-base` | Tool results from `{{appBuilderToolName}}`; `00-summary.md` inline in the system prompt (excluded from search) | `searchKnowledge(query)` / `getKnowledgeSummary()` |
| `tool` | Tool + parameter descriptions in the request's tool list | per-tool exports |
| `skill` | Skill-builder prompts and the vendored skill-creator | `buildSkillBuilderPrompt(mode, ctx?)` |
| `template` | Tenant-rendered blocks (runtime data filled by the host) | template export + runtime render |
| `ui` | Client-composed USER messages (Playground) | ui exports |

## Assembly order (host system prompt)

1. `system/10-host-identity.md` — always.
2. `system/20-capability-file-creation.md` — iff artifacts enabled.
3. `system/30-app-builder-summary.md` + `knowledge-base/app-authoring/00-summary.md`
   (appended directly below, same block) — iff app-builder enabled. `00-summary.md` is
   served ONLY here: it is excluded from `getKnowledgeBase()` and the `searchKnowledge`
   corpus because it duplicates KB content and would pollute retrieval.
4. `system/40-app-response-format.md` — iff app-builder enabled.
5. Tenant blocks rendered from `templates/` (e.g. user identity) — runtime, optional.

Golden snapshots cover the 4-combination gating matrix; any edit to these files shows up in
the golden diff — that diff IS the blast radius review.

## Editing safely

**Mandatory header.** Every file here (EXCEPT vendored `skills/skill-creator/**`) starts
with the header comment — `layer` / `destination` / `blast-radius` / `source`. A walking
test fails on violations. Update `destination` when you move where the text is injected.

**Headings are retrieval-load-bearing.** `##`/`###` headings in `knowledge-base/` are split
points and keyword targets for `searchKnowledge`. Renaming, merging, or demoting a heading
changes what the LLM retrieves. Do not reformat casually; a test asserts heading stability.

**Placeholders — never retype wire literals.** The strict renderer resolves double-brace
placeholders from `packages/protocol` at load time; an unknown placeholder is an error, and
tests assert sources contain placeholders rather than literals:

| Placeholder | Renders to |
|---|---|
| `{{envelopeTag}}` | the app-request chat-envelope tag (`SNUG_APP_REQUEST_TAG`) |
| `{{appBuilderToolName}}` | the app-builder tool name (underscore form — MCP hosts reject dots) |
| `{{cdnAllowlist}}` | the fixed `CDN_ALLOWLIST`, joined |
| `{{protocolVersion}}` | `PROTOCOL_VERSION` (the wire `v` value) |
| `{{maxArtifactBytes}}` | `LIMITS.MAX_ARTIFACT_BYTES`, human-readable (e.g. `5 MB`) |
| `{{maxFrameKiB}}` | `LIMITS.MAX_FRAME_BYTES`, human-readable (e.g. `256 KiB`) |
| `{{maxParseFailures}}` | `LIMITS.MAX_PARSE_FAILURES` |
| `{{rawExcerptChars}}` | `LIMITS.RAW_EXCERPT_CHARS` |
| `{{frameType:<key>}}` | a `FRAME_TYPES` literal, e.g. `{{frameType:appMessage}}` |

**Runtime placeholders are triple-brace.** `{{{userName}}}`-style placeholders (see
`templates/user-identity.md`, `ui/build-app-prompt.md`) are IGNORED by the strict renderer
and substituted at runtime by the host/client with instance data. Repo files carry only the
template; real names/tones/ideas never enter the repo (ADR-0004).

**Copy-exactly code is contract.** The hook code in
`knowledge-base/app-authoring/20-html-template.md` is the SDK reference implementation — a
sync test locks it to `packages/sdk`. Never edit one side alone.

**How goldens catch you.** Content edits re-render into golden assembly snapshots and KB
section snapshots. A failing golden is not an obstacle — read the diff, confirm the blast
radius is intended, then update the snapshot in the same PR.

## Evals (next phase)

The prompt-eval harness will address prompts by their stable paths in this tree — keep file
paths stable; prefer editing content over renaming files. If a rename is unavoidable,
update loaders, goldens, and this README in the same change.

## External references

Read before authoring or restructuring anything in this tree — these are upstream guidance,
not Snug rules, so where they conflict with a hard constraint (C1–C5) or ADR-0004, this repo
wins. Treat them as the default technique unless there is a recorded reason to deviate.

| Reference | Use it for |
|---|---|
| [Anthropic — Best practices for prompt engineering](https://claude.com/blog/best-practices-for-prompt-engineering) | Authoring or revising any prompt layer here: system blocks, tool + parameter descriptions, KB sections, skill prompts. The canonical technique reference for this repo. |

Anything added to this table should be durable guidance a future session would want at
Gate 2 — not a one-off article. Version-specific or model-specific advice belongs in the
prompt file it applies to, next to the text it explains.
