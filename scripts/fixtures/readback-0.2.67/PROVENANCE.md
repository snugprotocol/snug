# Provenance — two real artifact read-backs under runtime contract 0.2.67

Both files are byte-for-byte what the Artifact tool's `read` returned on **2026-10-03**
(claude.ai, contract 0.2.67), saved by the orchestrating session of
TASK-20261003-host-bindings-complete and copied here unedited. They are the C3 fixtures:
`unwrapViewerPage` (`scripts/lib/page-blocks.mjs`) is tested against them, never against a
restatement of them.

| File | Bytes | sha256 | What it is |
|---|---|---|---|
| `chat-created-nested-document.html` | 12,419 | `83658d639ff224334382621407fd4a4fabcf5a6a7fdd33676ac1e10cf2d47b44` | The owner's v2 probe artifact, CREATED IN A claude.ai CHAT (`claude.ai/artifact/RLWmUHnXhCMH1qCVHTzqU3`), read back 2026-10-03 21:05 UTC. The 0.2.67 skeleton (536 bytes through `<body>`) + `\n` + a COMPLETE `<!doctype html>` document (the v2 probe file, 11,867 bytes, sha256 `55a81a94d751dcbaaeedcf93f608920d5279d850185ff5b57c4218ee797090ff`) + `\n</body></html>`. The kit's own case: the kit page is a full document. |
| `tool-published-fragment.html` | 13,990 | `d67b8b25b91aa2198f23297a643cacd23c3cd992dedd84c5181b534d0293aa14` | A probe page PUBLISHED BY THE ARTIFACT TOOL in its fragment form (`claude.ai/artifact/Lv7FiqjAHKsP1SNUwkXyGX`, the page the owner ran 2026-10-03 20:37 UTC), read back. The same 536-byte skeleton + `\n` + the page FRAGMENT (13,438 bytes — `<title>` and `<style>` first, no doctype of its own) + `\n</body></html>`. Not a kit document: the unwrap refuses it by name. |

The first 536 bytes of the two files are identical — that is the skeleton
`ARTIFACT_SKELETON_OPEN` pins. Neither file carries an injected script in its stored source
(the live DOM has two; the stored page has none).
