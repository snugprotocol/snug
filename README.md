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
| `packages/sdk` | `@snugprotocol/sdk` — in-app hooks: `useSnugApp`, `usePersistedState`, `useAppDB` (embedded + module forms) |
| `packages/db` | `@snugprotocol/db` — sql.js + OPFS per-app isolated database, `.sqlite` export/import |
| `packages/auth` | `@snugprotocol/auth` — dual-layer credential broker (v1.1) |
| `packages/knowledge` | `@snugprotocol/knowledge` — the LLM app-authoring knowledge base |
| `packages/adapters` | `@snugprotocol/adapters` — anthropic, openai, mock |
| `apps/playground` | Snug Playground — hosted demo (chat → build → run) |
| `apps/server` | Minimal reference backend (`/invoke` + artifact store) |
| `examples/` | Curated showcase apps (chess, flying-pig, habit-tracker) |

## Quickstart (under 10 minutes, no API key needed)

```bash
git clone <this repo> && cd snug
pnpm install                       # ~2 min
pnpm build && pnpm test            # everything green (~2 min)
pnpm smoke                         # headless happy path: build an app via the mock adapter

# run the Playground against the reference server (mock "demo brain" — no key):
pnpm --filter server build && SNUG_ADAPTER=mock node apps/server/dist/server.js &
pnpm --filter playground dev       # open the printed URL → click a suggestion chip → build → run
```

Bring your own key instead: open **settings** in the Playground, pick BYOK, paste an Anthropic or OpenAI key (kept in sessionStorage, sent only to the provider). The three starter apps (chess, flying-pig, habit-tracker) run with zero setup.

## Working in this repo

This repo runs an agentic engineering process — **start at [`docs/INDEX.md`](docs/INDEX.md)**. No work outside a task file; every session closes with `/close-session`.

## License

[MIT](LICENSE) · Security contact: security@snugprotocol.org ([SECURITY.md](SECURITY.md))

---
Built by [Jeetu Maker](https://jeetu.tech.voyage) · Maintained with support from [TechVoyage](https://ai.tech.voyage)
