# 0055 — Legal disclosure posture: published terms + privacy as disclosure, one clickwrap at the installer, contextual consent as the primary instrument

- **Status:** accepted (owner plan approval 2026-08-23 — "TechVoyage LLC" confirmed as the registered spelling, hello@ verified, "go ahead"; §6–§9 record the interview answers)
- **Date:** 2026-08-23
- **Task:** TASK-20260823-legal-terms-privacy-eula

## Context

Snug is pre-launch with no terms of use, no privacy statement and no installer agreement,
while the software already performs acts a user is entitled to be told about in writing:

- the desktop app checks github.com for updates on every launch by default — a
  phone-home carrying IP, time and version (threat-model **R-30**, ADR-0047 §9);
- a personal sync origin the user connects carries the **whole file, secrets included**
  (ADR-0014 §2 — custody working as designed, and the one place "your keys" leave the
  device);
- a linked WhatsApp device puts **other people's messages** in front of the user's model
  provider (R-9), against WhatsApp's terms (R-10), and deleting the last such app reaches
  the user's WhatsApp device list (R-32);
- BYOK sends the user's prompts, app data and connected-service results to a provider the
  user chose, under that provider's terms;
- app iframes fetch from a fixed CDN allowlist (C2) and the hosted site + playground are
  static files on Cloudflare Pages (ADR-0054) — third parties that observe requests.

The owner is a solo maintainer in California shipping an MIT-licensed reference
implementation, a hosted static playground and a downloadable macOS binary; the goal is
legal cover without degrading a product whose consent story is already stronger than a
terms page. Two facts shape the answer:

1. Under *Berman v. Freedom Financial Network* (9th Cir. 2022), **pure browsewrap does not
   form a contract** — a footer link nobody clicks binds nobody. Gating the web playground
   behind a click would form one, at the cost of the first-run experience the whole
   product is built around (lessons 2026-08-20: prominence that blocks is a modal with
   extra steps).
2. The codebase already practices **contextual consent at the moment of the act** — the
   private-address band (`lanConsentCopy.test.tsx`: "a WARNING, not a refusal … the
   screen's job is to make sure they are asked the question rather than shown a URL"),
   the wizard's verbatim host/template review (ADR-0016/0017), the mutating-call confirm
   naming host, method and URL (threat-model R-8 v3). That is a higher standard of
   informed consent than any terms page reaches, and it is where the user actually is
   when the thing they should know about happens.

## Decision

1. **`/terms` and `/privacy` are published disclosure, not contract formation.** They are
   footer-linked on the playground and the website, and reachable from Settings → about;
   they are never a gate on the web playground or inside the installed app. Their job is
   to be *true about the software*: the privacy statement is written from the threat model
   (§2 assets, §4 boundary 5, §6 residuals, §7 non-claims), names **R-30 explicitly**
   (disclosing the phone-home gains more than hiding it could lose), and names every third
   party that can observe the user — including the ones a first draft missed (the Hugging
   Face weights download under the experimental in-browser model flag; the WhatsApp
   helper's launch-time reconnect once linked) — and says only what the code can vouch
   for ("we run no analytics script and set no cookie", not "no analytics", since
   Cloudflare shows the zone owner aggregate counts regardless). Its claims are bounded
   by ADR-0014 §5 and threat-model §7: never "zero-knowledge", never "end-to-end", never
   "keys never leave your file".
2. **Exactly one clickwrap, at the desktop installer.** The DMG carries a plain-text EULA
   as a classic SLA resource via Tauri's `bundle.licenseFile` (→ `bundle_dmg.sh --eula`
   → `hdiutil udifrez`) — the macOS "Agree / Disagree" screen before the volume mounts.
   One screen, ASCII-only, under sixty short lines: the parties and their shared
   definition, the MIT grant and its warranty disclaimer verbatim, the update-check
   disclosure with its Settings off-switch, the local-helper + LAN-reach disclosure
   (including the session store living beside the file), where the user's data lives,
   the pre-1.0 warning, the liability cap with its section 1668 carve-out, and the two
   URLs.
   This is the one place where the phone-home, the local sidecar and LAN reach all
   begin, the user is already in an "installing software" frame, and both *Berman* prongs
   (conspicuous notice, unambiguous assent) are met by the OS itself with no code in the
   app. The release script **verifies the built DMG actually carries the SLA resource**
   before staging (lessons 2026-08-24: a config is only a contract once the platform's
   parser accepted it). **Stated honestly:** the assent screen is the DMG's — the updater
   installs `Snug.app.tar.gz` in place with no screen, and that tarball is a public
   release asset — so a user who fetches it directly, or updates in place, meets the
   terms via Settings → about. Accepted, because the terms are disclosure first and the
   DMG is the only route we link. `hdiutil udifrez/udifderez` are reported deprecated
   since macOS 12 (still present on macOS 26); the release script names that in its
   refusal so the eventual removal is diagnosable.
3. **Contextual consent remains the primary instrument, and the band doctrine is extended**
   to the moments the terms pages cannot reach in time: the first saved BYOK key (what
   the provider receives, under whose terms, on whose bill), a "local model" URL whose
   host is not actually local (the private-address doctrine applied to the field where
   the misunderstanding costs most — "local means local" is load-bearing for the whole
   honesty posture), a sync-origin connect ("your whole file, including every saved key
   and token, is copied there — and re-copied for as long as it stays selected" —
   ADR-0014 §2's own words), and WhatsApp linking (R-9's other-party non-consent and
   R-10's ToS/ban risk, on the screen with the "start linking" button; and that the
   helper starts with the app on every launch once linked). Every band **names the specific
   thing** (provider, host, origin), is a `role="note"` warning that never disables the
   control or adds a confirm, and keys on state the code can actually know (a saved key,
   a selected origin, a non-local host) rather than on a "first time" flag the store
   cannot honestly keep. Connection grants stay with the Dynamic Auth wizard
   (ADR-0016/0017), untouched.
4. **One source for the legal text.** Terms and privacy are plain-data TypeScript content
   modules in the playground (`apps/playground/src/legal/`), rendered by the playground
   (offline in the desktop app) and by the website through the `@playground` alias it
   already uses for `releaseChannel.ts`. The R-30 sentence is one exported constant that
   the EULA text is byte-pinned to. No markdown dependency is added.
5. **No acceptance record, no versioned re-prompting, no cookie/consent tooling.** There
   is no backend to hold an acceptance (ADR-0013/0052) and no cookies or analytics to
   consent to; the statement says so instead. A change to the terms is a dated edit to
   the content module and a release note.
6. **One counterparty definition joins two real parties.** The website and hosted
   Playground are operated by **TechVoyage LLC** (a California LLC that owns
   `snugprotocol.org` and pays for the Cloudflare Pages hosting, ADR-0054); the macOS
   application is signed and distributed by **Jeetu Maker** personally (individual Apple
   Developer enrollment); the code copyright is Jeetu Maker's and `LICENSE` is unchanged.
   Naming the LLC is accurate, not decorative. The documents are **never split between
   counterparties**: each artifact states which party does which thing, then collapses to
   one shared definition, exported once and used verbatim everywhere —
   *"We", "us" and "our" mean Jeetu Maker and TechVoyage LLC together, with their
   officers, members, employees and agents.* — so no disclaimer or cap runs to the wrong
   party and there is no seam between the documents. California law; venue "the state and
   federal courts located in the State of California" (no county); contact
   `hello@snugprotocol.org`; **no postal address is ever published**. The LLC's exact
   registered name is confirmed by the owner against the CA Secretary of State search
   before use — a contract naming a non-existent entity is a defect.
7. **Liability posture.** MIT-strength "AS IS" quoted verbatim; a nominal USD 50 cap
   written "to the maximum extent permitted by law" with an explicit **California Civil
   Code §1668 carve-out** (fraud, willful injury, violation of law; gross negligence) so
   the clause survives with a hole rather than dying whole, plus one honest sentence that
   the figure is not a discount on a purchase but a statement that a free, one-person MIT
   project cannot carry open-ended risk; **a narrow four-item indemnity** — apps the user
   created, shared or published; the user's use of a third-party service, account or
   credential through Snug; the user's breach of a third party's terms; the user's breach
   of these terms or violation of law — closed with "that is the whole of it" (R-9/R-10
   are a real third-party-claim path the user alone creates; a broad consumer indemnity
   is neither honest for a free OSS tool nor reliably enforceable); a
   **no-warranty-of-security** sentence pointing at `docs/threat-model.md` §7 by name;
   MIT wins over the terms on any conflict about rights in the code; security research
   is authorised by cross-link to `SECURITY.md`'s safe harbour.
8. **No 18+ age gate.** The Beta exit criterion is that an 11-year-old succeeds unaided
   (`internal/07-roadmap.md`); an 18+ clause would contradict a shipping goal. Instead the
   documents state that there are no accounts and nothing is collected — so there is no
   profile of a child to hold — and ask that a parent or guardian set it up and stay
   involved, because the software connects to real accounts and sends text to a model
   provider.
9. **Publishing is gated on a working contact address.** `/terms` and `/privacy` reach
   production only after `hello@snugprotocol.org` round-trips from an outside account
   (runbook stage 5/7) — terms whose only contact bounces are worse than none.

## Alternatives considered

- **Clickwrap on the web playground's first run.** Rejected: forms a contract *Berman*
  would recognise, but at the cost of the un-gated first run; and a hosted static app
  with no accounts has no durable place to record the acceptance anyway, so the second
  visit would ask again or forget.
- **Clickwrap on first launch of the desktop app (in-app), instead of the DMG SLA.**
  Rejected: duplicates the OS-provided screen with app code, a state flag and a test
  surface, for an acceptance the installer already captured. The DMG screen is also the
  earlier moment — before the binary runs at all.
- **Terms/privacy as markdown in `docs/legal/`, rendered only by the website.** Cheaper,
  but the desktop app's "terms" link would then need the network and the playground's
  footer would leave the app; and the playground has no markdown renderer, so an in-app
  copy would mean a dependency or a hand-rolled parser. Data modules cost nothing and
  render in both.
- **A "first time only" band for the BYOK key.** Rejected: needs a persisted flag and a
  reason to hide a true statement on the second visit; the saved-state band is honest
  every time it renders and vanishes when the key is cleared.
- **No indemnity at all** (the first draft's default). Rejected by the owner: R-9/R-10
  describe a third-party-claim path created entirely by the user's own choice; a narrow,
  enumerated indemnity is honest about that. A **broad consumer indemnity** stays rejected.
- **An absolute liability cap.** Rejected: under Civil Code §1668 an unqualified
  exculpation invites a court to strike the clause whole; the bounded form with named
  carve-outs is the one that survives.
- **An 18+ age gate.** Rejected: contradicts the Kid Mode direction and the Beta exit
  criterion; replaced by the parent-or-guardian paragraph.
- **Two document sets, one per party.** Rejected: a seam between the LLC-operated site and
  the Jeetu-distributed binary is exactly where a disclaimer or cap could run to the wrong
  party; one shared definition covers both.

## Consequences

- The playground gains a footer, two routes and an "about" Settings section; the website
  gains two pages and a Legal footer column; the DMG gains an Agree screen; Settings and
  the wizard gain four warning bands (BYOK key, local endpoint, sync origin, messaging link). No protocol, runner, auth or Rust change; no new
  dependency.
- The threat model's R-9, R-10 and R-30 each gain one sentence naming where the user is
  told (`/privacy`, the EULA, the band) — disclosure becomes part of the residual's
  "bounded by" line, never a substitute for the control.
- Apple signing/notarization is unaffected and still env-gated (ADR-0047 §7); with the
  Developer ID now in hand (owner, 2026-08-23) it activates at the next release, which is
  its own explicit ask. The Gatekeeper paragraphs and R-29 come out in that release.
- `internal/ip/TRACKER.md` D-02 and `internal/cowork-project-setup.md` ("no entity")
  were false as of 2026-08-23 and are corrected locally (gitignored, C4); the USPTO
  applicant *decision* is flagged for the owner's re-confirmation, not changed.
- The documents are drafted by the agent from the codebase's disclosed facts and the
  owner's drafting spec and are **not legal advice**; counsel review of the Terms before
  flip-public is the owner's standing item.
