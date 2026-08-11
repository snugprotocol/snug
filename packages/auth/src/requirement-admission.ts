/**
 * Requirement ADMISSION — the channel gate every `connectionRequirement` passes through
 * before it reaches review, storage, or a credential prompt
 * (TASK-20260810-p0-contracts, AC5/AC9; parent plan folds T-M7 and S-M3).
 *
 * Two independent guards share this one seat, because they answer the same question at
 * the same moment: given WHO authored this requirement, which of its claims may stand?
 *
 *   1. USER-LAYER ADMISSION (AC5, fold T-M7). `userLayer` is a REGISTRY-SYNTHESIZED seat
 *      only. It is rejected on every other channel because of WHERE it came from, never
 *      because of what it says — a userLayer pointing at genuine Spotify URLs is still an
 *      LLM-authored seat, and the next one will not point at Spotify. This closes a hole
 *      that is live today: `llmProposalSchema` omits `userLayerFields` but NOT
 *      `userLayerEndpoints`/`userLayerScopes`/`userLayerPkce`, so an LLM proposal can
 *      already aim the three-legged consent flow at endpoints it chose, and the user sees
 *      a real-looking consent screen on an attacker's host.
 *
 *   2. REGISTRY-BORROW BAN (AC9, fold S-M3). A requirement that NAMES a registry provider,
 *      or whose `declaredApiHosts` INTERSECT a registry entry's `apiHosts`, has the
 *      registry's pinned values substituted for its own; the declared values for those
 *      seats are DISCARDED, not merged. Today the registry is consulted for
 *      `oauth2_auth_code` only and only by name, so `kind:'api_key'` +
 *      `providerName:'Spotify'` borrows Spotify's legitimacy while pointing the credential
 *      at an attacker-chosen host. The ban is kind-AGNOSTIC for exactly that reason.
 *
 * WHY BOTH TRIGGERS. Name-match alone is evaded by renaming; host-match alone is evaded by
 * declaring no overlapping host while still trading on the brand in the review screen. The
 * host trigger is the load-bearing one — it is what catches a lookalike NAME
 * (`Spotlfy`, `C0inbase`) that the protocol's confusable guard deliberately does not
 * claim to stop, because that requirement still has to name the real host to be useful.
 *
 * WHAT SUBSTITUTION MEANS, precisely: on a hit the registry's `apiHosts` REPLACE
 * `declaredApiHosts` (evil.example is gone, not appended), the registry's endpoints
 * replace declared endpoints, the registry's `registration` block replaces any declared
 * walkthrough, and `provider.name` is pinned to the registry's display name — the last
 * one because the review screen renders `provider.name`, and a surviving declared name
 * would let attacker copy sit next to registry-grade hosts.
 *
 * WHAT SUBSTITUTION CANNOT REACH, and why that is a REFUSAL (review MAJOR-1). The seats
 * that drive the credential prompt — `fields` (what the user is asked to type),
 * `request.headerTemplate` (where the typed secret is sent) and `testRequest` — must never
 * be carried over from a borrower, because substitution ADDS legitimacy: a label reading
 * "Paste your Spotify password" rendered beside registry-grade hosts and the registry's
 * own display name. So a borrow hit from a non-registry channel that OCCUPIES any of those
 * seats is REFUSED outright rather than admitted with a partial correction.
 *
 * `fields` IS NOW SUBSTITUTABLE — and the asymmetry is the point (P4, fold T-M1). The
 * registry carries a human-reviewed field list per provider, so a borrower that OMITS
 * `fields` RECEIVES the pinned one, while a borrower that AUTHORS them is still refused.
 * Refusing the authoring case only made sense once the omitting case was answered: before
 * P4 the registry had nothing to substitute, so a bare borrower reached the credential
 * step with ZERO input boxes and the wizard reported success having stored nothing. The
 * borrower does not get to name the boxes; it no longer needs to.
 *
 * `request.headerTemplate` and `testRequest` remain unsubstitutable and therefore
 * refusal-only: the registry pins WHAT to ask for, not where the typed value is sent.
 *
 * WHAT THIS IS NOT. Admission is not authorization. A clean pass here means "these claims
 * may be SHOWN to the user", never "this app may have a credential". The frozen host
 * ceiling (`snug_connections.allowed_hosts`, computed at approval) remains the runtime
 * wall, and the strong field-by-field review remains the human one.
 */

import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  type WellKnownOauthProvider,
} from './well-known-providers.js';

/**
 * The five authoring channels — the same literals as `CONNECTION_PROVENANCES`
 * (packages/protocol), which are PERSISTED column values. Kept structurally identical so
 * a channel and the provenance it writes can never drift apart.
 */
export const ADMISSION_CHANNELS = ['registry', 'inference', 'user_docs', 'starter', 'user'] as const;

export type AdmissionChannel = (typeof ADMISSION_CHANNELS)[number];

export interface AdmissionOptions {
  channel: AdmissionChannel;
}

export interface AdmissionIssue {
  /** Dotted path to the offending seat, so a rejection can be shown in place. */
  path: string;
  message: string;
}

export interface AdmissionResult<T = unknown> {
  ok: boolean;
  /**
   * True when the registry-borrow ban fired. Reported rather than hidden: the review
   * screen must be able to say "these values came from Snug's registry, not from the
   * app", which is a materially different provenance claim than the declared one.
   */
  borrowed?: boolean;
  /** Registry key that triggered the borrow, for the review's provenance copy. */
  borrowedFrom?: string;
  /** The requirement AFTER substitution. Unchanged when nothing borrowed. */
  requirement: T;
  issues: readonly AdmissionIssue[];
}

/**
 * Structural readers. Admission runs at the ENVELOPE boundary (C5), which means it may be
 * handed input that has not yet been — or never will be — parsed by
 * `connectionRequirementSchema`. So every read is defensive: a malformed seat must make
 * the guard MISS-SAFE (treat it as absent) rather than throw, because a thrown TypeError
 * here would be an availability bug on the path whose whole job is to fail closed.
 */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const readProviderName = (requirement: Record<string, unknown>): string | undefined => {
  const name = asRecord(requirement['provider'])?.['name'];
  return typeof name === 'string' ? name : undefined;
};

const readDeclaredHosts = (requirement: Record<string, unknown>): string[] => {
  const hosts = requirement['declaredApiHosts'];
  return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [];
};

/**
 * Host normalization for the intersection test: lowercase + trailing-dot strip only.
 *
 * Deliberately NOT `normalizeAuthHost` (packages/protocol): this comparison must be
 * exact-host, and the parent test pins that `api.spotify.com.evil.example` does NOT
 * intersect `api.spotify.com`. A suffix or substring test would be the wrong guard here —
 * it would fire on unrelated hosts and, worse, would invite the belief that this ban
 * catches lookalike DOMAINS. It does not; the frozen host ceiling and the review's
 * provenance copy carry that case.
 */
const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '');

/** Registry key -> normalized apiHosts, built once. Small registry; rebuilt cheaply. */
function registryHostIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    for (const host of entry.apiHosts) index.set(normalizeHost(host), key);
  }
  return index;
}

/**
 * Find the registry entry this requirement is borrowing from, by either trigger.
 *
 * The name path goes through `lookupWellKnownProvider` — the registry's OWN
 * normalization (`toLowerCase().replace(/[^a-z0-9]/g,'')`) — rather than a plain string
 * compare. That is not a nicety: the registry RESOLVES `Spotify!` and `S-p-o-t-i-f-y` to
 * the Spotify entry, so a stricter equality check in the ban would miss exactly the
 * spellings the rest of the system already treats as Spotify. The evasion would be free
 * and the borrow would still land.
 */
function findBorrowedEntry(
  requirement: Record<string, unknown>,
): { key: string; entry: WellKnownOauthProvider } | undefined {
  const name = readProviderName(requirement);
  if (name !== undefined) {
    const entry = lookupWellKnownProvider(name);
    if (entry !== undefined) {
      const key = Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY).find(([, value]) => value === entry)?.[0];
      if (key !== undefined) return { key, entry };
    }
  }

  const index = registryHostIndex();
  for (const host of readDeclaredHosts(requirement)) {
    const key = index.get(normalizeHost(host));
    if (key !== undefined) {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      if (entry !== undefined) return { key, entry };
    }
  }
  return undefined;
}

/**
 * The seats that DRIVE A CREDENTIAL PROMPT: what the user is asked to type, where the
 * typed value is sent, and the first request it is sent on.
 *
 * These are refused rather than corrected on a borrow hit from an authoring channel. For
 * `request.headerTemplate` and `testRequest` the reason is unchanged: the registry has
 * nothing to substitute them WITH — it pins hosts, endpoints, registration copy and (since
 * P4) a field list, but never where a typed secret is sent.
 *
 * `fields` stays on this list even though the registry CAN now substitute it, and that is
 * deliberate. Correcting an authored field list would silently discard copy the borrower
 * wrote and admit the requirement anyway, so an app that asked for the wrong secret would
 * simply be fixed up and shown as legitimate. Refusal is the honest outcome: a borrower
 * that authors prompt copy is telling us it disagrees with the pinned list, and that
 * disagreement is not ours to paper over. The bare borrower — the shape starters actually
 * ship — never reaches this list at all and receives the pinned fields.
 */
const CREDENTIAL_PROMPT_SEATS = ['fields', 'request', 'testRequest'] as const;

/**
 * Which credential-prompt seats does this requirement actually carry?
 *
 * `request` counts only when it carries a `headerTemplate` — an empty `request` object
 * says nothing about where a secret goes, and refusing on it would reject shapes that
 * declare no prompt at all.
 */
function occupiedPromptSeats(requirement: Record<string, unknown>): string[] {
  const occupied: string[] = [];
  for (const seat of CREDENTIAL_PROMPT_SEATS) {
    const value = requirement[seat];
    if (value === undefined || value === null) continue;
    if (seat === 'request') {
      if (asRecord(value)?.['headerTemplate'] !== undefined) occupied.push('request.headerTemplate');
      continue;
    }
    if (seat === 'fields' && Array.isArray(value) && value.length === 0) continue;
    occupied.push(seat);
  }
  return occupied;
}

/**
 * Apply the registry's pinned values over the declared ones.
 *
 * Substitution is REPLACEMENT, never a merge: merging would let a declaration keep
 * `evil.example` alongside `api.spotify.com` and still present as registry-backed, which
 * is the whole harm. Endpoint seats are only written when the registry has them, so a
 * static-kind requirement does not sprout OAuth URLs it has no use for.
 */
function applyRegistryValues(
  requirement: Record<string, unknown>,
  entry: WellKnownOauthProvider,
): Record<string, unknown> {
  const provider = { ...(asRecord(requirement['provider']) ?? {}) };
  if (entry.displayName !== undefined) provider['name'] = entry.displayName;

  const substituted: Record<string, unknown> = {
    ...requirement,
    provider,
    declaredApiHosts: [...entry.apiHosts],
  };

  // THE CREDENTIAL FIELD LIST — the seat whose absence WAS the founding defect.
  //
  // Guard 2b refuses a borrowing channel that AUTHORS `fields`, and the stated reason is
  // that the registry "has no pinned value to substitute". That is what these entries now
  // are. Writing them here is what makes the refusal coherent rather than punitive: the
  // borrower is not allowed to name the boxes, and it no longer has to — it receives the
  // human-reviewed list instead. Without this branch a bare registry-backed starter
  // reached the credential step with ZERO inputs and the wizard reported success having
  // stored nothing, which is the founding defect in a worse form.
  //
  // Condition is on the REGISTRY, not the declaration: a bare manifest carries no `fields`
  // by design (that is exactly what Guard 2b requires of it), so a
  // declaration-must-already-have-it test would never fire on the shapes that ship.
  //
  // DEEP-COPIED per field. `WELL_KNOWN_PROVIDERS_REGISTRY` is a module singleton the
  // borrow ban consults on every admission; handing out live references would let one
  // downstream caller's edit repoint the pinned truth for every later substitution.
  if (entry.fields !== undefined) {
    substituted['fields'] = entry.fields.map((field) => ({ ...field }));
  }

  // Endpoint-shaped seats are written whenever the REGISTRY has them, regardless of what
  // the declaration carried.
  //
  // The original condition also required `requirement['endpoints']`, and the rationale
  // given was `oauth2AuthCodeSchema`'s authorize+token pairing — a partial overwrite would
  // produce a shape failing its own schema. That argument holds against writing when the
  // REGISTRY lacks endpoints; it says nothing about writing when the registry has a
  // complete pair and the declaration has none. A registry entry always supplies
  // authorize+token together, so this write is schema-complete by construction. The old
  // condition meant a bare OAuth manifest (the shape starters actually ship) kept no
  // endpoints at all and the flow was aimed at `?? ''` — an empty authorize URL.
  //
  // The `entry.endpoints !== undefined` half is load-bearing and stays: a static-kind
  // provider has no authorize/token URLs, and inventing placeholders would union a
  // nonexistent host into the FROZEN ceiling via `deriveConnectionAllowedHosts`.
  if (entry.endpoints !== undefined) {
    substituted['endpoints'] = { ...entry.endpoints };
  }
  if (entry.registration !== undefined) {
    substituted['registration'] = { ...entry.registration };
  }
  if (entry.authorizeParams !== undefined) {
    substituted['authorizeParams'] = { ...entry.authorizeParams };
  }
  // Same correction as `endpoints`, and the same reason it matters: the registry's own
  // Spotify walkthrough tells the user "this hub signs in with PKCE and never needs [a
  // client secret]". Dropping `pkce` because the declaration omitted it made the pinned
  // copy describe a flow the code would not perform.
  if (entry.pkce !== undefined) {
    substituted['pkce'] = entry.pkce;
  }
  return substituted;
}

/**
 * Admit (or reject) a connection requirement for a given authoring channel.
 *
 * Pure and synchronous — no credential values, no I/O, no clock — so it can run at
 * inference time, at review render time and at the db write boundary with identical
 * results. Callers MUST treat a `false` result as fatal for that requirement: there is no
 * partial-admission path, because "show the user most of an attacker's claims" is not a
 * safe middle state.
 */
export function admitConnectionRequirement<T>(requirement: T, options: AdmissionOptions): AdmissionResult<T> {
  const record = asRecord(requirement);
  if (record === undefined) {
    return {
      ok: false,
      requirement,
      issues: [{ path: '', message: 'requirement must be an object' }],
    };
  }

  // Guard 1 — the userLayer seat, judged on CHANNEL alone (AC5).
  if (record['userLayer'] !== undefined && options.channel !== 'registry') {
    return {
      ok: false,
      requirement,
      issues: [
        {
          path: 'userLayer',
          message: `userLayer is registry-synthesized only — the '${options.channel}' channel may not declare one`,
        },
      ],
    };
  }

  // Guard 2 — the registry-borrow ban (AC9), kind-agnostic by design.
  const borrowed = findBorrowedEntry(record);
  if (borrowed === undefined) {
    return { ok: true, requirement, issues: [] };
  }

  // Guard 2b — the CREDENTIAL-PROMPT seats on a borrow hit (review MAJOR-1).
  //
  // Substituting hosts and pinning `provider.name` made the borrow MORE dangerous for
  // these seats, not less: before, an attacker's field label sat beside an attacker's
  // host and read as the sketchy thing it was; after substitution it reads as
  // registry-grade Spotify asking the user to "Paste your Spotify password", with the
  // typed value routed by an attacker-authored `headerTemplate`. Legitimacy is exactly
  // what substitution confers, so any seat it CANNOT correct must be refused instead.
  //
  // The `registry` channel is exempt for the same reason it is exempt in Guard 1: it is
  // the seat's legitimate AUTHOR, not a borrower of someone else's brand.
  if (options.channel !== 'registry') {
    const occupied = occupiedPromptSeats(record);
    if (occupied.length > 0) {
      return {
        ok: false,
        borrowed: true,
        borrowedFrom: borrowed.key,
        // The SUBSTITUTED requirement is still what we hand back, even though `ok` is
        // false. Two reasons, both load-bearing. First, the substitution properties are
        // unconditional: a caller that logs or renders a rejected requirement (a "we
        // refused this" review row) must never see `evil.example` or an attacker's
        // rename, and returning the raw record would reintroduce exactly that. Second,
        // `ok:false` is defined as FATAL for the requirement (see the contract note on
        // `admitConnectionRequirement`), so no caller may use this value as an admitted
        // one — the prompt seats it still carries are refused, not blessed.
        requirement: applyRegistryValues(record, borrowed.entry) as T,
        issues: occupied.map((path) => ({
          path,
          // Names the seat AND the borrow, because the two together are the harm — the
          // wizard needs to say which claim it refused, not just "invalid requirement".
          //
          // The reason given is REFUSAL, not absence. An earlier wording said the registry
          // "has no pinned value to substitute", which was true when written and is now
          // false for `fields`: the registry carries a reviewed field list and substitutes
          // it for a borrower that OMITS the seat. What is refused is AUTHORING it — a
          // borrower writing its own prompt copy is disagreeing with the pinned list, and
          // silently correcting that disagreement would admit an app that asked for the
          // wrong secret and show it as legitimate.
          message: `'${path}' is credential-prompt copy that the '${options.channel}' channel may not author while borrowing registry provider '${borrowed.key}'; omit it and the registry's pinned value is substituted instead, so the requirement is refused as declared`,
        })),
      };
    }
  }

  return {
    ok: true,
    borrowed: true,
    borrowedFrom: borrowed.key,
    requirement: applyRegistryValues(record, borrowed.entry) as T,
    issues: [],
  };
}
