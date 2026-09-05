# S9 — Cowork checklist (owner runs this in Claude Cowork; ~10 minutes)

Spike S9 of TASK-20260905-host-bindings-spikes decides **D11** (kits as GitHub Release assets fetched on first use, or committed) and confirms **A1 on Cowork**. Three questions, each answered by pasting Claude's reply (or a screenshot) back into the Claude Code session.

Before you start: open Cowork in a project that has a connected folder (any scratch folder is fine), so the file-writing question can be answered too.

## Q1 — Does Cowork have the Artifact tool with `capabilities`?

Paste into Cowork:

> Write a file `hello.html` in the connected folder containing a page that says "Snug probe" and shows the current time, then publish it as an artifact **with capabilities `{db: {}}`**, and tell me (a) the artifact URL, (b) the exact tool call you used including the `capabilities` argument, and (c) any error verbatim.

Record: the URL · whether `capabilities` was accepted · the tool's name as Cowork reports it.

Pass = an artifact URL under `claude.ai/code/artifact/…` and `capabilities` accepted.

## Q2 — Can the Cowork sandbox download a GitHub Release asset?

Paste into Cowork:

> Download this file from GitHub Releases and tell me its size in bytes and its SHA-256:
> `https://github.com/snugprotocol/snug/releases/download/v0.1.3/latest.json`
> If the download fails, show me the exact error. Then also try the same with `curl -sI https://cdn.jsdelivr.net/gh/snugprotocol/snug@main/README.md` and report the HTTP status.

Record: the size + sha256 (or the error) · the jsDelivr status.

Pass = the file downloads (any size; the hash just proves bytes arrived). Fail → D11 flips to committed kits.

## Q3 — Can a Cowork session write a file into the connected folder on request?

Paste into Cowork:

> Create `snug-probe/user.snug.json` inside the connected folder with the content `{"format":"snug-user-file/1","note":"S9"}` and confirm the absolute path on my Mac.

Record: the path · whether it appears in Finder.

Pass = the file exists on disk where Cowork says it is (this is the "session writes your `.snug` into a folder you chose" custody path for A1).

## Paste back

One message with the three answers in order. If anything asked for approval, say what it asked.
