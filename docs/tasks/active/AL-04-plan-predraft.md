# PRE-DRAFT (v0) — Gate-2 plan — AL-04 auth-wizard (TASK id assigned at instantiation)

> Written while AL-03 is in flight. Sections marked [AL-03-DEP] get filled from AL-03's shipped shapes before this becomes v1 and goes to its fresh-context plan review. Tier HIGH (protocol render-directive + playground auth UX + inferrer on the transport seam).

## Scope (roadmap A3, umbrella AL-04)
1. **auth-spec-inferrer** ported from OProject (571 loc, confidence-gated <0.7 → forced user confirmation), re-seated on the AgentTransport `complete(prompt)` seam (per audit: takes plain `(prompt)=>Promise<string>`; sever orchestrator coupling).
2. **Docs-fetch fallback ladder** for the browser: pinned well-known registry → web-capable BYOK models (the model browses docs via its own knowledge; NO host-side fetching of arbitrary docs URLs — that would be an unfrozen network surface) → user-pasted docs text → (documented future rung: desktop-native fetch, A6 deferred).
3. **Render-directive contract** standardized in `packages/protocol` (internal draft, out of SOURCES): the `{kind:'auth_wizard', ...}` directive shape (audit: identical in both source trees — protocol-grade), plus the reserved `auth_required` wire message finally getting its real payload schema.
4. **Wizard/card/dialog REBUILT on playground components** (~2.3k source loc is Next.js-coupled — rebuild on contract, not lift): branches static (api_key/bearer/basic) · oauth2_auth_code (PKCE popup via RedirectUriProvider/CallbackSink from AL-02) · client_creds · spec_confirm (low-confidence inference review). Replaces the INNARDS of AL-03's minimal Connections panel; the panel remains the settings seat (AL-03 plan, closed Q4).

## Binding forward-constraints inherited (verbatim sources: AL-02/AL-03 task files)
- Credential values NEVER enter `snug_chat_messages` (any field incl. `meta`), chat context assembly, or inspector state — the AL-02 canary test gets its real counterpart here; byte-probe post-wizard chat export.
- `expectedFlowId` supplied from the CALLER'S OWN held copy — never parsed out of the callback payload/state (tautology trap).
- Approval display: the FULL frozen host list (punycoded form) shown at approval/re-approval — nothing enters the ceiling unreviewed (AL-02 D2/D5; punycode display per AL-02 review finding 2).
- Wizard collects secrets in component state only; writes go through CredentialStore; no persistence of partial wizard state to any synced/exported table. [Check against AL-03's confirm-gate session-remember pattern for in-memory-only precedent.]
- Inference-poisoning posture (roadmap A10): inferred specs are PROPOSALS; the confidence gate + user review is the trust boundary; famous providers ALWAYS resolve from the pinned registry, never inference (audit: "refuses to default scopes, refuses runtime discovery").
- BroadcastChannel name = flowId (AL-02 D6); popup-closed polling backstop (audit: use-skill-oauth-flow pattern).

## [AL-03-DEP] To fill from AL-03's shipped code before v1
- Exact net frame + error-code names the wizard surfaces to users (e.g. NET_NOT_APPROVED → "connect this app" CTA wiring).
- The Connections panel component names/APIs whose innards get replaced.
- The `imported_unapproved` re-approval flow surface (AL-03 ships the status gating; the wizard owns the re-approval UX).
- Whether AL-03's confirm dialog established a modal pattern to reuse.

## Test plan skeleton
- Inferrer: confidence gate forces confirmation <0.7 (boundary cases); famous-provider bypass (registry hit → NO inference call, mutation-checked); poisoned-docs proposal always lands in spec_confirm with hosts highlighted; transport-seam fake.
- Render directive: schema validation, out-of-SOURCES guard extended, KB≡SDK/wire-literal sync if any literal is shared.
- Wizard: per-branch component tests + one real-browser Playwright per category (static key → snug_secrets write via store; oauth PKCE popup e2e against a LOCAL fake IdP fixture over https — reuse AL-03's self-signed stub pattern; spec_confirm flow); chat-canary byte-probe post-wizard.
- Negative: wizard never renders a credential value back after save (write-only pattern — cf. the queued settings key-echo finding, don't repeat it); DOM value-attribute echo test.
- Live sweep: full byok wizard run for an api_key app (stub provider), oauth popup flow (fake IdP), a real inference proposal on the live key (cheap single call), console/DOM/export probes.

## Open questions to resolve at v1 (candidates for the plan reviewer)
- Does the inferrer run on the BUILDER thread's transport (billing/caching implications — cache flag must NOT be set on inference turns? check ADR-0012 scope) or a dedicated one-shot call?
- Wizard entry points: builder chat directive → in-chat card → sheet; AND Connections panel → sheet. Same component, two mounts — state ownership?
- Where does the "dev-registration walkthrough copy" (per-provider guides, B1 polishes them) live NOW — knowledge store per ADR-0004, or component copy? (Spectrum starters AL-09 need Spotify's walkthrough at least stub-grade.)
