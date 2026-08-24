# TASK-20260823-legal-terms-privacy-eula: Terms, Privacy, desktop EULA clickwrap, and the contextual-consent bands

- **Status**: in-review — Gates 3–5 complete 2026-08-24 (root `pnpm test` green twice; both High-tier fresh-context reviews run and folded; self-sign-off in the journal); awaiting owner review + the explicit push/PR ask. Plan approved by owner 2026-08-23 ("TechVoyage LLC" confirmed as the registered spelling; hello@ verified; "go ahead with the commit"); interview answered by owner 2026-08-23 (amendments folded below); High-tier fresh-context plan review run 2026-08-23 — **15 findings, all folded** (13 accepted as written, F13 modified per the owner's Q3 answer, F9 recorded as a durability note); see Decisions & surprises.
- **Owner**: Jeetu
- **Risk tier**: **high** — `apps/desktop/src-tauri/tauri.conf.json` (the shipped bundle config) and `scripts/release-desktop.mjs` (release tooling) are touched: PROCESS.md lists "CI/release workflows" as auto-escalating, and the DMG is an artifact every installed client trusts (ADR-0047). High extras apply: negative tests, a fresh-context AI review of this plan BEFORE implementation, explicit self-sign-off in the journal. The playground/website halves are Medium/Low on their own.
- **Branch**: `feat/TASK-20260823-legal-terms-privacy-eula` (created off `main` @ `af307f8`, 2026-08-23)
- **Packages touched**: `apps/playground` (routes, footer, Settings → about, four consent bands, legal content modules), `apps/desktop` (`src-tauri/EULA.txt` + `bundle.licenseFile` + config-pin test), `apps/website` (`/terms/`, `/privacy/` pages + footer Legal column), `scripts/release-desktop.mjs` (post-build DMG EULA verification + EULA.txt constraints), `docs/` (threat-model R-9/R-10/R-30 cross-references, ADR-0055, next-steps, code-map), `internal/` (gitignored — TRACKER D-02 + cowork-setup entity corrections, runbook stage 5/7). **NOT touched:** `packages/protocol`, `packages/runner`, `packages/auth`, `packages/db`, any Rust.
- **Spec impact**: none (no protocol schema, no wire format, no `.snug` format change)
- **Related**: ADR-0014 (custody line — the sync-origin band's wording is ADR-0014 §2's own), ADR-0016/0017 (connection grants — already covered, untouched), ADR-0021 D8 (macOS-only), ADR-0043 (at-rest encryption — the bounded claim), ADR-0047 §3/§7/§9 (offered-not-auto updates; env-gated Apple signing; the launch check is a phone-home), ADR-0048 §5 (website reads playground via `@playground`), ADR-0052 (no hosted receiver; GitHub deep-links; sign-in flag-off §5), ADR-0054 (Cloudflare Pages hosting), threat-model §2/§4/§6/§7 (R-1, R-3, R-9, R-10, R-22/23, R-27, R-29, R-30, R-32), `SECURITY.md` safe harbour, `scripts/check-whitepaper.mjs` AC6 (claim-discipline check to mirror), `lanConsentCopy.test.tsx` (the consent-band doctrine this task extends), `internal/07-roadmap.md:54` (Beta exit criterion: an 11-year-old succeeds unaided — why there is no 18+ gate); **new ADR-0055** (`docs/decisions/0055-legal-disclosure-posture.md`). Owner memory: Apple Developer account (individual enrollment, Jeetu Maker) exists as of 2026-08-23 — signing activates through ADR-0047 §7's env gate at the next release; see "Adjacent, deliberately out of scope".

## Spec (what & why)

Snug ships with no terms, no privacy statement, and no installer agreement, while the
product already does several things a stranger is entitled to be told about in writing:
the desktop app phones github.com on every launch (R-30), a personal sync origin carries
the user's secrets (ADR-0014), a linked WhatsApp device puts other people's messages in
front of an LLM (R-9) against WhatsApp's terms (R-10), and BYOK sends the user's prompts
and app data to a provider the user chose. The owner's goal is **legal cover** for a
solo-maintained, pre-1.0, MIT-licensed project with a hosted static playground and a
downloadable macOS binary.

The posture (owner's framing, recorded as ADR-0055): **published `/terms` and `/privacy`
do disclosure work, not contract formation** — footer-linked and reachable from Settings,
never a gate (under *Berman v. Freedom Financial*, 9th Cir., pure browsewrap fails as a
contract anyway, so gating the web playground would buy nothing and cost the first-run
experience). **Exactly one clickwrap**, at the desktop installer — the one place where the
update phone-home, the local helper, and LAN reach all begin and the user is already in
an "installing software" frame: Tauri's DMG bundler embeds a plain-text EULA as a classic
SLA resource (`bundle.licenseFile` → `bundle_dmg.sh --eula` → `hdiutil udifrez`; verified
in tauri-bundler `dmg/mod.rs:161-170` and the shipped `bundle_dmg.sh:563-594`), which
satisfies both *Berman* prongs (conspicuous notice + unambiguous assent) with no code in
the app. And **contextual consent stays the primary instrument**: the private-address band
doctrine ("a WARNING, not a refusal … the screen's job is to make sure they are asked the
question rather than shown a URL") is extended to the moments the terms pages cannot
reach in time — first saved API key, a "local" URL that is actually remote, sync-origin
connect, WhatsApp link. Connection grants are already covered by the Dynamic Auth wizard
(ADR-0016/0017) and are untouched.

### The parties (owner facts, 2026-08-23) — and the one definition that joins them

| Fact | Value |
|---|---|
| Website + hosted Playground operator | **TechVoyage LLC**, a California limited liability company (operating 14 years; owns `snugprotocol.org` on its Cloudflare account; pays for the Pages hosting, ADR-0054) — **registered spelling confirmed by the owner 2026-08-23: `TechVoyage LLC`** (no comma, one word) |
| macOS application distributed by | **Jeetu Maker** (Apple Developer ID: individual enrollment) |
| Code copyright | **Jeetu Maker** — `LICENSE` unchanged |
| GitHub org, README byline, whitepaper author, all messaging | Jeetu Maker — unchanged |
| Officers of the LLC | Jeetu Maker and spouse (not published) |

**The counterparty is never split between documents.** Every artifact (terms, privacy,
EULA) states which party does which thing — *site operated by the LLC; app distributed by
Jeetu; code copyright Jeetu* — and then collapses to one definition, verbatim and shared
via one exported constant:

> "We", "us" and "our" mean Jeetu Maker and TechVoyage LLC together, with their officers,
> members, employees and agents.

So no disclaimer or liability cap runs to the wrong party and there is no seam between
the documents. Governing law: State of California; venue: "the state and federal courts
located in the State of California" (no county); contact `hello@snugprotocol.org`;
**no postal address anywhere** (a free consumer product needs none, and the owner's home
address must never appear — the rule the USPTO domicile/mailing split already follows).

✅ **Publishing gate cleared 2026-08-23:** the owner reports `hello@snugprotocol.org`
is enabled for Cloudflare Email Routing and the destination is **verified**. (The
earlier ⛔ — terms whose only contact bounces are worse than none — is therefore
satisfied; the runbook stage 5/7 rows record the owner's verification. AC14's
deploy-script refusal was proposed only to give that gate teeth and is **dropped as
moot** — no unconfirmed scope added.)

The privacy statement is written **straight out of the threat model** (§2 assets, §4
boundary 5, §6 residuals, §7 non-claims) — it names R-30 explicitly, and it names every
third party that can observe the user. Its claims are bounded by ADR-0014 §5 and
threat-model §7 (never "zero-knowledge", never "end-to-end", never "keys never leave your
file" — those phrases may appear only in negation).

| Moment | Treatment (owner's table) | Where in the code |
|---|---|---|
| Web playground, first run | No gate — footer links only | new `shell-footer` in `App.tsx` |
| First API key / network mode | Inline disclosure band | `SettingsView.tsx` `ByokProvidersRows` |
| "Local model" URL that is not local | Inline band (highest-value band of the set — owner) | `SettingsView.tsx` local-mode block |
| Connection grant | Already covered (ADR-0016/0017) | untouched |
| Sync origin connect | Inline — secrets travel with the file | `SettingsView.tsx` `DataCard` |
| WhatsApp link | Inline — R-9 third-party disclosure | `ConnectionWizardSheet.tsx` `LinkedDeviceLinkScreen` |
| Desktop install | One EULA screen — the clickwrap | `src-tauri/EULA.txt` + `bundle.licenseFile` |
| Settings → About | Version, Terms, Privacy, threat model, update toggle | `SettingsView.tsx` `AppVersionCard` → "about" |

> **Not legal advice.** The agent drafts these documents from the codebase's own
> disclosed facts and the owner's drafting spec; counsel review of the Terms before
> flip-public stays the owner's standing item. The drafts are written to be *true about
> the software first* — every sentence traceable to an ADR, a threat-model row, or a
> test — because a disclosure that outruns the code is the one failure mode nobody can
> lawyer around.

### Interview outcomes (owner, 2026-08-23)

- **Q1 identity/law/contact** — amended as in "The parties" above. Entity spelling: **ask, never guess** (open).
- **Q2 where the text lives** — default KEPT: TS content modules in `apps/playground/src/legal/` (ADR-0055 §4). Markdown alternative REJECTED: the desktop app must render terms/privacy **offline** (a legal page needing the network is a new egress in an app whose threat model discloses a launch-time ping); `@playground` import is ADR-0048 §5's existing direction; byte-pinning the R-30 sentence is ADR-0047 §2's constant doctrine.
- **Q3 hub-origin band** — none (flag-off at launch), **plus a fail-closed guard**: a test proving that a build with `capabilities.hubAuth === true` renders the hub-origin band — so the day `VITE_SNUG_HUB_AUTH=1` flips, the disclosure ships with it (same shape as the release-inertness / wiring-not-seam lesson 2026-08-08).
- **Q4 AC6** — KEEP, and treat as the highest-value band: "local means local" is load-bearing for the honesty posture.
- **Q5 liability** — default plus three changes: (a) California Civil Code **§1668 carve-out** on the cap, "to the maximum extent permitted by law", naming fraud, willful injury and violation of law (and gross negligence), plus one honest sentence that USD 50 is not a discount on a purchase but a statement that a free, one-person MIT project cannot carry open-ended risk; (b) **a narrow indemnity** scoped to exactly four things (apps the user created/shared/published; the user's use of a third-party service, account or credential through Snug; the user's breach of a third party's terms; the user's breach of these terms or violation of law) closed with "that is the whole of it"; (c) **no 18+ age gate** — no accounts, nothing collected, so no profile of a child to hold; ask that a parent or guardian set it up and stay involved because the software connects to real accounts and sends text to a model provider (supports Kid Mode / the Beta exit criterion). Plus a **no-warranty-of-security** sentence pointing at `docs/threat-model.md` §7 "What this model does not claim" by name.

**Acceptance criteria** (each becomes at least one test):

1. **`/terms` and `/privacy` render in the playground, un-gated.** Both routes mount a
   `LegalPage` with headings from the shared content modules; `/` (HubView) renders its
   normal content with **no dialog, no `aria-modal`, no consent checkbox** anywhere in the
   tree on first run (negative — the "no gate" half is the load-bearing assertion).
2. **The privacy statement is threat-model-true and names every third party.**
   Content-module test pins, in order: (i) it leads with what does NOT happen, worded
   so it cannot outrun the code (review F4): *we operate no server, hold no account, run
   no analytics script and set no cookie; Cloudflare shows us aggregate request counts
   for the zone and GitHub shows download counts; your file and a few preferences (theme,
   layout, update-check choice) live in this browser's storage on this device — on a
   shared computer, that is where they are*; (ii) it
   embeds `UPDATE_CHECK_DISCLOSURE` (R-30) verbatim AND the two pairing sentences
   (nothing installs by itself — offered, the user chooses, ADR-0047 §3; we do not
   receive that request — it goes to GitHub); (iii) it names each row of the fixed
   third-party table — Cloudflare (hosting; IP + user-agent per request, ADR-0054); the
   user's model provider (prompts, app data, connected-service results, direct from the
   browser/app, under the provider's terms and on the user's bill); the three CDN hosts
   (**restated in `privacy.ts` and pinned equal to `CDN_ALLOWLIST` by the test** — the
   website build has no `@snugprotocol` dependency and `protocol` needs a prior build, so
   a legal module may import nothing but `legalShared.ts`; review F1 — IP + which file,
   when an app loads a library); Hugging Face (`huggingface.co` — only under the
   experimental `?webllm=1` flag, the in-browser model's weights download from there;
   review F12); GitHub (R-30, Releases download, a feedback deep-link the user reviews
   and submits); a connected sync origin (ADR-0014 §2's own words: the whole file,
   including every saved key and token — **copied continuously while selected**, not
   once: `sync.ts:147-149` pushes on an interval with `includeSecrets`; review F3); a
   linked messaging account (R-9 other people's messages reach the model provider, R-10
   may breach that service's terms, R-32 removing the last linked app touches the
   account's device list, **and once linked the helper starts with the desktop app and
   reconnects to WhatsApp on every launch until you unlink** — `lib.rs:196` →
   `sidecar::autostart_if_linked`, an automatic egress the update toggle does not govern;
   review F3); (iv) pseudonymisation is stated as a **reduction, never a guarantee**,
   carrying R-9's class statement verbatim (*anti-default and anti-naive, not
   anti-adversarial*; review F10) with a pointer to the threat model for its limits;
   (v) it says plainly Snug is **not
   zero-knowledge and not end-to-end encrypted** and describes ADR-0043 as bounded
   at-rest encryption with a key the user holds; (vi) the rights section is honest about
   being empty (CCPA/GDPR rights exist; nothing held to produce, correct, delete or opt
   out of; nothing sold or shared; the user's control is direct — export or delete the
   file).
3. **Claim discipline, mirrored from `check-whitepaper.mjs` AC6 — all four rules** (review
   F10) — across ALL published legal text (terms, privacy, EULA): (a) `zero-knowledge`,
   `end-to-end encrypt*`, `never leave(s) your file` appear **only in negation** (the
   whitepaper checker's `NEGATION_ONLY` window rule); (b) `host-blind` disclaimed, never
   claimed; (c) any mention of `passphrase`/protection carries the ADR-0043 bound ("only
   you hold" + "unrecoverable"); (d) any mention of `pseudonymis*`/scrub carries the
   ADR-0040 class statement ("anti-default … not anti-adversarial"); plus `encrypted on
   our servers` and `we protect your data` absent outright. One exported
   `findClaimViolations(text)` in `legal/claimDiscipline.ts`, run by the playground test
   over terms + privacy and by the desktop test over `EULA_TEXT`.
4. **Footer links, everywhere except inside a running app.** `shell-footer` carries
   `terms` · `privacy` · `threat model` · `MIT` links on `/`, `/build`, `/settings`,
   `/download`; it does **not** render on `/run/:id` (the app view is the product surface
   and the either/or mobile band is pinned at ≤1000px by `mobile.spec.ts`) nor on
   `/oauth/callback` (a popup; review F11).
5. **Settings → about.** The existing `AppVersionCard` becomes the `about` section: on
   desktop — version, "check for updates", the auto-check toggle (existing test-ids kept
   verbatim: `settings-check-updates`, `settings-auto-update-check`), plus links to terms,
   privacy, threat model and **the EULA text — rendered offline from `legal/eula.ts`'s
   exported `EULA_TEXT`** (the playground never imports from `apps/desktop`, ADR-0047 §2,
   and a GitHub URL needs the network — review F2; `src-tauri/EULA.txt` is byte-pinned
   to that constant by AC10); on web — the download pointer plus the same links minus
   the EULA. Existing `desktopSettingsView` / `downloadSurfaces` suites stay green
   unmodified (their selectors are not renamed); **`settingsRedesign.test.tsx:102`'s
   section-label list is the ONE deliberate edit** (`'app'` → `'about'`, review F11).
6. **BYOK saved-key band.** In `ByokProvidersRows`, while a provider's key state is saved
   (`useByokKeyPresence`), a `data-testid="byok-consent-band"` `role="note"` band renders
   naming the provider and saying plainly that the user's prompts, app data and any
   connected-service results reach that provider under the provider's own terms and on
   the user's own bill; absent while no key is saved; **the input is never disabled and
   no confirm is required** (warning-not-refusal, same shape as `lanConsentCopy.test.tsx`'s
   "still warns, never refuses").
7. **Local-mode remote-endpoint band** (the private-address doctrine applied to the field
   where the misunderstanding costs most): when `local` mode's URL host is not a local
   endpoint, a `data-testid="local-endpoint-remote-band"` band **names the host** and says
   prompts, app data and connected-service results leave this machine to it. **Two
   predicates over one parser** in `security/privateHost.ts` (review F7 — the existing
   `isPrivateNetworkHost` at `ConnectionWizardSheet.tsx:249-260` is IPv4-literal-only by
   design and would fire on the DEFAULT `http://localhost:11434/v1`): `isPrivateNetworkHost`
   (bytes unchanged — the LAN band keeps its pin) and `isLocalEndpointHost` = private ∪
   {`localhost`, `*.localhost`, `[::1]`, `0.0.0.0`, IPv6 fc00::/7, fe80::/10}. Absent for
   the default URL, `127.0.0.1`, `[::1]`, private literals; **raises** for
   `127-0-0-1.example`, `localhost.attacker.example` (public names that look local) and
   for `mymac.local` (it does leave the machine); **renders nothing, never throws** on an
   unparsable URL (`new URL('')` throws); the URL input is never disabled (self-hosted
   remote endpoints are legitimate and growing).
8. **Sync-origin band.** When the origin is `dropbox`, a
   `data-testid="sync-origin-secrets-band"` band states that the **whole file, including
   every saved key and token**, is copied to that Dropbox and that anyone with access to
   it holds those keys — **and keeps holding them: the file is re-pushed on an interval
   for as long as the origin is selected** (ADR-0014 §2 wording; review F3); absent for
   `none`. **Hub guard (Q3, owner):** on a platform fixture with `hubSyncOrigin: true,
   hubAuth: true`, selecting `hub` renders a `data-testid="sync-origin-hub-band"` band —
   written as a WARNING, not a reassurance (review F13's objection, answered): *your apps'
   data — records, chats, messages — is copied to this hub's operator; your keys are
   stripped first*. On the launch build (`hubAuth` false/absent) neither the hub option
   nor the band exists — the guard proves the disclosure is wired to the flag, not merely
   absent. **Include-secrets export** (review F12): the existing hint gains one clause —
   *the exported file then carries every saved key and token*.
9. **WhatsApp-link band (R-9/R-10).** `LinkedDeviceLinkScreen` renders a
   `data-testid="linked-device-third-party-band"` band before "start linking": the other
   people in the user's chats have not agreed to anything; when a thread is analysed its
   *content* reaches the user's model provider (names and numbers are scrubbed, the
   words are not — and the scrub is anti-default, not anti-adversarial: R-9's class
   statement, review F10); linking automation to a personal WhatsApp
   account is against WhatsApp's terms and accounts have been banned (R-10). The start
   button remains enabled (`linkedDeviceWizard.test.ts` stays green).
10. **The EULA is right, by construction.** `apps/desktop/src/__tests__/dmgEula.test.ts`
    (node env, sibling of `bundleTargets.test.ts`): `bundle.licenseFile` names a file that
    exists; **`src-tauri/EULA.txt` is byte-equal to `legal/eula.ts`'s `EULA_TEXT`** (one
    source, rendered offline in Settings → about and embedded in the DMG; review F2); the
    text passes **`checkEulaText` — defined ONCE in `scripts/release-desktop.mjs` and
    imported by this test** (review F14; one rule, two callers): ASCII-only (the SLA
    resource is `TEXT`-format Mac Roman — a curly quote or em dash renders as garbage),
    every line < 75 columns, a line cap **derived from the accepted draft plus headroom**
    (target ≤ 60; review F15 — the required content is near that budget, so the number is
    pinned after the draft exists, not before); it contains the MIT grant line and the
    warranty disclaimer paragraph **byte-identical** to `LICENSE`'s (whitespace-collapsed
    compare); it contains `UPDATE_CHECK_DISCLOSURE` and the off-switch sentence
    byte-identical to the playground constant (one-contract-two-artifacts, as
    `updaterConfig.test.ts` does for the endpoint); it names the local helper (**and that
    it starts with the app once linked** — review F3) and LAN reach; where the data
    lives + the sync-origin warning; pre-1.0; the cap with its §1668 carve-out and
    California law; the two URLs; the shared "we/us/our" definition; **nothing else** (a
    section allowlist — it is a screen someone reads standing up); and
    `findClaimViolations` over it is empty (AC3).
11. **The release script proves the DMG actually carries it** (lesson 2026-08-24: a
    config is only a contract once the platform's parser accepted it). `release-desktop.mjs`
    (a) runs `checkEulaText` over `src-tauri/EULA.txt` before building and REFUSES
    otherwise; (b) after the build runs `hdiutil udifderez -xml <dmg>` and REFUSES to
    stage a DMG whose resource dump lacks the SLA — **the checker parses the plist,
    base64-decodes the `TEXT`/`RTF ` resource `<data>`, and compares the DECODED first
    line** (review F8: the body is base64 inside `<data>`, so a raw substring check
    either always fails on the real fixture or always passes on a hand-typed one); both
    pure exported functions are tested in `release-desktop.test.mjs` against a
    **captured** `udifderez` dump of a real EULA-bearing build (positive) and a captured
    dump of a build WITHOUT `licenseFile` (negative — not a hand-edited positive). The
    refusal message names that `hdiutil udifrez/udifderez` are reported deprecated since
    macOS 12 (still present on Darwin 25 — `hdiutil udifderez -help` prints usage; the
    man-page deprecation line could not be confirmed on this machine; review F9) so the
    day they vanish the failure is diagnosable, not mysterious.
12. **Website.** `apps/website` gains `/terms/` and `/privacy/` pages rendered from the
    **same** content modules via the existing `@playground` alias (one source, two
    renderers, zero new dependencies), and the `MarketingLayout` footer gains a **Legal**
    column (Terms · Privacy · Threat model · Security). Pins: both pages exist in
    `dist/` (`buildOutput.test.ts` style); the rendered HTML contains the counterparty
    definition and the R-30 sentence (the alias path really resolved, lesson 2026-08-08);
    `externalLinkTargets` stays green.
13. **Docs stay coherent.** Threat-model R-9, R-10 and R-30 each gain one sentence
    naming where the user is told (`/privacy`, the EULA, the band); `check-threat-model`
    stays green. `internal/ip/TRACKER.md` D-02 (rows at :32 and :66) and
    `internal/cowork-project-setup.md:99` no longer claim "no entity" (gitignored — local
    edits, journaled here, never committed; C4). Runbook stage 5/7: hello@ round-trip is
    named as the gate on the legal-pages deploy; stage 7's "unsigned until the Developer
    ID lands" line is updated (the ID exists; signing is env-gated at the next release).
14. ~~The hello@ gate has teeth~~ — **DROPPED 2026-08-23**: proposed (review F5) only
    to enforce the hello@ round-trip before the legal pages could deploy; the owner
    verified the mailbox the same day, so the gate is satisfied and the deploy-script
    refusal would guard nothing. Kept as a numbered row so the AC list stays stable.
15. **The clickwrap's reach is stated honestly** (review F6). The SLA rides the DMG only;
    `Snug.app.tar.gz` is a public release asset the updater installs in place with no
    screen. ADR-0055 §2, threat-model R-30's cross-reference and `/terms` say so in one
    sentence: *the assent screen is the DMG's — a user who fetches the updater tarball
    directly, or updates in place, meets the terms via Settings → about; accepted, because
    the terms are disclosure first and the DMG is the only route we link.*

**Out of scope**:
- Any gate on the web playground or in the desktop app after install (owner decision —
  one clickwrap, at the installer, full stop).
- Cookie banners / consent-management tooling (there are no cookies, no analytics —
  README "No telemetry" + ADR-0013; the statement says so instead).
- A hosted legal-acceptance record, versioned-acceptance tracking, or re-prompting on
  terms changes (no backend to hold it — ADR-0013/0052).
- Any change to the Dynamic Auth wizard's review/approve screens (ADR-0016/0017 —
  already the stronger instrument), the mutating-call confirm, or the LAN band.
- Localisation of any legal text; an 18+ age gate (owner: contradicts Kid Mode).
- Windows/Linux installer agreements (ADR-0021 D8).
- Re-deciding the USPTO applicant (TRACKER D-02) or transferring the GitHub org to the
  LLC — this task corrects the false *fact* ("no entity") and flags the decision for the
  owner's re-confirmation; it does not change the decision.
- **Apple code-signing + notarization of the DMG.** Wired and env-gated since ADR-0047 §7;
  the Developer ID now exists (individual enrollment, owner 2026-08-23), so it activates
  on the first release built with those vars set — a release act, its own explicit ask.
  When a notarized build is verified on hardware, the Gatekeeper paragraphs in
  `DownloadView.tsx:68-71` and `download.astro:92-103` and threat-model R-29 come out —
  in that release task, not here.

## Drafting spec (owner, 2026-08-23 — binding on the content modules)

**The byte-pinned R-30 sentence** — one exported constant `UPDATE_CHECK_DISCLOSURE`,
identical in `/privacy` and `EULA.txt` (ASCII; the EULA wraps it, tests compare
whitespace-collapsed):

> The desktop app checks github.com for a new version each time it starts. That request
> tells GitHub your IP address, the time, and the version you are running. You can turn it
> off in Settings.

Paired in both places with: nothing installs by itself — an update is offered and the
user chooses (ADR-0047 §3); we do not receive that request; it goes to GitHub.

**`/privacy`** — written from threat-model §2, §4 boundary 5, §6, §7. Lead with what does
not happen (no server, no accounts, no analytics, no telemetry, no cookies, nothing held),
then the exhaustive third-party table (AC2 iii), then the honest limits (not
zero-knowledge, not end-to-end; ADR-0043 as the bounded claim; pseudonymisation as a
reduction, never a guarantee — do **not** soften the sync-origin and messaging rows: they
are the strongest disclosures in the set and earn the rest its credibility), then the
children paragraph (Q5c), then the empty-rights section, changes, contact.

**`/terms`** — must state: the parties (LLC operates the site + hosted Playground; Jeetu
distributes the macOS app; code copyright Jeetu) then the shared definition; MIT governs
rights in the code and **wins over these terms on any conflict about rights in the code**;
free and as-is with the MIT disclaimer quoted verbatim; pre-1.0 warning; no data held so
nothing is recoverable — backups are the user's job; acceptable use, with security
research **authorised under `SECURITY.md`'s safe harbour by cross-link, not restated**;
apps the user builds are theirs and their responsibility; connected services are governed
by their own terms; the narrow four-item indemnity (Q5b); the liability limits with the
§1668 carve-out and the honest USD 50 sentence (Q5a); the no-warranty-of-security
sentence naming threat-model §7; children (Q5c); changes; termination; law and venue;
contact.

**`EULA.txt`** — ASCII only, < 60 lines, lines < 75 columns. Contents in order: title;
parties + shared definition (two lines); MIT grant + warranty disclaimer verbatim; the
R-30 sentence + off-switch + "offered, never automatic"; local helper + LAN reach (only
for connections you approve in the app); where your data lives (`~/Snug`) + the
sync-origin warning; pre-1.0; the cap with carve-out + California law; the two URLs;
"Clicking Agree means you accept these terms." Nothing else.

## Plan

Read at Gate 2: `architecture.md` (dependency graph: desktop consumes playground source;
website reads it read-only via `@playground`; nothing here touches a package any other
package depends on), `code-map.md`, `lessons.md` (2026-08-24 parser lesson → AC11;
2026-08-20 "prominence that blocks is a modal with extra steps" → no gate; 2026-07-31
one-contract-two-artifacts → the R-30 constant; 2026-08-08 wiring-not-seam → AC8's hub
guard and AC12's rendered-HTML pin), ADR-0014/0043/0047/0048/0052/0054, threat-model
§1–§8, `check-whitepaper.mjs` AC6, and the code named below.

**Design notes**

- **Bands are `role="note"` `.hint` blocks with a `data-testid`**, exactly the shape of
  `review-private-host-warning` (`ConnectionWizardSheet.tsx:933-941`) — no new UI
  primitive; at most a `.consent-band` CSS modifier if the plain hint reads too quiet
  (decide with a screenshot at implementation; owner-visible). Copy is lowercase like
  every other Settings hint. Each band **names the specific thing** (provider, host,
  origin) so the user can judge — the doctrine's whole point. None disables a control or
  adds a confirm.
- **BYOK band keys on STATE, not on the click**: `keys[p]` true → band. "First entry" in
  a store that persists across sessions is not a knowable event without a new flag; the
  saved-state band is honest every time it renders and disappears when the key is
  cleared. (A one-time-only band would need a `snug_settings` key and a reason to hide a
  true statement on the second visit. Rejected.)
- **Local-endpoint classifier**: reuse the private-host predicate the LAN band uses
  (locate in `ConnectionWizardSheet.tsx` / `security/` at implementation; if it is
  module-private, lift it to `security/privateHost.ts` rather than copy it — one
  classifier, two bands; `lanConsentCopy.test.tsx` keeps pinning it).
- **Legal modules import nothing but `legalShared.ts`** (review F1): the website build
  resolves `@playground/*` by alias only (`astro.config.mjs:29`), has no `@snugprotocol`
  dependency and would SSR-externalise `zod`; anything the modules must agree with
  (`CDN_ALLOWLIST`, `LOCAL_DEFAULT_BASE_URL`) is restated and pinned equal by a playground
  test — the one-contract-two-artifacts rule, not an import.
- **One legal vocabulary module** `apps/playground/src/legal/legalShared.ts`:
  `WE_US_OUR_DEFINITION`, `SITE_OPERATOR` (the LLC name — ONE constant, filled from the
  owner's confirmed spelling), `APP_DISTRIBUTOR`, `UPDATE_CHECK_DISCLOSURE`,
  `UPDATE_CHECK_PAIRING` (the two pairing sentences), `LEGAL_CONTACT`, `GOVERNING_LAW`,
  `VENUE`, `THREAT_MODEL_URL`, `LICENSE_URL`, `SECURITY_POLICY_URL`, `TERMS_URL`,
  `PRIVACY_URL`, and the content node types. Everything the EULA must match is exported
  from here so the desktop test has exactly one import.
- **Legal content module shape**: `{ slug, title, updated: 'YYYY-MM-DD', intro, sections:
  Array<{ id, heading, blocks: Array<Paragraph | List | Table> }> }` where a paragraph is
  an array of `string | { href, label }` runs — plain data, no JSX, so Astro renders it in
  `.astro` templates without a React integration and the desktop app renders it offline.
  The third-party table is a `Table` block built from a typed array so AC2's test walks
  rows, not prose.
- **Playground footer**: rendered in `App.tsx` below `<main>`; hidden on `/run/:id` via
  `useLocation()`; `<Link>` for `/terms` `/privacy`, external links through
  `platform.openExternalUrl` when present (the side-effect-free seat from
  TASK-20260822's review, NOT `oauth.openExternal`) else `<a target=_blank>`. Pre-flip the
  GitHub URLs 404 for outsiders — the same designed-quiet state as ADR-0052's deep-links.
- **Website pages**: `src/pages/terms.astro`, `src/pages/privacy.astro` inside
  `MarketingLayout`; one shared `LegalDoc.astro` walks the content module. Footer: a
  fourth `<nav aria-label="Legal">` column.
- **EULA.txt**: `apps/desktop/src-tauri/EULA.txt` with `bundle.licenseFile: "EULA.txt"`.
  Upstream resolves the path against the **process cwd** (`dmg/mod.rs:161-162`
  `env::current_dir()?.join(license_path)`), which works because `tauri-cli`
  `set_current_dir`s into `src-tauri/` before bundling (review F15) — a programmatic or
  overlay build would resolve differently, so the AC10 existence check is the guard. The
  file is a byte-copy of `legal/eula.ts`'s `EULA_TEXT` (AC10 pins equality; copy it by
  hand or via a one-line `node -e` — no generator script, a fourth artifact).
- **Release-script checks**: `checkEulaText(text): { ok } | { ok: false; reason }` and
  `verifyDmgCarriesEula(xml, firstLine)` exported from `release-desktop.mjs`; the build
  path calls `hdiutil udifderez -xml` through the same `execSync` seam and refuses before
  staging. Sample captured from a real local `tauri build --bundles dmg` during Gate 4
  and committed beside the test.
- **Signed-release follow-up** (review F9): the first Developer-ID-signed DMG must be
  verified to notarize AND staple with the SLA resource present (unverified interaction;
  queued in `next-steps.md` as part of the signed-release owner walk).
- **`internal/` edits** are local-only (gitignored, C4): D-02 rows become "Individual
  applicant (decision of 2026-08-20 stands pending owner re-confirmation); an entity
  DOES exist — TechVoyage LLC (CA, operates snugprotocol.org + hosting); corrected
  2026-08-23"; cowork-setup line 99 likewise. Journaled here, not diffed.

**Files to touch, in order (tests first per TDD.md):**

1. `apps/playground/src/legal/legalShared.ts` — constants above + node types.
2. `apps/playground/src/__tests__/legalContent.test.ts` (AC2, AC3) → `legal/privacy.ts`,
   `legal/terms.ts`, `legal/eula.ts`; the AC3 checker is a small exported
   `findClaimViolations(text)` in `legal/claimDiscipline.ts` (all four whitepaper rules)
   so the desktop test (AC10) runs the same rule over `EULA_TEXT`.
3. `apps/playground/src/__tests__/legalPages.test.tsx` (AC1, AC4) → `views/LegalPage.tsx`,
   routes + `shell-footer` in `App.tsx`, `.shell-footer` CSS in `theme/app.css`.
4. `apps/playground/src/__tests__/settingsAbout.test.tsx` (AC5) → `SettingsView.tsx`
   `AppVersionCard` → about section (keep test-ids).
5. `apps/playground/src/__tests__/privateHost.test.ts` (AC7's two predicates, pure) →
   `security/privateHost.ts` (lift `isPrivateNetworkHost` bytes-unchanged; add
   `isLocalEndpointHost`); then `apps/playground/src/__tests__/consentBands.test.tsx`
   (AC6, AC7, AC8 incl. the hub guard + include-secrets clause — one file, three
   describes, same harness as `desktopSettingsView.test.tsx`) → `SettingsView.tsx`
   (`ByokProvidersRows`, mode block, `DataCard`, webllm card's Hugging Face sentence).
6. `apps/playground/src/__tests__/linkedDeviceThirdPartyBand.test.tsx` (AC9) →
   `ConnectionWizardSheet.tsx` `LinkedDeviceLinkScreen`.
7. `apps/desktop/src/__tests__/dmgEula.test.ts` (AC10) → `src-tauri/EULA.txt`,
   `tauri.conf.json` `bundle.licenseFile`.
8. `scripts/release-desktop.test.mjs` additions (AC10's `checkEulaText`, AC11's
   `verifyDmgCarriesEula` with plist-parse + base64-decode) → `scripts/release-desktop.mjs`
   + the calls; two captured `udifderez` fixtures (with / without `licenseFile`) —
   note step 7's desktop test imports `checkEulaText` from here, so 8's pure function
   lands before 7 goes green.
9. `apps/website/src/__tests__/legalPages.test.ts` (AC12) → `src/components/LegalDoc.astro`,
   `src/pages/terms.astro`, `src/pages/privacy.astro`, `MarketingLayout.astro` footer.
10. Docs + internal (AC13): threat-model one-liners; ADR-0055 status → accepted;
    `docs/decisions/README.md`; `docs/code-map.md` row for `legal/`; `docs/next-steps.md`
    (signed-release follow-up; counsel review); runbook stage 5/7; TRACKER D-02;
    cowork-setup :99.

**Cross-package impact**: playground → desktop (consumes playground source: run
`pnpm --filter desktop test` and the shell `gate` script since `App.tsx`/Settings change),
playground → website (`@playground` alias: run `pnpm --filter website test` incl. a
`build`). No `packages/*` touched → no dependents beyond those two apps. Root `pnpm test`
at Gate 5 (covers `check-threat-model`, `check-release-desktop`, `check-website-sync`,
`check-deploy-web`).

**Test plan summary**: 14 live ACs (AC14 dropped) → ~45 tests across 9 new/extended suites; negatives: no
gate on `/` (AC1), claim-discipline regex over all three texts (AC3), footer absent on
`/run/:id` (AC4), bands absent in the null state + inputs never disabled (AC6–9),
lookalike hosts still raise (AC7), hub band absent on the launch build AND present under
the flag (AC8), non-ASCII / over-long EULA fails (AC10/11), no-SLA DMG dump refused
(AC11). Gate 5 evidence beyond suites: one real local
`pnpm --filter desktop exec tauri build --bundles dmg` → mount the DMG in Finder and
screenshot the Agree screen (owner-visible), `hdiutil udifderez -xml` output captured as
the AC11 fixture.

**High-tier extra**: fresh-context AI review of THIS plan before implementation —
run 2026-08-23 (`ce-adversarial-document-reviewer`, 48 tool uses), 15 findings, verdict
approve-with-changes; every finding spot-checked against the tree by the planner before
folding (dispositions below).

## Decisions & surprises

- 2026-08-23 — **Tauri DMG EULA support is real and needs no code**: tauri-bundler
  `dmg/mod.rs:161-170` passes `bundle.licenseFile` as `--eula` to its vendored
  `bundle_dmg.sh`, which base64-embeds the file into the `eula-resources-template.xml`
  SLA plist and `hdiutil udifrez`es it onto the DMG (`bundle_dmg.sh:563-594` in the local
  `target/`). Format is `TEXT` unless the file is RTF → ASCII-only is the safe contract.
- 2026-08-23 — **The playground has no markdown renderer** (grep: none; `DocsPanel`
  renders records as text), so the legal text is data, not markdown (Q2, owner-confirmed).
- 2026-08-23 — **The playground has no footer today**; the website footer exists
  (`MarketingLayout.astro:69-103`). The "footer links on playground" ask therefore adds
  one element to the shell.
- 2026-08-23 — The BYOK rows already carry a custody hint ("stored in your snug file …
  never to the hub"); what they lack is the *other direction* — that the provider
  receives the user's prompts and data under the provider's terms. The band says that.
- 2026-08-23 — The linked-device screen already states the operational half (reads and
  sends as you; unlink from your phone); R-10 is on the review screen via registry
  `instructions`; **R-9 (other people's non-consent) is stated nowhere in the UI** — the
  gap AC9 closes.
- 2026-08-23 — **Owner facts changed the parties**: TechVoyage LLC (14 years, CA) owns
  `snugprotocol.org` and pays for the Cloudflare Pages hosting; Jeetu personally signs
  and distributes the binary and holds the code copyright. `internal/ip/TRACKER.md` D-02
  and `internal/cowork-project-setup.md:99` said "no entity" — false as of today;
  corrected locally (gitignored). Resolved by ONE shared counterparty definition rather
  than two sets of documents.
- 2026-08-23 — Runbook stage 7 line 177 **already** lists "security@ AND hello@ verified
  round-trip"; what was missing is the dependency — the legal pages' production deploy
  hangs on it. Sharpened rather than duplicated.
- 2026-08-23 — Counsel-shaped changes from the owner: §1668 carve-out (an absolute cap
  invites a court to strike the whole clause; a bounded one survives with a hole), a
  four-item indemnity (R-9/R-10 are a real third-party-claim path the user alone
  creates), no 18+ gate (contradicts the Beta exit criterion at `internal/07-roadmap.md:54`).

- 2026-08-23 — **Fresh-context plan review, 15 findings, dispositions** (each verified
  against the tree before folding): **F1** website build cannot import `@snugprotocol/protocol`
  (no dependency, alias-only resolution, zod SSR-externalised) → restate + pin-equal
  (AC2, design note). **F2** the "EULA link" had no source → `legal/eula.ts` `EULA_TEXT`,
  `EULA.txt` byte-pinned (AC5/AC10). **F3** the privacy statement would have misstated
  automatic egress: `lib.rs:196` autostarts the WhatsApp helper on every launch once
  linked, and Dropbox pushes on an interval with `includeSecrets` (`sync.ts:147-149`) →
  named in the messaging + sync rows and the EULA (AC2/AC10). **F4** "no analytics /
  nothing held / no cookies" overclaimed (zone-level aggregates; OPFS + `localStorage` in
  `theme.ts`/`railLayout.ts`/`appUpdate.ts`; Bot-Fight cookie is a checklist item, ADR-0054
  §8) → reworded to what the code can vouch for (AC2 i). **F5** the hello@ gate was a
  checklist promise coupled to whole-app deploys → AC14 gives it a refusal in
  `deploy-web.mjs` (owner may strike). **F6** the clickwrap covers the DMG route only
  (`Snug.app.tar.gz` is public, the updater shows no screen) → said in one sentence
  (AC15, ADR-0055 §2). **F7** `isPrivateNetworkHost` is IPv4-literal-only; the default
  local URL is `localhost` → two predicates over one parser (AC7). **F8** the SLA body is
  base64 inside `<data>` → decode before compare, real negative fixture (AC11). **F9**
  `udifrez/udifderez` reported deprecated since macOS 12 (present on Darwin 25; man-page
  line unconfirmed) → named in the refusal message + notarize/staple check queued.
  **F10** mirror all four whitepaper AC6 rules; class statement on the R-9 band (AC3/AC9).
  **F11** `settingsRedesign.test.tsx:102` pins the `app` label → one deliberate edit;
  footer also hidden on `/oauth/callback` (AC4/AC5). **F12** Hugging Face is a third party
  under `?webllm=1`; include-secrets export gets its clause (AC2/AC8). **F13** "drop the
  hub band — it is a reassurance, not a warning" → **modified, not accepted**: the owner
  asked for the guard (Q3), and the reviewer's objection is answered by writing the band
  as the warning it should be — app data (records, chats, messages) reaches the hub
  operator, keys stripped first (AC8). **F14** `checkEulaText` defined once (AC10).
  **F15** `licenseFile` resolves against the cwd, not the config dir; the 60-line cap is
  derived from the draft with headroom (design note, AC10). Reviewer confirmed: nothing
  touches C1/C2, spec-sync, or the updater artifact/`latest.json`; High tier is correct.

## Session journal (append-only, newest last)

### 2026-08-23 — Claude (for Jeetu) — session (Gates 1–2)
- Done: repo read (PROCESS, TEMPLATE, architecture graph, code-map, lessons, threat-model
  §1–§8, ADR-0014/0047/0052/0054, `SettingsView`, `ConnectionWizardSheet` link screen +
  LAN band, `DownloadView`, `App.tsx` routes, website layout/footer/tests, `release-desktop.mjs`,
  `bundleTargets.test.ts`, tauri config + vendored `bundle_dmg.sh`, upstream `dmg/mod.rs`);
  task file written with 12 ACs and a 5-question interview carrying defaults; ADR-0055
  drafted; branch created off `main` @ `af307f8`; owner memory updated (Apple Developer
  account, 2026-08-23).
- State: planned — stopped for owner interview/plan approval.

### 2026-08-23 — Claude (for Jeetu) — session (interview folded, plan amended)
- Done: owner answered Q1–Q5 with amendments + a drafting spec + the entity facts; task
  file rewritten (parties section, shared counterparty definition, hello@ hard gate,
  AC2 expanded to the third-party table, AC3 claim-discipline checker, AC7 lookalike
  negatives, AC8 hub-flag guard, AC10/11 EULA constraints enforced twice, AC13 internal
  corrections); ADR-0055 amended (§6 parties, §7 liability posture, §8 children);
  `internal/` corrections applied locally; runbook stage 5/7 sharpened; owner memory
  updated with the entity facts; High-tier fresh-context plan review run (15 findings,
  each spot-checked in the tree, all folded — AC2/3/4/5/7/8/9/10/11 amended, AC14/AC15
  added, design notes extended).
- State: **planned — awaiting the LLC's exact registered name (owner must confirm
  against the CA SoS search; never guessed), a yes/no on AC14 (the deploy-script
  refusal — the one addition beyond the owner's ask), and explicit plan approval.** No
  implementation code written.
- Next step: on approval → Gate 3 tests first in the listed order; `SITE_OPERATOR`
  constant filled from the owner's confirmed spelling.
- Open questions: (1) exact registered name of the LLC; (2) approval.

### 2026-08-23 — Claude (for Jeetu) — session (approval → Gate 3)
- Done: owner confirmed `TechVoyage LLC`; owner reports hello@ enabled + verified (gate
  cleared, AC14 dropped as moot); plan approved ("go ahead with the commit"); plan
  documents committed; runbook stage 5/7 + memory updated.
- State: **in-progress — Gate 3 (tests first) starting in the listed order.**
- Next step: `legal/legalShared.ts` → `legalContent.test.ts` (red) → content modules.

### 2026-08-23 — Claude (for Jeetu) — session (Gates 3–4, tests first)
- Done, in the planned order, each suite red before its implementation: `legal/legalShared.ts`
  (vocabulary + content model), `legal/claimDiscipline.ts` (all four whitepaper AC6 rules,
  returns violations so the checker can be proven non-decorative), `legalContent.test.ts`
  (29) → `privacy.ts` / `terms.ts` / `eula.ts`; `legalPages.test.tsx` (11) →
  `views/LegalPage.tsx`, `ui/ExternalLink.tsx` (the side-effect-free `openExternalUrl`
  seat), routes + `ShellFooter` in `App.tsx`, CSS; `settingsAbout.test.tsx` (3) → the
  `about` section (EULA rendered offline from `EULA_TEXT`; `settingsRedesign.test.tsx`'s
  label list is the one deliberate edit); `privateHost.test.ts` (30) →
  `security/privateHost.ts` (LAN predicate lifted bytes-unchanged + `isLocalEndpointHost`);
  `consentBands.test.tsx` (19) → BYOK / local-endpoint / dropbox / hub bands, the
  include-secrets clause, the Hugging Face sentence; `linkedDeviceThirdPartyBand.test.tsx`
  (3) → the R-9/R-10 band before "start linking"; `dmgEula.test.ts` (11) →
  `src-tauri/EULA.txt` (byte-copy of `EULA_TEXT`, 57 lines, max 71 cols, ASCII) +
  `bundle.licenseFile`; `release-desktop.test.mjs` (+5) → `checkEulaText` /
  `verifyDmgCarriesEula` + main() wiring (pre-build shape refusal; post-build
  `hdiutil udifderez -xml` proof), `scripts/release-desktop.d.mts` typed contract,
  negative fixture captured from the pre-existing EULA-less DMG (`hdiutil` printed
  `WARNING: udifderez is deprecated` — review F9 confirmed as fact); website
  `legalPages.test.ts` (7) → `Legal{Doc,Runs}.astro`, `terms.astro`, `privacy.astro`,
  the footer Legal column (5-col grid; 2-col at ≤760px unchanged). Docs: threat-model
  R-9/R-10/R-30 cross-references, ADR-0055 accepted + index, code-map row, next-steps
  entry (counsel review; signed release + staple check; udifrez deprecation; owner
  Finder walk; TRACKER D-02 re-confirmation).
- Evidence so far: playground `legalContent`/`legalPages`/`settingsAbout`/`consentBands`/
  `privateHost`/`linkedDeviceThirdPartyBand` + neighbours green; desktop vitest 186/186 +
  `tsc` clean after the `.d.mts`; website build green (both pages emitted) + 42/42;
  `release-desktop.test.mjs` 11/12 pending the positive fixture (a real
  `tauri build --bundles dmg` with `licenseFile` is running).
- Two test defects of my own, fixed in the test not the code: an over-broad `.seg button`
  selector (caught the default-provider seg, which legitimately disables unkeyed
  providers) and a non-generic query helper the typecheck refused.
- State: **in-progress — Gate 4 nearly complete; waiting on the DMG build for AC11's
  positive fixture, then root `pnpm test`, the Gate-5 fresh-context diff review, journal
  sign-off.**
- **AC11 evidence (2026-08-23):** a real `tauri build --bundles dmg` with
  `bundle.licenseFile` produced `Snug_0.1.0_aarch64.dmg` (9.1 MB vs 8.3 MB for the
  EULA-less image); `hdiutil udifderez -xml` over it → `scripts/fixtures/udifderez-with-sla.xml`
  (15.3 KB, `LPic` present; the no-SLA fixture is 9.1 KB with none) —
  `release-desktop.test.mjs` 12/12. Then the platform's own behaviour, not just its
  parser: `yes | hdiutil attach -nobrowse -noautoopen -readonly <dmg>` printed the
  agreement — line 1 `Snug for macOS - License Agreement` … line 57 `Clicking Agree means
  you accept these terms.` — BEFORE mounting `/Volumes/Snug`, then detached clean. The
  Finder rendering of the same screen stays on the owner walk (next-steps).

### 2026-08-24 — Claude (for Jeetu) — review (Gate 5)
- **Fresh-context diff review (High tier, second of two): 12 findings, verdict
  merge-after-fixes — ALL twelve applied**, plus one residual noted. The three MAJORs
  were truthfulness gaps in MY prose, exactly the class the plan review had already
  taught once: **(1)** "delete the file and it is gone" was FALSE for a linked WhatsApp
  account — the helper's session keys, minted token and thread cache (other people's
  messages) live BESIDE the file in `~/Snug/whatsapp-session` (`sidecar.rs`
  `session_store_dir`), don't ride exports, and survive file deletion → new paragraph in
  "Where your data lives", the rights row, and two EULA lines (58/60 — headroom pin
  relaxed 3→1 with the owner's "under 60" as the stated hard wall); **(2)** privacy
  promised a Settings warning for any non-machine endpoint while the band deliberately
  treats the user's own network as local (`192.168.1.20` pinned quiet) → "on this machine
  or your own network"; **(3)** "no other automatic outbound except the helper" omitted
  the Dropbox 30-second interval push — the exact egress my own new lesson names →
  "and a sync origin you selected". Minors: webllm also pulls its runtime library from
  `raw.githubusercontent.com` (named); the udifderez deprecation note now fires on the
  verb FAILING (try/catch → named refusal), not only on a dump without `LPic`;
  `verifyDmgCarriesEula` upgraded to FULL-TEXT compare (first-line-only waved through a
  stale EULA with the same title; `.d.mts` + both tests updated; fixture recaptured from
  a rebuilt DMG — 15.5 KB, session-store line visible on `hdiutil attach`); feedback
  wording corrected (content reaches GitHub at the confirmed jump, not at submit);
  ADR-0055 "three bands"→four + EULA contents list completed; code-map counts corrected
  (legalPages 12, privateHost 38); lessons re-ordered newest-first; footer gains a
  ≤1000px 3-column step (five tracks squeezed below ~100px); `isLocalEndpointHost`
  accepts one trailing dot (v4-mapped hex stays a documented accepted-remote); EULA
  heading regex hardened with a sentence-case lookahead; the website test pins the
  indemnity section id instead of duplicating a prose pin. **Residual recorded in the
  runbook**: if `VITE_SNUG_HUB_AUTH=1` ever ships, the privacy table needs a
  hub-operator + Google-sign-in row first (the AC8 guard covers the Settings band only).
- Review confirmations worth keeping: C1/C2/IPC untouched; no `dangerouslySetInnerHTML`;
  `ExternalLink` rides the https-only `openInSystemBrowser`; `isPrivateNetworkHost`
  lifted byte-identical; `licenseFile` touches ONLY the DMG (SLA added before codesign;
  no effect on `Snug.app.tar.gz` / `latest.json` / minisign); `check-threat-model` TM3
  hashes only the deltas — untouched.
- Evidence after fixes: playground touched suites 107/107 + full 1637 earlier + tsc;
  desktop `dmgEula` 11/11 + tsc; website rebuilt + 42/42; `release-desktop.test.mjs`
  12/12 on the recaptured fixture; final root `pnpm test` running (first root run was
  exit 0).
- **Self-sign-off (High tier):** the two hard constraints are untouched by construction
  and by review — no credential path, no sandbox/CSP/IPC change; the release-config
  surface (tauri.conf.json `licenseFile`, release-desktop.mjs) is covered by
  `dmgEula.test.ts`, 5 new node tests over REAL fixtures, and a real build whose SLA was
  verified by the platform three ways (udifderez parse, full-text decode-compare,
  `hdiutil attach` presenting the agreement before mount). I sign off on this diff.
