# Spec v0.3 draft — Connected Apps: requirements, grants, and credential custody (staging)

> **Status: DRAFT, staged locally. NOT staged for any push.** This document is a
> *carve-out*, created under an explicit owner decision on 2026-08-10 so that the v4
> auth surface has a written home while it is being built. It is **not** cleared for
> publication: the whole auth surface publishes no earlier than **Beta exit**, and the
> AL-12 staging item remains **HELD**. Nothing here has been pushed to
> `snugprotocol/spec`, and pushing requires an explicit human ask in that session
> (PROCESS release rules, C3).
>
> Source of truth for every constant, shape, and DDL statement below:
> `packages/protocol/src/connection-requirement.ts`,
> `packages/protocol/src/render-directive.ts`, and
> `packages/protocol/src/userdb-schema.ts` (the last locked by the DDL snapshot test).
> Where this prose and those files disagree, the files win and this document is the bug.
>
> **Version note (TASK-20260810, 2026-08-10):** the reference implementation carries an
> **internal v4 draft** of the storage schema (`PRAGMA user_version = 4`), adding the
> `snug_connections` table. v4 is **additive over v3**: v3's own internal-draft table
> keeps shipping alongside it through the cutover, so a v4 file contains both. Published
> `SPEC-v0.2-draft.md` describes **v2** and is unaffected — it already carries the note
> that the reference implementation runs ahead of it internally.
>
> **Wire protocol is UNCHANGED at v1.** No frame is added, removed, or altered by this
> draft. What v0.3 adds is a storage layer, a validation contract, and a set of host
> obligations. In particular there is still **no frame through which a running app can
> ask for a credential** (§2).
>
> **Version note (TASK-20260812-desktop-auth-awareness P3, 2026-08-13 — internal-staged,
> not pushed):** `request` gains an optional `queryTemplate` seat (§4.4.2) with its own
> query-parameter-name charset; header-template rules are unchanged. Staged here per
> SPEC_SYNC; AL-12 remains HELD and nothing is pushed to `snugprotocol/spec`.
>
> **Version note (TASK-20260812-desktop-auth-awareness P5, 2026-08-13 — internal-staged,
> not pushed):** the requirement gains an optional `lanHost` seat and `declaredApiHosts`
> becomes **required-XOR-`lanHost`** (§4.8), so a provider whose API lives on a device on
> the user's own network is declarable at all. Non-LAN requirements are byte-identical to
> v0.3-as-of-P3. Staged here per SPEC_SYNC; AL-12 remains HELD and nothing is pushed to
> `snugprotocol/spec`.

## 1. What a connection is

A **connection** binds one app to one third-party provider, so that the host — never the
app — may attach real credentials to outbound requests on that app's behalf.

v0.3 splits the concept in two. This split is the whole substance of the version:

- A **connection requirement** describes *what the app needs*: the provider, the auth
  kind, the credential fields, the registration walkthrough, endpoints and scopes, the
  header/signing template, and the hosts it declares it will call. It is **credential-free**
  and is written at **authoring** moments — app build, an auth-touching edit, or a
  starter install.
- A **connection grant** describes *what the user allowed*: approved status, the
  **frozen** host ceiling, the approval timestamp, and the revocation tombstone. It is
  written **only** on an explicit user approval act.

Credential **values** are in neither. They live in `snug_secrets` under the `auth:`
namespace (§5) and never enter a requirement, a grant, an LLM prompt, or an app iframe.

An app holding requirements but no grant is in the normal pre-connect state: its
network calls fail closed and the user is offered a connect flow. A conforming host
**never** treats the presence of a requirement as permission to attach a credential.

Rationale for the split, stated once because it explains most of the rules that follow:
the two halves have different writers, different lifetimes, and different trust. Fusing
them (as the internal v3 draft did) forces a host to choose between persisting an
ungranted thing shaped like a grant, or re-deriving what the app needs every time the
user opens the connect flow — which pushes provider inference into the *run* surface,
where it does not belong.

## 2. Who may create a requirement

**A running app may never propose a connection.** There is no frame, no SDK call, and no
announce field through which app code can ask for a credential grant. This is unchanged
from v0.2's posture and is re-affirmed normatively here.

Exactly three proposers exist, and the review each receives is fixed:

| Proposer | Channel | Review |
|---|---|---|
| the user | Settings / connect CTA | manual entry |
| the app's builder assistant | a `connection_requirement` directive in the build conversation (§4) | strong, unless the registry rung pinned the values |
| the install act | the starter's own `connection.json`, vouched at install | **always strong** (field-by-field) |

Two obligations bind all three:

1. **A proposer may write `declared` rows only.** No proposer may create, modify, or
   revive a grant. A write aimed at an `approved` row must be refused (the changed
   requirement stages instead, §3.3); a write aimed at a `revoked` row must be refused
   outright — reconnecting after a revocation is an explicit user act, and the host must
   disclose the prior revocation when offering it.
2. **Approval is the only writer of grants.** Freezing the host ceiling, stamping
   `approved_at`, and collecting credentials happen only inside the approval act.

## 3. Storage — user-DB schema v4

`PRAGMA user_version = 4`. Migration from v3 is **additive**: one new table, no data
movement, no column changes. Normative DDL is `USERDB_DDL` in
`packages/protocol/src/userdb-schema.ts`.

### 3.1 `snug_connections`

```sql
CREATE TABLE IF NOT EXISTS snug_connections (
  app_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  requirement_json TEXT NOT NULL,
  requirement_version INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL,
  status TEXT NOT NULL,
  pending_requirement_json TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  allowed_hosts TEXT NOT NULL DEFAULT '[]',
  approved_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, slot)
)
```

| Column | Normative meaning |
|---|---|
| `app_id` | host-assigned app identity. Never app-claimed. |
| `slot` | stable connection id **within** the app, `^[a-z0-9][a-z0-9-]{0,39}$` (e.g. `coinbase`). Lowercase and dash-only by construction: SQLite compares these bytes exactly, so a mixed-case form would fork one provider into two rows, and a dotted form would invite confusing a slot with a host. |
| `requirement_json` | the requirement (§4), credential-free, schema-valid. |
| `requirement_version` | integer, bumped on every persisted replacement whose **canonical form differs**. |
| `provenance` | `registry` \| `inference` \| `user_docs` \| `starter` \| `user`. Drives review posture and the never-overwrite-a-user-confirmed-row rule. |
| `confidence` | model-derived confidence when provenance is model-derived. **Display-only** — it drives a lower-confidence band in review and never an approval decision. |
| `status` | `declared` \| `approved` \| `revoked`. Exactly three values (§3.2). |
| `pending_requirement_json` | a changed requirement staged against an **approved** row (§3.3). |
| `imported` | `1` when the row arrived by DB import and must be re-reviewed. A column, not a requirement field — the requirement schema is strict and has no seat for an envelope flag. |
| `allowed_hosts` | the **FROZEN** host union, computed at approval. Sorted, unique, normalized. |
| `approved_at` / `revoked_at` | grant timestamps. `revoked_at` is a **tombstone** and survives. |

The primary key is `(app_id, slot)`. v0.2's internal auth draft keyed on `app_id` alone,
which made one-connection-per-app a *structural* fact; keying on the pair makes it a
*doctrine* choice that can be lifted without a schema change. A conforming host **MUST**
bound declared slots per app: the reference implementation pins
`AUTH_MAX_SLOTS_PER_APP = 8`. Byte-level write guards bound bytes per write, not row
count, so without a row bound a hostile or broken build can flood the user's connections
screen. Replacing an existing slot does not count against the cap; **revoked tombstones
do** count, since they are exactly what a flooding attacker leaves behind.

### 3.2 Status is three values, and "needs re-approval" is derived

`declared | approved | revoked`. There is deliberately **no fourth value**.

A connection whose approved grant has a change waiting is surfaced as *needs
re-approval*, but that state is **DERIVED**:

```
needs_re_approval  ⟺  status = 'approved' AND pending_requirement_json IS NOT NULL
```

A fourth status value would require a write that moves a row *out of* `approved` in order
to signal a *pending* change — which is precisely the silent de-grant/re-grant the
staging seat exists to prevent, and it would put that transition on the edit pipeline's
write path rather than the user's.

### 3.3 Write rules (normative)

A conforming host exposes exactly five writers, and each is the sole legal author of one
transition:

| Writer | Legal on | Effect | Refuses |
|---|---|---|---|
| `putDeclaredConnection` | absent or `declared` row | insert or replace a declared row | `approved` (stage instead), `revoked` (explicit reconnect only), over-cap new slot |
| `stagePendingRequirement` | `approved` row | writes `pending_requirement_json` **only** | any non-`approved` row |
| `approveConnection` | `declared` row | freezes `allowed_hosts` from the requirement, stamps `approved_at`, status → `approved` | — |
| `reapproveConnection` | `approved` row with pending | promotes pending → current, **re-freezes** hosts, clears pending | — |
| `revokeConnection` | `approved` row | status → `revoked`, stamps `revoked_at`, **keeps the row**, wipes the `auth:<appId>:<slot>:*` credential slice | — |

`stagePendingRequirement` is the seat that makes re-approval honest. While a change is
staged, the grant continues serving `requirement_json` **and its old frozen hosts** — a
host MUST NOT bind the executor to `pending_requirement_json`. The user is shown the
field-by-field diff old→pending, and only re-approval promotes it. There is no path by
which an edit widens a host ceiling without a human seeing the diff.

`requirement_version` bumps when the **canonical form** of the requirement differs across
a persisted replacement. Canonicalization is: recursive **key** sort, whitespace-free
JSON. **Array order is preserved and is significant** — `registration.instructions` is a
numbered walkthrough where step 3 before step 1 is a different walkthrough, `fields` is
the wizard's input order, and `scopes` is what review renders. Sorting arrays would
collapse two requirements a user reads as different into one identity, letting a
reordered walkthrough ride through as a no-op with nothing re-reviewed.

### 3.4 Import reconciliation

A user DB is portable, so an imported file's connection rows are untrusted input. On
import, for each incoming `snug_connections` row:

- **byte-identical** `(app_id, slot, requirement_json, allowed_hosts)` to a locally
  **approved** pre-import row → the local grant is **restored**. Identical rows carry no
  new attack surface, and blanket demotion would revoke every approval on each routine
  two-device sync and train approval fatigue.
- **anything else** that validates strictly → lands `declared` with `imported = 1`,
  `approved_at` cleared, and `allowed_hosts` **recomputed from the requirement** rather
  than trusted from the column.
- **structurally unusable** rows → dropped, and reported to the user rather than
  silently discarded.

Because branch 1 compares stored `allowed_hosts` bytes, **host-union output stability is
normative**: `deriveConnectionAllowedHosts` MUST be sorted, unique, and normalized, or an
otherwise-unchanged connection misses branch 1 and mass-demotes on the first sync pull,
which reads to a user as "the update logged me out of everything".

### 3.5 Self-healing and the legacy credential slice

Two host obligations that are easy to omit and expensive to omit:

1. **Verify tables against `sqlite_master`, do not trust the version stamp.** A
   forward-only migrator stamps `PRAGMA user_version` on completion, so the stamp claims
   which migrations *ran* — never that the tables they create *exist*. A file can read as
   v4 with `snug_connections` missing (interrupted write, partial restore, a migration
   that threw after the stamp), and the forward-only loop will then run nothing. A
   conforming host verifies the expected table set on open and replays the idempotent DDL
   on any miss. `CREATE TABLE IF NOT EXISTS` cannot touch a present table, so surviving
   rows are untouched.
2. **Wipe the pre-v4 non-slot credential slice exactly once**, on the open that advances a
   file to v4. v3-era keys are `auth:<appId>:<field>` with no slot; under v4's slot-keyed
   shape those rows hold **real credential values that nothing in v4 lists, reads, or
   wipes** — orphaned secrets in a file that syncs. The wipe MUST be scoped by **segment
   count**, never by prefix: both shapes begin `auth:<appId>:`, so a prefix delete would
   also take every live v4 credential. It MUST run once rather than on every open, because
   the v3 writer legitimately keeps running during the additive cutover window.

## 4. The connection requirement contract

Schema: `connectionRequirementSchema` (`packages/protocol/src/connection-requirement.ts`).
Strict at every level — an unknown key anywhere is a rejection, never a passthrough, so a
seat added in a future version cannot ride in unreviewed on a channel that predates it.

```
connectionRequirement = {
  slot,                    // ^[a-z0-9][a-z0-9-]{0,39}$
  provider: { name,        // ≤120, printable ASCII, NFC (§4.2)
              homepageUrl?, docsUrl? },        // https, ≤300
  kind,                    // api_key | bearer_token | basic_auth
                           // | oauth2_client_creds | oauth2_auth_code | none
  fields?,                 // 1..8 × { key ^[a-z0-9_]{1,40}$, label ≤80,
                           //          type text|secret|password|url,
                           //          description? ≤200, placeholder? ≤60, required? }
  registration?: { consoleUrl?,                // https, ≤300
                   instructions? },            // ≤10 × ≤300, PLAIN TEXT (§4.3)
  endpoints?,              // authorize/token/refresh/revoke, https, ≤300
  scopes?,                 // ≤64 × ≤200
  pkce?, authorizeParams?,
  request?: { headerTemplate?,                 // ≤8 entries, name ^[A-Za-z0-9-]{1,64}$,
                                               // value ≤300 (§4.4)
              queryTemplate? },                // ≤8 entries, name ^[A-Za-z0-9_.\[\]-]{1,64}$,
                                               // value ≤300 (§4.4.2)
  userLayer?,              // registry-synthesized ONLY (§4.5)
  lanHost?: { class,       // 'rfc1918-ipv4-literal' (single-member union; additive)
              label },     // ≤80, rendered above the wizard's address input (§4.8)
  declaredApiHosts?,       // 1..32 × ≤253, bare hostnames, normalized.
                           // REQUIRED-XOR-lanHost: required and non-empty when lanHost
                           // is ABSENT; when lanHost is present it is either absent
                           // (pre-collection) or EXACTLY ONE host of the declared
                           // class (post-collection) — §4.8
  testRequest?             // { method: 'GET', pathAndQuery ≤200, leading '/' }
}
```

### 4.1 Kinds, including `none`

Six kinds. `none` is the keyless provider — a public API needing no credential but still
needing a host ceiling. It is a first-class member rather than "no connection row",
because modelling keyless apps as an absent row loses the host gate entirely.

`none` carries a coherence rule enforced at parse: a `none` requirement **must** carry no
`fields` and no `request` template. There is nothing for the flow to collect and nothing
for the executor to inject, so a half-formed row would otherwise reach the grant path and
fail at the worst moment. `declaredApiHosts` stays **required** for `none`: keyless means
"no credentials", never "no host gate". A `none` connection with no grant still fails
closed.

`declaredApiHosts` is a **request** for a ceiling, never the ceiling. The frozen ceiling
is `snug_connections.allowed_hosts`, derived at approval as: `declaredApiHosts` ∪ every
OAuth endpoint host (authorize, token, **refresh** — it receives long-lived credentials —
revoke) ∪ the embedded `userLayer`'s endpoints and declared hosts.

### 4.2 Provider name: the confusable guard, and its stated limits

`provider.name` is printable ASCII (U+0020–U+007E) and NFC-normalized.

It stops **non-ASCII homoglyphs** (`ѕpotify` with Cyrillic U+0455 renders as "spotify" to
a careful reader; fullwidth Latin, zero-width characters and bidi overrides are the same
attack) and, equally important, **registry-key evasion**: registry lookup normalizes to
`[a-z0-9]`, so a homoglyph name normalizes to a *different* key, misses the registry,
misses the borrow ban of §4.6, and keeps attacker-authored endpoints while *looking*
pinned.

It does **not** stop pure-ASCII lookalikes. `5potify`, `Spotlfy` and `C0inbase` are
accepted by this rule, and no charset rule can reject them without rejecting legitimate
names. Those are carried by §4.6's host-intersection trigger (a lookalike is only useful
if it also names a real provider host) and by the review screen's provenance disclosure.
A conforming host **MUST NOT** present this guard to users as protection against
lookalike names.

### 4.3 Registration walkthroughs are plain text

`registration.instructions` are rendered as a numbered list of **plain text** — never as
HTML, never as links. They arrive from an untrusted channel and are displayed with the
host's own chrome and legitimacy; markup here would be phishing wearing the host's
clothes. `consoleUrl` is https-only and must be rendered with its **full host visible**.

### 4.4 Header templates and the pinned helper enum

`request.headerTemplate` places credentials into outbound requests. The schema bounds the
envelope (entry count, header-name charset, value length); the **content** rule cannot be
expressed in the schema because it depends on the sibling `fields` list, so it is a
separate **lint** that a conforming host MUST apply before a requirement is reviewed,
stored, or rendered.

A template value may reference **only**:

- a **declared field key** from this requirement's own `fields`;
- a **pinned request token**: `request.method` · `request.url` · `request.pathAndQuery` ·
  `request.body` · `request.timestamp`;
- a **pinned helper**: `timestamp` · `hmac_sha256` · `hmac_sha256_b64` · `base64`;
- a quoted literal.

The grammar is **flat**: a helper call is a placeholder form, never an argument form. A
conforming host MUST reject a nested call such as
`{{hmac_sha256_b64(api_secret, timestamp(), request.body)}}` and MUST NOT evaluate it.
`request.timestamp` exists so the timestamp is nonetheless writable in argument position —
see §4.4.1.

The lint's load-bearing job is making the render engine's *unknown-token-as-literal*
fallback unreachable. In argument position that fallback is silent and wrong:
`{{hmac_sha256(api_secrt, request.body)}}` — one transposed character — signs the
eight-byte string `"api_secrt"` instead of the credential and produces a plausible 64-hex
signature the provider rejects. A conforming host rejects that at review time, not at
signing time.

**A quoted argument is a literal in the ENGINE, not only in the lint.** Because the lint
accepts a quoted argument without examining it, a conforming host MUST render a quoted
argument **verbatim** — it MUST NOT resolve the quoted text against the credential fields
or the request tokens. `{{base64('api_key')}}` MUST render `base64("api_key")`, the
literal token text, even when `api_key` is a declared field holding a live credential.
A host that strips the quotes and then resolves the bare text emits the **credential**
from a template that passed review precisely because the quotes made it look inert. This
is a credential-disclosure requirement, not a formatting one.

`hmac_sha256_b64(secret, ...messageParts)` computes
`base64(HMAC-SHA256(base64decode(secret), concat(messageParts)))` — the three transforms
**fused** into one fixed-shape helper rather than exposed as a general `base64decode()`
primitive. It exists because that composition is otherwise inexpressible: the hex HMAC
returns hex unconditionally, the base64 helper is utf8-in so it cannot re-encode raw
digest bytes, and the grammar has no nesting. The message tail is variadic because real
prehash strings are multi-part concatenations and the argument grammar splits on commas.

#### 4.4.1 `request.timestamp` and the one-timestamp rule

**The timestamp MUST be evaluated once per render pass and memoized.** Two independent
evaluations can straddle a second boundary, so a signed timestamp and a sent timestamp
would disagree intermittently — an occasional, hard-to-diagnose auth failure rather than a
clean one.

`request.timestamp` is the token that makes the memoization *reachable*. Every signing
scheme of this shape sends the timestamp in one header and signs it inside another, so the
timestamp must be writable in **argument** position — and the helper form `timestamp()`
cannot go there, because the grammar admits no nested calls. Without this token the
canonical Coinbase-Exchange template is not expressible at all.

`request.timestamp` is a **render fact**, not a request fact: a conforming host mints it
during the render pass rather than reading it from the request, so it resolves even when
no request context is supplied, and it MUST be served from the **same** memoized value as
`{{timestamp()}}`. The two spellings MUST NOT be able to disagree within one pass.

The conformance property is not that two rendered timestamp headers are equal — two frozen
clocks satisfy that. It is that an HMAC **recomputed independently from the timestamp value
the host actually sent** equals the signature the host sent:

```
CB-ACCESS-TIMESTAMP: {{request.timestamp}}
CB-ACCESS-SIGN:      {{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}
```

#### 4.4.2 Query-parameter templates

`request.queryTemplate` places credentials into the **query string** of outbound
requests — the placement some providers require and header templates cannot express
(OpenWeather's `?appid=`, CoinGecko's demo key).

Query-parameter **names** get their own charset, `^[A-Za-z0-9_.\[\]-]{1,64}$`, rather
than reusing the header rule: real query parameters carry underscores
(`x_cg_demo_api_key` — a name the header rule's alnum+dash would reject), dots, and
bracketed forms (`filter[key]`), while header names must stay proxy-safe. Both charsets
still exclude every character that could smuggle URL structure or template
metacharacters past the review code box: `=`, `&`, `%`, `?`, `#`, space, quotes and
braces.

Query-template **values** follow §4.4 in full and verbatim: the same ≤300-char bound,
the same reference vocabulary (declared field keys, pinned request tokens, pinned
helpers, quoted literals), the same flat grammar, and the same lint obligations. A
conforming host MUST derive the header-template and query-template value lints from
**one** resolution of the declared field keys — two lints that can disagree about
"declared" is a known defect shape, not a style preference.

The `none` coherence rule of §4.1 closes over this seat: a `none` requirement carrying a
request template of either placement is rejected at parse.

Rendered query values are **credentials inside a URL**, which makes the URL itself
secret-bearing — unlike a header template, where the URL stays inert. Two host
obligations follow:

- **Placement after the ceiling.** A conforming host MUST render query credentials into
  the URL only **after** the frozen-ceiling host checks have passed, so the ceiling
  decision is always made against the app-supplied URL.
- **Scrubbing is enumerated, not aspirational.** The credentialed URL MUST NOT appear in
  any surface the app, the model, or the user's logs can read: fetch-error messages
  (network errors routinely embed the full URL), response echo surfaces, LLM-visible
  inspectors, and host UI surfaces. The request URL returned to the app is the URL the
  app asked for, **never** the credentialed one.

### 4.5 `userLayer` is registry-synthesized only

The embedded org→user second layer keeps two-layer providers expressible. It is
**rejected on the assistant, manifest, user-docs and user channels** — on the basis of
*where it came from*, never what it says. A `userLayer` pointing at genuine provider URLs
is still a model-authored seat, and the next one will not point at a genuine provider.

### 4.6 The registry-borrow ban

A host may keep a registry of pinned providers. A requirement that **names** a registry
provider, **or** whose `declaredApiHosts` **intersect** a registry entry's hosts, has the
registry's pinned values **substituted** for its own: hosts, endpoints, registration
block, and the display name. Declared values for those seats are **discarded, not
merged**.

Both triggers are required. Name-match alone is evaded by renaming; host-match alone is
evaded by trading on a brand in the review screen while declaring no overlapping host.
The ban is **kind-agnostic** — an `api_key` requirement naming a known OAuth provider
must not borrow its legitimacy while pointing the credential at a host of its choosing.

A host that reports a borrow MUST surface it: "these values came from the host's
registry, not from the app" is a materially different provenance claim than the declared
one.

### 4.7 The `connection_requirement` directive

Requirements reach the host from a build conversation as a `connection_requirement`
directive: `{ v, kind: 'connection_requirement', requirement, confidence?, provenance? }`.

`confidence` and `provenance` on the wire are **display-only**. The host computes
provenance from the channel it actually received the directive on and recomputes
confidence from the ladder rung it resolved; no gating decision reads the claimed values.

### 4.8 LAN-class providers: `lanHost` and the host XOR

*(TASK-20260812-desktop-auth-awareness P5, ADR-0023 Decision 1 — internal-staged.)*

A provider whose API lives on a device on the **user's own network** — a Philips Hue
bridge is the first — has no host any registry or author can pin: the address belongs to
the user's router. Before this seat such a requirement was **unrepresentable**, because
`declaredApiHosts` was both required and `.min(1)`.

`lanHost` is a DECLARATION THAT A HOST WILL BE COLLECTED, never a host:

```
lanHost = { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' }
```

`class` is a single-member union today. Future device classes are **additive** — a new
literal plus its own validator and its own admission rule, never a widening of this one.

**The host XOR (normative).** Exactly one host source, and the rule follows from what
consumes the seat: `deriveConnectionAllowedHosts` unions `declaredApiHosts` into the
frozen ceiling at approval, and that ceiling is the runtime injection wall. So the
collected address must be able to live in `declaredApiHosts` — there is no second path by
which a ceiling could freeze around the user's device.

| `lanHost` | `declaredApiHosts` | verdict |
| --- | --- | --- |
| absent | 1..32 hosts | **accepted** — every pre-P5 requirement, unchanged |
| absent | absent or `[]` | **refused** (`declaredApiHosts` required) |
| present | absent | **accepted** — the pre-collection shape a LAN registry entry emits |
| present | exactly one host **of the declared class** | **accepted** — the post-collection shape the wizard writes |
| present | a host outside the class (public, loopback, link-local, DNS name, IPv6) | **refused** |
| present | two or more hosts | **refused** |
| present | `[]` | **refused** |

A public host beside a `lanHost` would freeze a public host into a ceiling the review
screen presents as "a device on your own network" — a credential aimed anywhere, wearing
LAN clothes. A second private literal is a second device the user never paired.

**Host obligations.** (a) `deriveConnectionAllowedHosts` returns `[]` for a pre-collection
LAN row: an empty ceiling refuses every host, which is the correct answer before an
address exists. The binding wizard order is therefore **collect the address → approve the
row → freeze the ceiling → pair**. (b) The schema is the FIRST of two seats that refuse an
off-class host; the registry-borrow ban re-validates the class independently, because a
requirement can reach admission without passing through this schema (§4.6, and the
envelope-boundary rule in §6). (c) Nothing platform-conditional is persisted: a LAN row
opened on the web hub is **disclosed** as desktop-only, never refused or rewritten.

## 5. Credential custody (unchanged in substance)

Credential values live in `snug_secrets` and nowhere else:

| Key | Holds |
|---|---|
| `auth:<appId>:<slot>:<fieldKey>` | one credential value |
| `auth:<appId>:<slot>:_connection` | dynamic connection state for that slot |
| `auth:_flow:<flowId>` | in-flight authorization state (the slot rides in the payload) |
| `auth:_state_hmac` | app-agnostic flow-state key |

The rules from v0.2 §4 carry over verbatim: secrets exist in the local runtime copy, are
stripped from hub-origin pushes and default exports (VACUUMed so freed pages leak
nothing), and never enter `localStorage`/`sessionStorage`, any frame posted to an app
iframe, or any hub request.

Two rules specific to connections:

- **Revocation wipes the slot's credential slice** (`auth:<appId>:<slot>:*`) while
  **keeping the row** as a tombstone. Revoking must not leave values behind, and it must
  not leave the user's decision invisible.
- **A requirement never contains a credential value.** It contains field *definitions*.
  A conforming host that finds a credential-shaped value inside a requirement rejects the
  requirement.

## 6. Host obligations, restated

A conforming host:

1. **Never lets an app propose a connection at runtime** (§2) and never treats a
   requirement as permission.
2. **Applies the full validation stack before a requirement is shown, stored, or acted
   on**: schema bounds → template lint → registry-borrow ban → provider-name guard.
3. **Renders every re-admitted seat verbatim in the approval review** — each field's label
   and description, every registration step, the header template uncollapsed in a code
   box, and the complete host list with the freeze disclosure. This is not a UX
   preference: the v0.3 contract trades "the channel cannot express it" for "the user sees
   exactly what it expresses", and a review that truncates or summarizes voids the trade.
4. **Discloses provenance honestly** — model-inferred content is labelled a guess, not an
   authority; starter-shipped content is labelled as shipped-with-the-starter.
5. **Attaches credentials host-side only**, to hosts within the frozen ceiling, and fails
   closed on anything else. Credentials never enter the app iframe (C1) and never reach a
   model.
6. **Discloses a prior revocation** when offering to reconnect a provider the user
   previously revoked, keyed by provider/host rather than by slot name — a slot-keyed
   disclosure is evaded by re-declaring the same provider under a fresh slot.

## 7. Known limits of this draft

Stated rather than implied, because this is a draft and its gaps are the reason it is not
published:

- **Residual risk is accepted, not eliminated.** An approved-but-hostile header template
  can route a secret into an unexpected header of an *already-allowed* host; the frozen
  ceiling bounds who receives it, and the verbatim review is what a human is expected to
  catch it with. Helper encoding (`base64`, `hmac_sha256_b64`) defeats value-match
  scrubbing by design. Pure-ASCII lookalike provider names are accepted (§4.2). See
  ADR-0017 §Residual risk.
- **Multi-account per provider is out of scope.** Slots are per-provider, not per-account.
- **Asymmetric signing schemes (JWT/ES256/EdDSA) are not GENERICALLY expressible** by
  the pinned helper enum. The reference implementation ships exactly one
  provider-scoped signer outside this draft's surface — `cdp_jwt`, minting a
  Coinbase-CDP EdDSA (Ed25519) JWT (ADR-0030; ES256 at v1 per ADR-0022, since
  dropped) — and generalizing that into a spec-level rung is deliberately NOT
  pre-built: each new signing scheme is a reviewed helper addition, never a
  configuration knob.
- **The kind set is closed at six.** Widening it is a schema version change, not a
  configuration change.
- **This is v0.3 DRAFT prose for an internal implementation.** The reference
  implementation is the authority; publication is gated at Beta exit.
