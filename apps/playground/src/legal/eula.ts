// eula.ts — the DMG's license screen, as ONE string (ADR-0055 §2;
// TASK-20260823-legal-terms-privacy-eula AC5/AC10).
//
// This is the text macOS shows before the disk image mounts — the product's single
// clickwrap. It is a screen someone reads standing up, so it carries only what must be
// agreed to at install time and points at /terms and /privacy for everything else.
//
// TWO CONSUMERS, ONE SOURCE: Settings → about renders this constant offline (the
// playground never imports from apps/desktop — ADR-0047 §2), and
// `apps/desktop/src-tauri/EULA.txt` is a byte-copy of it that Tauri embeds as the DMG's
// SLA resource. `dmgEula.test.ts` pins the copy equal to this string and runs
// `checkEulaText` (scripts/release-desktop.mjs) over it: ASCII only (the SLA resource is
// classic TEXT — a curly quote or an em dash renders as garbage), short lines, a hard
// line budget, the MIT words verbatim, the R-30 sentence byte-identical to
// legalShared.ts. To change the EULA: edit THIS file, then
//   node -e "import('./apps/playground/src/legal/eula.ts')" … or simply copy the string
// into EULA.txt — the test names the drift either way.
//
// ASCII ONLY in this string: hyphens, straight quotes, "section 1668" not "§".

export const EULA_TEXT = `Snug for macOS - License Agreement

Snug for macOS is distributed by Jeetu Maker. The Snug website and the
hosted Playground are operated by TechVoyage LLC. "We", "us" and "our"
mean Jeetu Maker and TechVoyage LLC together, with their officers,
members, employees and agents.

LICENSE. Snug is free software under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

UPDATE CHECK. The desktop app checks github.com for a new version each
time it starts. That request tells GitHub your IP address, the time,
and the version you are running. You can turn it off in Settings.
Nothing installs by itself: an update is offered and you choose. We do
not receive that request; it goes to GitHub.

LOCAL HELPER AND YOUR NETWORK. If you link a messaging account, the app
runs a small helper on this computer that starts with the app and
reconnects to that service on every launch until you unlink. Apps can
reach devices on your own network only through connections you approve
in the app.

YOUR DATA. Your apps, their data, your chats and your keys live in one
file in ~/Snug on this computer. If you connect a personal sync origin
(such as your own Dropbox), that whole file - keys included - is copied
there for as long as it stays selected.

PRE-1.0. This is pre-release software. It may change, break, or stop.
Keep your own backups; we hold no copy and can recover nothing.

LIABILITY. To the maximum extent permitted by law, our total liability
to you is limited to USD 50. This does not limit liability for fraud,
willful injury, gross negligence, or violation of law (California Civil
Code section 1668). California law governs.

Full terms:  https://snugprotocol.org/terms/
Privacy:     https://snugprotocol.org/privacy/

Clicking Agree means you accept these terms.
`;
