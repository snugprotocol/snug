# Runbook — the owner's walk for "Use my ChatGPT plan"

**What this covers:** the one walk no suite can take for TASK-20261023-siwc-chatgpt-plan (ADR-0078): the desktop's third way to think — the user's own ChatGPT plan through OpenAI's *Sign in with ChatGPT* — against the real OpenAI sign-in and the real Responses route, in a real shell. A list of numbered steps with the observation to expect at each, and what to record.

**Status, 2026-10-24: READY FOR WALK. Not done.** Every code lane landed on `feat/TASK-20261023-siwc-chatgpt-plan`; the PR is open, not merged. The walk is done only when it is journaled in the task file (or, after the merge, in its `done/INDEX.md` line) with the date, the commit walked and what each step showed.

| What it proves | What it spends | Needs |
|---|---|---|
| the sign-in end to end (dynamic registration, the loopback on `/auth/callback`, the ID-token checks), a think and a builder tool loop on the plan, the named limit with **Manage usage**, sign-out and a re-sign-in that reuses the registration, and the custody on disk | a few thinks on your ChatGPT plan (one app think, one builder turn with a tool call, whatever it takes to reach a limit you set yourself) | the desktop built from the branch under Node 22; **Snug.app quit first**; a ChatGPT account with a plan; a browser signed in to ChatGPT (or ready to sign in) |

**Ground rules.** Nothing here publishes a package, cuts a release or pushes anything. Never paste a token, a `session.json`'s contents or an `eyJ…` string into a chat, a journal or an issue — the checks below print counts and modes, never values. The walk leaves your registration in place at the end (step 13); *forget this registration* in Settings drops it if you want a clean slate.

---

## 0. Before the walk

1. **Quit `/Applications/Snug.app`** (⌘Q, and check the menu bar). The shell is single-instance: while the installed app runs, a second shell forwards its arguments to it and quits — you would be walking the installed build, not the branch.

2. **Build and start the branch's desktop, under Node 22** (the gates' Node):

   ```sh
   export PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
   node --version            # EXPECT v22.13.1
   pnpm install --frozen-lockfile && pnpm run build
   pnpm --filter desktop dev
   ```

   EXPECT the Snug window to open. Record the commit (`git rev-parse --short HEAD`). A built app (`pnpm --filter desktop bundle`) walks the same way.

3. **Start from a hub with no ChatGPT sign-in.** If `~/Snug/.chatgpt-plan/` exists from an earlier try, sign out in Settings first — or, for a true first sign-in (the name prompt in step 4), also press *forget this registration*.

---

## 1. The walk

1. **The Welcome shows three cards.** On a first run (or a fresh `~/Snug`), EXPECT three cards: **use your computer's AI**, **use an AI service key**, and a third with OpenAI's logo and **Continue with ChatGPT** above *"use your ChatGPT plan — sign in with the ChatGPT account you already have. the sign-in stays on this computer, outside your file."* On an existing hub, open **Settings → where the agent runs** instead: EXPECT three buttons — *bring your own key*, *local model*, *my ChatGPT plan* — and pick *my ChatGPT plan*.

2. **Continue with ChatGPT.** Press it. EXPECT your system browser (never a window inside Snug) to open `auth.openai.com`, and Snug to show *"we opened your browser — finish signing in there. we're listening."* with a primary **cancel this sign-in**. Optional first: press cancel once and EXPECT the card back, the mode untouched, the other cards still live — then press Continue again.

3. **Sign in in the browser.** Sign in to ChatGPT if asked, then consent. **First time on this machine:** OpenAI asks you to name the app — EXPECT the suggested name **Snug**; keep it. EXPECT the browser to land on a plain local page at `http://127.0.0.1:<port>/auth/callback` (the port varies; it is the sign-in's own listener) — close the tab.

4. **Back in Snug: the one-time notice.** EXPECT the hub (the Welcome closes only on a successful sign-in) and a note headed **You're using your ChatGPT plan** — *"Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings."* — with **Got it** and **Manage usage**. Press **Got it**. It must never show again (check after step 12's restart).

5. **The chip reads ChatGPT plan.** EXPECT the brain chip to read **ChatGPT plan**. Open it: EXPECT **Using ChatGPT plan · <your email>**, **Manage usage**, a model select listing your plan's models in OpenAI's own names, a level picker when the chosen model has levels, and **Sign out of ChatGPT**.

6. **One app think.** Open any starter that thinks (Chess is the quickest — make a move) and let it answer. EXPECT a normal answer and no "demo brain" anywhere. Open the LLM inspector on that app: EXPECT the round trip, with no `Authorization` value and no `eyJ…` string shown (a bare token would read `***`).

7. **One builder turn with a tool call.** In the builder, ask for a small app ("a tip calculator"). EXPECT the turn to stream, the app to be written (the KB consult and the `artifact_write` tool call happen on the plan) and the turn to sign off. Record the model the chip says answered.

8. **Settings → my ChatGPT plan.** Open Settings. EXPECT the card's chip **Using ChatGPT plan**, the line *<your email> · Manage usage*, the default model and level selects (the list refreshes on open), and **Sign out of ChatGPT**. The Protection card says the ChatGPT sign-in sits outside the passphrase-protected file.

9. **Set a per-app limit in ChatGPT.** Press **Manage usage**: EXPECT `https://chatgpt.com/settings/usage` in your system browser; record whether it lists Snug and offers a per-app limit. Set Snug's own limit as low as ChatGPT allows (or skip this and run thinks until your plan's limit — slower).

10. **The limit message, with Manage usage first.** Think again until the limit lands. EXPECT, in the builder or app chat, *"Usage limit reached — Review your plan or this app's limit in ChatGPT settings."* with **Manage usage** as the primary (first) action; the same banner in the run view for an app think; and — if you have a schedule with an *Ask [app]'s AI* step, run it now — the step's result **refused** with the same sentence and Manage usage, not retried. EXPECT nothing to answer from a key, a local model or the demo brain; the chip still reads **ChatGPT plan** (its *limit reached* sub-line is not wired as built — nothing records the limit into the keeper's status; record what the chip shows). Raise or clear the limit in ChatGPT afterwards.

11. **Sign out of ChatGPT.** Settings → **Sign out of ChatGPT**. EXPECT *"signed out of ChatGPT on this computer. to remove Snug from your account entirely, disconnect it in ChatGPT → Settings."* (and, only if OpenAI did not confirm the revocation, a second line saying so — record which). EXPECT the chip to still read **ChatGPT plan**, now with **sign in needed** — the mode stays yours; nothing reroutes. Think once: EXPECT a named *sign in* message, never an answer from another brain.

12. **Sign in again: no name prompt.** Press **Continue with ChatGPT** in Settings. EXPECT the browser consent WITHOUT the name-the-app prompt (the registration from step 3 is reused), then back to **Using ChatGPT plan**. Quit Snug and start it again (step 0.2's command): EXPECT still signed in, and the one-time notice NOT shown.

13. **Verify the custody on disk.** In a terminal:

    ```sh
    ls -la ~/Snug/.chatgpt-plan/
    ```

    EXPECT `.` as `drwx------` and `session.json` as `-rw-------` (no `session.json.tmp` left behind). Then `stat -f '%Sp' ~/Snug` — EXPECT `drwxr-xr-x` (Snug never changes your `~/Snug` folder's mode). Then export the user file WITH secrets: Settings → portability → tick **include secrets** → **export snug file**, save it, and (with **Protection off**, so the export is not ciphertext):

    ```sh
    grep -a -c eyJ <the exported .snug>      # EXPECT 0
    grep -a -c eyJ ~/Snug/user.snug          # EXPECT 0
    ```

    A non-zero count is a C1 defect — stop and record it. Delete the exported file when done (it carries your other keys).

---

## 2. What to record

In the task file's journal (or the `done/INDEX.md` line after the merge): the date; the commit walked; the shell (`dev` or built); for each step 1–13 what it showed — in particular the model that answered (step 7), whether OpenAI confirmed the revocation (step 11), whether the name prompt was absent (step 12), and the two modes and the two `eyJ` counts (step 13). Anything that differed from an EXPECT is a finding: write the exact text Snug showed, never a token.
