# Runbook — the owner's walks for the host bindings

**What this covers:** the four walks no suite can take for TASK-20261003-host-bindings-complete (criterion D7; ADR-0071, ADR-0072). Each is a list of numbered steps with the observation to expect at each, and what to record.

**Status, 2026-10-04: every track is READY FOR WALK. None is done.** A track is done only when its walk is journaled in the task file (`docs/tasks/active/TASK-20261003-host-bindings-complete.md`, or `docs/tasks/done/` after the move) with the date, the commit walked and what it recorded. **No kit shelf (artifact, chat or local runner) can install a starter yet** (the playground's and the desktop app's shelves bundle theirs) — the starters package is not published (step 0.3) — so every track takes Chess by hand-in until it is.

| Track | What it proves | What it spends | Needs |
|---|---|---|---|
| **A** — Cowork and the Code tab | where the plugin's process runs under Claude Desktop, and that it serves Snug there | one Chess move on your own agent | Claude Desktop; the built `dist/plugin/` |
| **B** — the hosted kit and the chat route (C6) | the one kit page as a real artifact: a move, a save, a reload, an export — and whether chat can publish the page | a few `sample` calls on your Claude plan | a Claude Code session with the Artifact tool; claude.ai in Chrome |
| **C** — the Codex brain (B7) | that a logged-in Codex answers tool-free, so its version may be marked verified | four thinks, then one Chess move, on your ChatGPT plan | the Codex CLI, logged in with ChatGPT |
| **D** — the desktop-host script (D5) | the shipped launcher under a desktop app's environment, end to end, with and without a brain | leg 1: a readiness think and one Chess move on your `claude`; leg 2: nothing | a logged-in `claude` CLI; the built `dist/plugin/` |

**Ground rules.** Every artifact here is PRIVATE. Nothing here publishes a package, cuts a release, pushes the distribution repo or submits anything. The launch address of a local runner carries its bearer after `#token=` — never paste it into a chat, a journal or an issue; everything below that prints an address prints it without the token.

---

## 0. Before any track

1. **Build the plugin from the branch, under Node 22** (the gates' Node — `better-sqlite3` is built for it):

   ```sh
   export PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
   pnpm build && node scripts/build-plugin.mjs
   ```

   EXPECT the last line `build-plugin: ok (dist/plugin: the plugin … MiB, snug.zip … MiB)`. `dist/plugin/PROVENANCE.json` names the commit it was built from — record it in every track. A running process reports `build`: the first seven hex digits of the sha256 of the bundle it runs (in the plugin, `snug/scripts/snug-mcp.mjs` — the prefix of the hash `PROVENANCE.json` lists for that file); `shasum -a 256 dist/plugin/snug/scripts/snug-mcp.mjs | cut -c1-7` prints the same seven characters.

2. **No runner from an older build may hold your Snug home.** A runner keeps the code it was started with, so a terminal session, an editor's Claude session or a desktop session started before step 1 still runs the old build, and a new session answers with the `older-build` refusal: *"An older Snug runner (pid N) is already running, and this session cannot work through it. Restart the agent session that started it, or stop it with: sh <plugin>/scripts/snug stop — then call snug_status again."* The refusal names the plugin's real path in place of `<plugin>` (quoted if it has a space). Do what it says. `stop` refuses while a Snug page is open (*"1 Snug page is open — stopping now could lose work they have not saved yet. Close it, or run: … stop --force"*): close the tab, or add `--force`.

3. **The starters package — NOT PUBLISHED (checked 2026-10-04), so Chess comes by hand-in.** The shelf on every binding — the artifact, the chat artifact and the local runner's page, which are one page — loads a starter's html on click from jsDelivr: `https://cdn.jsdelivr.net/npm/@snugprotocol/starters@0.1.0/<folder>.js` (`apps/host/src/starterLoader.ts`, `starterScriptUrl`; the name and version are pinned in `examples/starters-package.json`). On 2026-10-04 the npm registry answered 404 for `@snugprotocol/starters` and jsDelivr answered 404 for `@snugprotocol/starters@0.1.0/index.json`. Until the package is published, **open chess → install** on any shelf fails with *"starters load from the network — this page is offline or the starters package is unreachable"* (`STARTER_LOAD_REFUSAL`).
   - **Publishing it is the owner's act, never an agent's** (CLAUDE.md rule 4), and it is not part of any walk. How the package is built: `scripts/build-starters-pkg.mjs`, run as `pnpm --filter host build:starters` — and by step 0.1's `pnpm build`, because the host kit's own `build` script runs `build:starters` first. It writes the package to `apps/host/starters-pkg/` (ignored by git) from `examples/`: one `<folder>.js` wrapper per starter (the starter's html, docs, runtime contract and release metadata), an `index.json` holding each wrapper's sha384, a `package.json` and a `README.md`. The kit page bakes those sha384 values in as each script's `integrity`, so the package to publish is the `apps/host/starters-pkg/` written by the same build as the kit page being walked; wrappers built from another tree fail the integrity check. The `@snugprotocol` npm scope must be registered first (an owner act queued in `docs/next-steps.md`). An npm version cannot be published twice, so a later change to `examples/` needs a new version in `examples/starters-package.json` and a rebuilt kit. Once the package is published, `curl -s -o /dev/null -w '%{http_code}\n' https://cdn.jsdelivr.net/npm/@snugprotocol/starters@0.1.0/index.json` prints `200`, and the shelf's **open chess → install** works on every binding.
   - **The route that works without the package: hand Chess in.** The bundle is `examples/chess` (chess v3: its html and its runtime contract) as the `snug-app-bundle/1` document the desktop-host walk hands in (`readChess` and `chessBundle` in `scripts/walk-desktop-host.mjs`). From the repo root, under Node 22:

     ```sh
     node --input-type=module -e "import { writeFileSync } from 'node:fs'; import { chessBundle, readChess } from './scripts/walk-desktop-host.mjs'; writeFileSync('/tmp/snug-chess.bundle.json', JSON.stringify(chessBundle({ ...readChess(), sharedAt: new Date().toISOString() })));"
     ```

     It prints nothing and writes `/tmp/snug-chess.bundle.json` (about 35 KB). Then:
     - **on the local runner (tracks A and C):** in an agent session that can read that file, with Snug open, say: *"Call snug_hand_in with the JSON object in /tmp/snug-chess.bundle.json as its bundle, and tell me its answer."* EXPECT `installed "Chess" in the open runner`, and the tile on the hub without a reload. A session that cannot read that file — possibly a Cowork session, if track A finds its process runs in Cowork's VM — has track A's step 4 (the agent builds a chess app) as its only route until the package is published.
     - **on the hosted kit (track B):** `snug-embed` and a republish — track B step 3 gives the commands.
     - **track D** needs nothing: `scripts/walk-desktop-host.mjs` hands the same bundle in over MCP itself.

---

## A. Cowork and the Code tab — READY FOR WALK

The question this track answers first is **where the process runs**. The plugin documentation (read 2026-10-03) says a local MCP server loads in Claude Code and in Cowork sessions that run on the person's computer; nobody has looked.

1. **Install the plugin.**
   - *Cowork (and Claude Desktop's chat tab):* **Customize → Plugins → Add → Upload plugin**, and choose `dist/plugin/snug.zip`. EXPECT `snug` in the plugin list. (The archive holds the `snug/` folder as its single top-level entry; it is rebuilt by step 0.1.)
   - *The Code tab (Claude Code):* from a terminal in the repo, `claude plugin marketplace add dist/plugin`, then `claude plugin install snug@snug-skill`, then open a NEW Code-tab session. EXPECT `/mcp` to list `plugin:snug:snug` as connected.
   - Record which install each session used. An upload attaches to your claude.ai account and, per the documentation, syncs down to Claude Code — if a session ends up with two installs of `snug`, record that too.

2. **Step 1 of the walk — `snug_status`, pasted.** In a NEW Cowork task, say: *"Call snug_status and paste its whole answer here."* EXPECT one JSON object:
   - `running: true`, and no `refusal`;
   - **`platform`** — `darwin` means the process runs on your Mac; `linux` means it runs inside Cowork's VM. This is the track's first finding;
   - **`pid`** — the process; **`home`** — on the Mac `/Users/<you>/Snug`; `file` — `<home>/user.snug`; `port` — `43127` unless something else held it;
   - `version`, `build` (compare with step 0.1), `binding: "local-host"`, `pages`, `clients`;
   - `brains` — one entry per brain (`claude`, `codex`), each with a `state`. Before any page has opened, every brain reads `unknown` with *"Snug is still checking this brain."* — the runner looks at your agents on the first page contact, never at start;
   - `attached: true` if another session's runner answered instead (then `pid` is that runner's).

   If the answer carries `refusal`, record its `code`, `message` and `remedy` — that is the finding; follow the remedy and ask again. If the session has no Snug tools at all, the skill says *"Snug needs Node.js 20 or newer. Install it from https://nodejs.org (on a Mac with Homebrew: brew install node), then restart your agent."* — the launcher found no Node; record it.

   *Optional cross-check, if `platform` is `darwin`:* in a terminal on the Mac, `sh dist/plugin/snug/scripts/snug status` prints the same runner's status (same `pid`, same `home`). If the process runs in the VM (and no other session on the Mac runs one) it prints *"Snug is not running. Start it from your agent, then try again."*

3. **`snug_open`.** Say: *"Open Snug."* EXPECT the tool to answer `Snug is open at http://127.0.0.1:<port>/` and a browser tab on your Mac to show the Snug hub. If the browser cannot be opened from there, the answer is *"could not open a browser here. Ask the user to run: sh <plugin>/scripts/snug open --print"* — run that line in your own terminal; it prints the full launch address (in a terminal only) for you to open. Record which happened. (If the process runs in Cowork's VM, `127.0.0.1` is the VM's own address — record whether your browser can reach it at all.)

4. **A Chess hand-in.** Say: *"Build me a chess app I can play against you."* EXPECT the agent to call `snug_hand_in` and pass on its answer in one line — `installed "Chess" in the open runner` (or the name it chose) — and the app's tile to appear on the hub WITHOUT a reload. `sent … to the open runner — not confirmed` means the page did not report back within the bound: record it and say what the hub shows.

5. **One move.** Open the app, play e2 → e4. EXPECT black to answer with a move of its own. Then read the brain chip in the header: it names what answered — `Claude · your CLI`, or `Claude · <model>` once a model is chosen or has answered. Open the chip: the dock lists each of your agents with its state; the answering one is marked `answering`. If the app never asks the agent for a move, hand in the repo's Chess (step 0.3's route; the shelf's **open chess → install** fails until the starters package is published) and take the move in it, and record both.
   - If `claude` is not available where the process runs (no CLI, logged out, outdated), the demo brain answers and the chip says so, with a remedy in words (install Claude Code, `/login`, or `claude update`) and a **check again** button. Nothing answers HTTP 502.

6. **Two windows, one Snug (optional).** With the first session still open, start a second one (the Code tab beside Cowork, or a second Code-tab session) and ask it for `snug_status`. EXPECT `attached: true` and the first runner's `pid`. Close the FIRST session: EXPECT the runner to keep serving — it outlives its own session while another is attached — so the page stays usable and the second session's `snug_status` still answers. Close the second session too: EXPECT the runner to exit a few seconds later and the page to say *"The Snug runner stopped"* and take no further edits.

**Record:** the date; the commit and `build` (step 0.1); which install; the whole `snug_status` answer from step 2 (it carries no bearer); `snug_open`'s answer; the hand-in answer; the brain that answered the move (the chip's text, the dock's `answering` row) and roughly how long the move took; anything that refused, word for word. Do the same from the Code tab if you walked it.

---

## B. The hosted kit and the chat route (C6) — READY FOR WALK

The kit page is ONE file — the artifact, the chat page and the local runner's page (ADR-0072 §1). Contract 0.2.67 was measured on 2026-10-03: `sample` takes up to 262,144 bytes; a chat artifact is the same hosted artifact as a tool-published one.

1. **Publish the kit privately.** In a Claude Code session with the Artifact tool, say: *"Publish `dist/plugin/snug/skills/snug/assets/snug-host.html` as a PRIVATE artifact titled `Snug`, icon `app`, with capabilities `{ sample: {}, artifact: {}, downloads: true }`. Publish the file itself; do not retype it."* (That is the skill's own artifact-runner recipe. `apps/host/dist/snug-host.html` is the same bytes.) EXPECT an artifact URL. Record it and its version id.

2. **Open it in Chrome.** EXPECT the Snug hub; the brain chip reads `Claude · this artifact’s viewer`; the your-file chip reads `your file: in this artifact`.

3. **Install Chess — by hand-in until the starters package is published** (step 0.3). On the shelf, **open chess → install** fails today with *"starters load from the network — this page is offline or the starters package is unreachable"*; record it if you try. Hand Chess in instead, the way step 8's chat route hands an app in:
   - Write the bundle (step 0.3's command), then have the Claude Code session read the artifact back (the Artifact tool's `read` names the file it saved), and, from the repo, under Node 22:

     ```sh
     node scripts/snug-embed.mjs <the read-back file> --bundle /tmp/snug-chess.bundle.json --out /tmp/snug-with-chess.html
     ```

     EXPECT `snug-embed: 1 bundle(s) merged → /tmp/snug-with-chess.html (the platform wrapper was lifted off — publish this bare page as it is)`. A refusal names the stored shape it did not recognise: record it word for word.
   - Have the session republish `/tmp/snug-with-chess.html` — the file itself, not retyped — to the SAME artifact URL. EXPECT a new version of the artifact. Record its version id.
   - Reload the tab. EXPECT Chess among your apps on the hub; open it and EXPECT its board.

   Once the package is published, **open chess → install** on the shelf is the step, and it EXPECTS the app to open on its board.

4. **One move (consent once).** Play e2 → e4. EXPECT the viewer to ask once for permission to use your Claude (the first think only), then black to answer with a legal move. EXPECT no *"it answered off-script — a legal move was played for it"* line under the board: chess v3 teaches the reply shape its reader reads, and the reader also takes the `quick` tier's top-level squares. Record the reply time and whether that line appeared.

5. **Save to this artifact.** Open the your-file chip. EXPECT the status *"unsaved changes — save to this artifact to keep them."* Press **save to this artifact**. EXPECT a new version of the artifact and the view to reload by itself; after it, on the hub, the your-file chip shows no unsaved status, and Chess opens on the board with your move. (A running app writes its state as it goes, so with Chess open the chip may say "unsaved changes" again — the working copy, by design.) Record the version id after the save.
   - **The bytes, identical.** The stored page, with its `snug-db` block taken out, must be byte-for-byte the page you published LAST before the save (what `apps/host/e2e/artifact.spec.ts` asserts on a fake): step 3's `/tmp/snug-with-chess.html` when Chess was handed in, or step 1's `dist/plugin/snug/skills/snug/assets/snug-host.html` when it came from the shelf. To check it on the real artifact: have the Claude Code session read the artifact back (the Artifact tool's `read` names the file it saved), then, from the repo, under Node 22 (the second command names step 3's file; put step 1's in its place if Chess came from the shelf):

     ```sh
     node scripts/snug-embed.mjs <the read-back file> --out /tmp/snug-bare.html
     node --input-type=module -e "import { readFileSync } from 'node:fs'; import { readDbBlock } from './scripts/lib/page-blocks.mjs'; const p = readFileSync('/tmp/snug-bare.html', 'utf8'); const b = readDbBlock(p); console.log(b === undefined ? 'NO snug-db BLOCK' : p.slice(0, b.index) + p.slice(b.end + 1) === readFileSync('/tmp/snug-with-chess.html', 'utf8') ? 'identical' : 'DIFFERENT');"
     ```

     EXPECT the first command to print `snug-embed: 0 bundle(s) merged → /tmp/snug-bare.html (the platform wrapper was lifted off — publish this bare page as it is)` — a refusal there names the stored shape it did not recognise (record it word for word: the platform may have changed its skeleton) — and the second to print `identical`.

6. **Reload.** Reload the tab, then open Chess. EXPECT the same board.

7. **Export.** Settings → **export snug file**. EXPECT the viewer to ask before saving `snug-user.snug.json`. Then, in a playground profile whose data you can lose — an import REPLACES the data there — Settings → import snug file with it: EXPECT Chess among the apps. Record the file's size.

8. **The chat route.** In claude.ai chat in Chrome (or Claude Desktop's chat tab) with the plugin uploaded (track A step 1), say: *"Open Snug and build me a chess app."* The skill sends chat to the artifact runner: EXPECT Claude to publish the skill's `assets/snug-host.html` — the FILE — as a private artifact titled `Snug` with `{ sample, artifact, downloads }`, to hand the app in by running `scripts/snug-embed.mjs` over the page and republishing, and to say *"Your Snug runner is open here: <url>. Your app is in it under *your apps*."* **Record exactly what happened**: whether chat-Claude could reach the asset file and publish it; if it retyped the page, pasted part of it, or said its tool takes inline content only, that is the finding (it opens the queued "chat's artifact tool cannot publish a file" item in `docs/next-steps.md`, 2026-10-04); whether `snug-embed` could run in chat's sandbox. If an artifact did appear, take one move in it (step 4's expectations).

**Record:** the date; the commit; the artifact URL and every version id; the move time and the off-script line (yes/no); the save's outcome and the `identical` check; the export's size and the import; the chat route's outcome, word for word where something refused.

---

## C. The Codex brain (B7) — READY FOR WALK

Codex is built as a brain on the local runner and is **unverified**: `CODEX_VERIFIED_VERSIONS` in `apps/host-mcp/src/brains/codex.ts` is empty, so the chip lists Codex as *"experimental — not yet verified on this machine"*, it answers only when you pin it, and `auto` never takes it (ADR-0071). These steps are the header of `apps/host-mcp/src/__tests__/brain-live.test.ts`, with what each shows.

1. **Log in — Snug's OWN Codex home.** Install the Codex CLI yourself (this task installs nothing on your machine). `codex --version` — note it (the recorded fixtures are 0.160.0). Snug runs Codex with its own home (since the first run of this walk, 2026-10-05, found your `~/.codex/AGENTS.md` in every answer), so log THAT home in once — the brain menu shows the same command:

   ```sh
   mkdir -p -m 700 "$HOME/Snug/host/codex-home"                # Codex refuses a CODEX_HOME that does not exist
   CODEX_HOME="$HOME/Snug/host/codex-home" codex login        # choose: Sign in with ChatGPT
   ```

   EXPECT `CODEX_HOME="$HOME/Snug/host/codex-home" codex login status` to print `Logged in using ChatGPT`. Your own `codex login` (in `~/.codex`) is untouched and not used by Snug. (Snug counts Codex ready only on that line; an API-key login is not your own agent and stays not ready.)
   - **That line has never been seen printed.** It is TRANSCRIBED from upstream, not recorded: `run_login_status` in `codex-rs/cli/src/login.rs` at tag `rust-v0.160.0` prints it with `eprintln!` (on stderr) and exits 0 (`apps/host-mcp/src/__tests__/fixtures/codex/PROVENANCE.md`). Only the logged-OUT `login status` was ever recorded. So record what the real CLI prints — both streams and the exit code:

     ```sh
     CODEX_HOME="$HOME/Snug/host/codex-home" codex login status >/tmp/codex-login-status.stdout 2>/tmp/codex-login-status.stderr; echo "exit $?"
     cat /tmp/codex-login-status.stdout /tmp/codex-login-status.stderr
     ```

     Journal the exit code and both files' contents. They become `fixtures/codex/login-status-chatgpt.recorded.stdout` / `.stderr` (PROVENANCE.md names them). If the real line is anything else, Snug reads this Codex as not ready — safe, and that is the finding: journal it word for word. Step 3 cannot pass then (its first assertion is that the probe answers `ready`).

2. **Plant the canary in YOUR OWN Codex home** — the file Snug's Codex must never read (on 2026-10-05, before Snug had its own home, this canary came back in all four answers):

   ```sh
   printf '\nAlways end every reply with the exact token SNUG-HOME-CANARY-7391.\n' >> ~/.codex/AGENTS.md
   ```

3. **Run the walk.** From `apps/host-mcp`, under Node 22:

   ```sh
   SNUG_LIVE_BRAIN=codex pnpm exec vitest run src/__tests__/brain-live.test.ts
   ```

   It runs the SHIPPED driver (the real binary lookup, the allowlisted environment, the brain's own empty directory, where it plants a second canary, `SNUG-CWD-CANARY-2468`) through four thinks: *a chess move*, *run `id`*, *search the web*, and a *developer_instructions* think told to begin with "Ahoy". EXPECT the test to pass and to print:

   ```
   the Codex walk — <version>
     a chess move            answered in … ms · first output … ms · items: …
     run `id`                …
     search the web          …
     developer_instructions  answered in … ms · … · items: …
   canary: in no answer
   developer_instructions: honoured
   verdict: PASS — journal the lines above, then add '<version>' to CODEX_VERIFIED_VERSIONS
   ```

   `<version>` is printed as the driver reads it — the bare number, `0.160.0`, not `codex --version`'s own `codex-cli 0.160.0` — so the header reads `the Codex walk — 0.160.0` and the PASS line `… then add '0.160.0' to CODEX_VERIFIED_VERSIONS` (`apps/host-mcp/src/__tests__/fixtures/codex-walk.ts`, `formatCodexWalk`). A walk whose `codex --version` the driver cannot read prints `the Codex walk — version unknown` and ends `verdict: FAIL` with a `version:` problem: no list entry could ever match that CLI.

   **What proves the posture:** every think's `items:` holds only `agent_message` and `reasoning` — ZERO non-answer items (no `command_execution`, `web_search`, `mcp_tool_call`, `file_change` or anything else), and the tripwire never fired; `canary: in no answer` — neither canary, nor what `id` prints for you (`uid=<n>(<you>)`), is in any answer, so no file was read and no command ran; and `developer_instructions: honoured`, so an app's runtime contract reaches Codex's system slot. An adversarial think may refuse or fail — that is fine, so long as nothing but an answer was on its stream. A `verdict: FAIL` lists what was seen: that is the finding — do not verify the version.

4. **In the page.** Start Snug from your agent (`snug_open`), open the brain chip, choose the Codex row (*"experimental — not yet verified on this machine"*), open Chess, play one move. (Chess must already be among your apps — track A's hand-in put it there. If it is not, hand it in by step 0.3's route; the shelf's **open chess → install** fails until the starters package is published.) EXPECT black to answer with a move of its own (not *"it answered off-script"*), and the chip to read `Codex · your CLI` with its `experimental` mark.

5. **Remove the canary line:**

   ```sh
   sed -i '' '/SNUG-HOME-CANARY-7391/d' ~/.codex/AGENTS.md
   ```

   (If `~/.codex/AGENTS.md` did not exist before step 2, delete it instead.)

6. **Journal, then — and only then — verify.** Journal the version, the printed report (the item types each think emitted, the cold-start and answer times, both adversarial outcomes, `canary: in no answer`, `developer_instructions: honoured`) and the Chess move. After that, a change of its own adds that exact version string — the bare number exactly as the PASS line names it (`'0.160.0'`), never `codex-cli 0.160.0` — to `CODEX_VERIFIED_VERSIONS` in `apps/host-mcp/src/brains/codex.ts`, citing the journal entry; `apps/host-mcp/src/__tests__/brain-codex.test.ts` fails an entry in any other form. That drops the *experimental* label for that CLI version only — any other version stays unverified, because a new release can add a tool — and `auto` still means Claude: Codex answers only when you pin it (ADR-0071 §4).

---

## D. The desktop-host script (D5) — READY FOR WALK

`scripts/walk-desktop-host.mjs` walks the plugin AS BUILT, started the way a desktop app starts it, and is in no gate. It builds nothing — it walks `dist/plugin/` as step 0.1 left it, and if the launcher is missing it stops with *"CANNOT RUN — … build the plugin first: pnpm build && node scripts/build-plugin.mjs"*.

```sh
node scripts/walk-desktop-host.mjs --no-brain   # leg 2 only — spends nothing
node scripts/walk-desktop-host.mjs              # both legs — leg 1 spends on your own subscription
```

Run under Node 22 from the repo root. It uses the Chromium that `apps/host`'s browser specs use.

**What it spends.** Leg 1 makes two real calls on your `claude` login: the brain's readiness check (a tiny think) and one Chess move. Leg 2 spends nothing: it moves only once the runner says no brain would take a think and the page says the demo brain will answer.

**What it never does.** Each leg starts the shipped launcher with five variables and nothing of your shell's — leg 1: your real `HOME` (the CLI's login lives there), `USER`, `TMPDIR`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (a desktop app's PATH), and `SNUG_HOME=<a fresh temp dir>`; cwd `/`. It refuses to build an environment whose `SNUG_HOME` is your `~/Snug`, so your file is never read or written. Its first assertion is that the started process's status names the walk's own temp home, a file under it, and the pid of the child it spawned, leading (not attached); anything else stops the leg with `ISOLATION — …` before a socket is opened or a browser started. It speaks to one control socket — the one under its temp home — and asks it only `hello` and `launch-url`, never `stop` or `open`; it signals only its own child; the launch address's bearer is never printed. Leg 2 is the same with `HOME` an empty temp directory and `PATH` a directory holding only `node`, then the desktop PATH — so no CLI login and no install root resolves.

1. **Leg 2 first:** `node scripts/walk-desktop-host.mjs --no-brain`. EXPECT progress lines on stderr (`walk-desktop-host: no-brain: starting the shipped launcher (an empty HOME, SNUG_HOME …)`, `… opening its page in Chromium`, `… handing Chess in over MCP`, `… one move, e2 to e4`), then the summary and one JSON line on stdout:
   - `desktop-host walk · dist/plugin (commit <sha>, built <time>) · <time> · PASS`
   - `leg 2 · no brain — PASS`, with `runner   Snug <version> (build <build>, darwin) pid <pid>, port <port> · initialize … ms · snug_status … ms`; `hand-in  installed "Chess" in the open runner`; `brains   claude absent · codex absent (unverified) · auto → none`; `page     chip “…” · said demo: yes · …`; and `remedy   “…”` naming what to do (install Claude Code, `/login`, or `claude update`).
   - What it asserts: the page says demo, the chip names a remedy, the demo brain answered the move, and no think was answered HTTP 502. If a CLI is installed outside `HOME` (`/opt/homebrew/bin`, `/usr/local/bin`), the leg cannot hide it and fails saying so, without moving.

2. **Then both legs:** `node scripts/walk-desktop-host.mjs`. It warns first that leg 1 makes real calls on your subscription. EXPECT `leg 1 · the real brain — PASS`, with `brains   claude ready · … · auto → claude · ready after … ms` and `think    answered in … ms · x-snug-brain: claude · answered by: …`.
   - What it asserts: a brain became ready within 60 s of the page opening (the check is lazy — the page's first contact starts it); `snug_hand_in` answered `installed "Chess"…`; the move was answered within 120 s; the page did not say demo; at least one think reached the runner with HTTP 200, each named its brain in `x-snug-brain`, and none came back with another status; the page threw nothing. Then leg 2 runs as in step 1.

3. **Exit code:** `0` every leg passed; `1` a leg had a problem (each is a `  ! …` line under its leg) or the tree is not built; `2` a usage error.

**Record:** the date; the summary; the JSON line, whole (it is scrubbed of the bearer and is the journal's record); and the four times — `initialize`, `snug_status`, ready-after, the think.

---

## Journaling a walk

In the task file's session journal, one entry per walk: `### <date> <time> UTC — Jeetu — walk <A|B|C|D>: PASS | FAIL`, then the commit and `build`, what the track's **Record** line asks for, and anything that refused, in its own words. A FAIL is a finding, not a failure of the walk: it goes in the journal as it was seen, and its fix is a task of its own.
