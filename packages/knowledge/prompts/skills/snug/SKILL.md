<!--
layer: skill
destination: emitted as skills/snug/SKILL.md inside the Snug plugin by scripts/lib/skill-build.mjs — this store header is stripped, the launch-protocol marker is replaced by apps/host-mcp/src/instructions.md (headings demoted), and the app-authoring knowledge base is rendered beside it as references/. EXCLUDED from content.ts by gen-content.mjs, so no runtime bundle carries it (ADR-0069 §7, ADR-0065 D6)
blast-radius: whether an agent that installed the Snug plugin knows what a Snug app is, how to find or start the runner, where to read the authoring rules, and what it must never do — the marketplace-facing entry point of the whole skill-delivered program (ADR-0065, ADR-0069)
source: written for TASK-20260913-binding-b-marketplace-plugin; the launch section is apps/host-mcp/src/instructions.md verbatim
-->
---
name: snug
description: "Build and run Snug apps: single-file micro apps that live in the user's own file and think through their agent. Use whenever the user wants an app, game, tracker, tool or dashboard built."
license: MIT
metadata:
  homepage: https://snugprotocol.org
  repository: https://github.com/snugprotocol/snug-skill
---

# Snug

A Snug app is ONE self-contained HTML file. It runs in a sandboxed runner, keeps its state
through the runner's storage, and MAY think through the user's own agent at runtime — a
chess game asks for a move, a tutor asks for feedback, a tracker asks a question about its
own data. The user owns the app and everything it accumulates: both live in one file the
user keeps, and the runner supplies the intelligence. You build the app; the runner shows it
to the user and keeps their data.

## Find or start the runner

Pick the runner by the tools you have, in this order:

1. **You have `snug_status`, `snug_open`, `snug_hand_in` and `snug_list_apps`** — the local
   runner. Follow *The local runner* below. This is the full Snug: the user's file is on
   their disk, apps can hold approved connections to real APIs, and thinks run on the
   user's own Claude CLI.
2. **No Snug tools, but an `Artifact` tool that takes `capabilities`** — the artifact
   runner. Follow *The artifact runner* below. Apps think on the viewer's own Claude; there
   are no connections; the file lives in the artifact.
3. **Neither** — tell the user, in one line, how to get the plugin (see *No runner*), and
   stop. Do not build an app nobody can run.

### The local runner

<!-- launch-protocol -->

### The artifact runner

- Find the artifact titled `Snug` (list the user's artifacts). If there is none, publish
  `assets/snug-host.html` from this skill as a PRIVATE artifact titled `Snug`, favicon 🔥,
  with `capabilities: { sample: {}, artifact: {}, downloads: true }`.
- To hand an app in, embed its bundle in the page and republish: read the artifact's page,
  run `node scripts/snug-embed.mjs <page.html> --bundle <app.json> --out <page.html>`, then
  publish the result to the same artifact. The runner installs it on the next load.
- Tell the user in one line where it is: "Your Snug runner is open here: <url>. Your app is
  in it under *your apps*."
- Never claim a connection inside an artifact: the page cannot reach the network, and a
  bundle that asks for one is refused.

### No runner

Say: "Snug needs its plugin. In Claude Code or Claude Desktop run
`/plugin marketplace add snugprotocol/snug-skill`, then `/plugin install snug@snug-skill`,
and start a new session." Then stop.

## Build the app

Read the references in this order before you write a line — the template's hooks must be
copied exactly, and an app that invents them does not run:

1. `references/10-overview-and-contract.md` — what an app is, the loop, the hard rules.
2. `references/20-html-template.md` — the mandatory skeleton and the copy-exactly hooks.
3. `references/30-bridge-protocol.md` — how an app asks the agent and reads the reply.
4. `references/40-persistence-and-db.md` — the storage every app must use (never localStorage).
5. `references/80-cdn-compatibility.md` — the libraries an app may load, and from where.

Then, when they apply:

- `references/50-app-catalog.md` — choosing the app type; a complete worked example.
- `references/60-design-quality.md` and `references/70-defensive-coding.md` — before you
  call it done.
- `references/90-auth-and-connected-apis.md` — ONLY when the app calls an external API,
  and only on the local runner.
- `references/95-runtime-contract.md` — when the app thinks: the contract that shapes every
  runtime turn.

Write the ENTIRE file, every time. An edit is a new whole document handed in over the same
lineage, never a patch.

## Hand the app in

A hand-in is a `snug-app-bundle/1` document. The minimum that installs:

```json
{
  "format": "snug-app-bundle/1",
  "lineage": "<a UUID you mint once per app and reuse for every edit of it>",
  "sharedAt": "<now, as an ISO instant ending in Z>",
  "app": { "displayName": "Chess", "description": "Play chess against the agent", "iconEmoji": "♟️", "usesDb": true },
  "html": "<!doctype html>…the whole app…",
  "connections": []
}
```

- `lineage` is what ties an edit to the app it edits: keep it per app, so an update lands
  on the right app instead of installing a second copy.
- `usesDb` is true when the app persists anything through the runner's storage.
- `contract` (the runtime contract from `references/95-runtime-contract.md`) rides in the
  bundle when the app thinks; `schema.ddl` may carry `CREATE` statements only — structure
  travels, rows never.
- `connections` is always `[]`. The user grants access, not you: on the local runner the
  user opens the app's own connections door and picks the provider; your app addresses its
  connection by name as `references/90-auth-and-connected-apis.md` shows. Tell the user
  that is the next step when the app needs one. Inside an artifact there are no
  connections at all.

## Where the user's data lives

Say it once, plainly, the first time you hand an app in:

- Local runner: "Your apps and their data are in `~/Snug/user.snug` on this Mac. Nothing is
  uploaded."
- Artifact runner: "Your apps and their data are in this artifact, which Anthropic hosts;
  you can export them any time from the *your file* chip."

## Never

- Never put an API key, token or password in app code, and never ask the user for one to
  paste into an app. Connections are made in the runner, by the user.
- Never run `claude` or any model yourself to answer an app's think. The runner does that,
  on the user's own CLI.
- Never describe the runner as an MCP server or Snug as built on MCP. Say: Snug apps run
  inside Claude Code / Cowork.
- Never persist through `localStorage`, `sessionStorage` or cookies: the sandbox drops them.
