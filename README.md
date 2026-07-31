# Snug — the Snug Protocol

> **MCP connects agents to tools. Snug connects agents to apps.**

Snug is an open protocol that lets users of any web app build **tiny AI-native apps** ("micro apps" — games, trackers, tools) through conversation with the app's own AI assistant. Snug apps are different from anything a code generator produces:

1. **The app's brain is the host agent.** A Snug chess game doesn't embed a chess engine — it sends moves to the host LLM through a standard postMessage envelope and animates the reply. The app is a *body*; the agent is the *mind*.
2. **Users own their apps and their data.** Each app gets an isolated database, exportable as a real `.sqlite` file you can download, back up, or move. Not a vendor's cloud rows — a file you own.
3. **It's embeddable.** Any product can drop the runner + SDK in and let *their* users build micro apps powered by *their* existing AI assistant.

This is the **reference implementation monorepo**: protocol bindings, iframe runner, in-app SDK, per-app database, LLM knowledge base, agent adapters, the hosted Playground, and example apps. The protocol specification lives in [`snugprotocol/spec`](https://github.com/snugprotocol/spec).

> 🚧 **Pre-launch.** This repo is private while v1 is built. See `docs/next-steps.md` for status.

## Repo layout

| Path | What it is |
|---|---|
| `packages/protocol` | `@snugprotocol/protocol` — typed envelope bindings; **source of truth for spec schemas** |
| `packages/runner` | `@snugprotocol/runner` — sandboxed iframe runner + bridge host |
| `packages/sdk` | `@snugprotocol/sdk` — in-app hooks: `useAgentBridge`, `useAppDB`, `useConnection` |
| `packages/db` | `@snugprotocol/db` — sql.js + OPFS per-app isolated database, `.sqlite` export/import |
| `packages/auth` | `@snugprotocol/auth` — dual-layer credential broker (v1.1) |
| `packages/knowledge` | `@snugprotocol/knowledge` — the LLM app-authoring knowledge base |
| `packages/adapters` | `@snugprotocol/adapters` — anthropic, openai, mock |
| `apps/playground` | Snug Playground — hosted demo (chat → build → run) |
| `apps/server` | Minimal reference backend (`/invoke` + artifact store) |
| `examples/` | Curated showcase apps (chess, flying-pig, habit-tracker) |

## Working in this repo

This repo runs an agentic engineering process — **start at [`docs/INDEX.md`](docs/INDEX.md)**. No work outside a task file; every session closes with `/close-session`.

## License

[MIT](LICENSE) · Security contact: security@snugprotocol.org ([SECURITY.md](SECURITY.md))

---
Built by [Jeetu Maker](https://jeetu.tech.voyage) · Maintained with support from [TechVoyage](https://ai.tech.voyage)
