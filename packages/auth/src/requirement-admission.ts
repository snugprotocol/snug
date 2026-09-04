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
 * `request` and `testRequest` joined `fields` on the substitutable side (ADR-0022 §1,
 * TASK-20260812-desktop-auth-awareness P3): the registry now pins WHERE a typed secret
 * is sent and HOW a connection is verified, so a borrower that OMITS them receives the
 * pinned values while a borrower that AUTHORS them is still refused — the same
 * asymmetry as `fields`, driven by the same matched-option resolution (amendment 1b),
 * with one exception: values byte-identical to the matched option's pinned ones are
 * not an authoring act (admission runs twice on the production path and must not
 * refuse its own substitution).
 *
 * WHAT THIS IS NOT. Admission is not authorization. A clean pass here means "these claims
 * may be SHOWN to the user", never "this app may have a credential". The frozen host
 * ceiling (`snug_connections.allowed_hosts`, computed at approval) remains the runtime
 * wall, and the strong field-by-field review remains the human one.
 */

import type { ConnectionLanHostClass } from '@snugprotocol/protocol';

import { isPrivateRfc1918Ipv4Literal } from './net-guards.js';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  resolveRegistryEntryByName,
  type WellKnownAuthOption,
  type WellKnownOauthProvider,
} from './well-known-providers.js';

/**
 * The six authoring channels — the same literals as `CONNECTION_PROVENANCES`
 * (packages/protocol), which are PERSISTED column values. Kept structurally identical so
 * a channel and the provenance it writes can never drift apart — and since
 * TASK-20260904 that identity is a TEST (`shared-channel-admission.test.ts`), not a
 * comment. `shared` is the app-bundle channel (ADR-0063 §3): a third party's declaration,
 * judged by every guard below exactly as `inference` and `starter` are.
 */
export const ADMISSION_CHANNELS = ['registry', 'inference', 'user_docs', 'starter', 'user', 'shared'] as const;

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
 * The declared-host seat WITH the absent/empty distinction preserved — which
 * `readDeclaredHosts` deliberately collapses (every other caller only asks "which hosts
 * does this claim", and `[]` and absent are the same answer to that question).
 *
 * The LAN fork is the one place the difference is semantic: ABSENT is the legitimate
 * pre-collection shape a LAN registry entry emits, while `[]` is a malformed declaration
 * that must not be treated as "not collected yet" and quietly admitted.
 */
const readDeclaredHostsSeat = (requirement: Record<string, unknown>): string[] | undefined => {
  const hosts = requirement['declaredApiHosts'];
  if (hosts === undefined) return undefined;
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

/**
 * Registry key -> normalized apiHosts, built once. Small registry; rebuilt cheaply.
 *
 * LAN-CLASS ENTRIES ARE SKIPPED (ADR-0023, P0 amendment 10a) — and the skip is
 * load-bearing twice over.
 *
 * FIRST, AS AN AVAILABILITY FIX. A LAN entry pins no `apiHosts` at all, and the old
 * unconditional `for (const host of entry.apiHosts)` threw
 * `TypeError: entry.apiHosts is not iterable` the moment such an entry existed — from
 * inside the guard whose entire job is to fail CLOSED, on EVERY admission of EVERY
 * requirement, Hue-related or not. Probe-reproduced against the built dist before the
 * fix; pinned now by `lan-class-registry.test.ts`.
 *
 * SECOND, AS A SEMANTIC RULE. Even with a null-safe loop, a LAN entry has nothing
 * legitimate to contribute to a HOST index: its host is whatever the user typed. Indexing
 * a collected address would mean the first user who pairs a bridge at 192.168.1.50 makes
 * every OTHER requirement declaring 192.168.1.50 — their own printer, their own NAS —
 * borrow the Hue brand. A private address identifies a device on one network, never a
 * provider. The NAME trigger still reaches LAN entries in full (including
 * brand-adjacency), which is the trigger that actually catches a borrower.
 */
function registryHostIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    if (entry.lanHost !== undefined) continue;
    for (const host of entry.apiHosts ?? []) index.set(normalizeHost(host), key);
  }
  return index;
}

/**
 * Per-class validators for a `lanHost` entry's collected address (ADR-0023 Decision 1).
 *
 * Keyed by the protocol's `ConnectionLanHostClass` so a NEW class cannot compile without
 * bringing its validator — the same typed-Record discipline the template-helper enum uses
 * (amendment 7). `isPrivateRfc1918Ipv4Literal` is packages/auth's own guard, the one the
 * executor's Decision-6 stand-down already keys on, so admission and the transport agree
 * on the class by construction rather than by coincidence.
 */
const LAN_HOST_CLASS_VALIDATORS: Record<ConnectionLanHostClass, (host: string) => boolean> = {
  'rfc1918-ipv4-literal': isPrivateRfc1918Ipv4Literal,
};

/**
 * Does this declaration's host list satisfy the LAN entry's declared class?
 *
 * The rule is the protocol schema's, restated at the guard (amendment 10c): a LAN
 * requirement carries EITHER no hosts (pre-collection) OR exactly one host of the
 * declared class. Restated rather than delegated because admission runs at the ENVELOPE
 * boundary (C5) and may see input the schema never parsed — "the schema already checked"
 * is precisely the assumption a defensive guard may not make.
 *
 * What it refuses, and why each matters: a PUBLIC host (the smuggle — a credential aimed
 * anywhere while the review screen says "a device on your own network"), an OFF-CLASS
 * literal (loopback, link-local, CGN, IPv6 — each has its own refusals for its own
 * reasons and none of them is a Hue bridge), and a SECOND host (a second device the user
 * never paired).
 */
function lanHostsAcceptable(declared: readonly string[] | undefined, entry: WellKnownOauthProvider): boolean {
  if (declared === undefined || declared.length === 0) return declared === undefined; // absent = pre-collection; [] is not
  if (declared.length !== 1) return false;
  const inClass = LAN_HOST_CLASS_VALIDATORS[entry.lanHost!.class];
  return inClass(declared[0]!);
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
 *
 * BUT EXACT-KEY NORMALIZATION IS NOT ENOUGH, and P5 closes that gap (carried finding (a),
 * reproduced by execution). It collapses case and punctuation but not ADDED WORDS, so
 * `Spotify Inc` / `Spotify Connect` / `CoinbaseInc` all MISSED the registry and were
 * admitted with attacker-authored fields, an attacker-authored header template and
 * attacker-chosen hosts — under a brand the review screen renders as trusted. So the name
 * path now falls through to `findBrandAdjacentRegistryKeys`, a boundary-aware
 * segment-run match that catches the added-word family without firing on unrelated names
 * that merely contain a registry name's letters (`Slackline Weather`, `Gmailer Tools`).
 *
 * DETERMINISM WHEN A NAME BORROWS FROM SEVERAL ENTRIES: the adjacent keys are sorted and
 * the first is taken, so `borrowedFrom` is stable for a given name rather than dependent
 * on registry insertion order. Which entry wins matters less than that the ban FIRES —
 * every candidate is a registry brand the declaration had no right to trade on.
 */
function findBorrowedEntry(
  requirement: Record<string, unknown>,
): { key: string; entry: WellKnownOauthProvider } | undefined {
  const name = readProviderName(requirement);
  if (name !== undefined) {
    // ONE resolution, shared with the wizard (P5-flow): the exact rung then the
    // brand-adjacent fallback, both now living in the registry module so a
    // second caller cannot grow a second copy of the rule. The behavior is
    // byte-identical to the inline form this replaced — including that an EXACT
    // hit always wins, so a legitimate "Google Drive" resolves to `googledrive`
    // rather than to `google`.
    const byName = resolveRegistryEntryByName(name);
    if (byName !== undefined) return byName;
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
 * These are refused rather than corrected on a borrow hit from an authoring channel —
 * and since ADR-0022 §1 ALL THREE are also substitutable: the registry pins a field
 * list (P4), request templates and a test request (TASK-20260812-desktop-auth-awareness
 * P3), so a bare borrower receives all of them. The old rationale for refusing
 * `request`/`testRequest` — "the registry has nothing to substitute them WITH" — is
 * gone; what remains is the reason that was always sufficient:
 *
 * Correcting an AUTHORED seat would silently discard copy the borrower wrote and admit
 * the requirement anyway, so an app that asked for the wrong secret — or aimed the
 * typed secret's placement somewhere of its own choosing — would simply be fixed up
 * and shown as legitimate. Refusal is the honest outcome: a borrower that authors
 * prompt copy is telling us it disagrees with the pinned values, and that disagreement
 * is not ours to paper over. The bare borrower — the shape starters actually ship —
 * never occupies these seats and receives the pinned values.
 */
const CREDENTIAL_PROMPT_SEATS = ['fields', 'request', 'testRequest'] as const;

/**
 * Which credential-prompt seats does this requirement actually carry?
 *
 * `request` counts only when it carries a `headerTemplate` — an empty `request` object
 * says nothing about where a secret goes, and refusing on it would reject shapes that
 * declare no prompt at all.
 *
 * A `fields` list that is EXACTLY the registry's pinned list does not count, and that
 * exemption is what makes admission IDEMPOTENT (P5, shipped-blocker fix).
 *
 * WHY IT IS NEEDED. Admission deliberately runs twice on the production path: once in
 * `persistConnectionRequirement` (the pipeline) and again in the db accessor's
 * `admissionGate`, so no write can bypass the guard. But pass 1 SUBSTITUTES the
 * registry's `fields` into a bare requirement, so pass 2 saw a requirement occupying
 * `fields` and refused it — the guard rejecting the very value it had just produced. Every
 * registry-backed starter failed to persist with `write_refused` and the user got no
 * connect card at all. Verified in a real browser, and confirmed present on the P4
 * baseline, so this closes a shipped defect rather than one introduced by P5.
 *
 * WHY IT IS SAFE. What Guard 2b refuses is a borrower AUTHORING credential-prompt copy —
 * choosing what the user is asked to type beside someone else's brand. A list that is
 * byte-for-byte the human-reviewed registry list is not an authoring act: it is the
 * pinned value, and admitting it grants exactly the legitimacy the registry already
 * confers. Anything that DIFFERS in any field — one relabelled input, one extra key, one
 * dropped key — is still an authored list and is still refused, which the negative test
 * beside this one pins.
 *
 * The comparison is structural rather than reference-based on purpose: the value has been
 * through JSON round-trips (persistence, the directive envelope) by the time the second
 * admission sees it, so identity is long gone but the bytes are the same.
 */
function fieldsMatchPinnedList(value: unknown, pinnedList: WellKnownOauthProvider['fields']): boolean {
  if (pinnedList === undefined || !Array.isArray(value)) return false;
  if (value.length !== pinnedList.length) return false;
  return value.every((field, index) => {
    const pinned = pinnedList[index]!;
    const candidate = asRecord(field);
    if (candidate === undefined) return false;
    // Compare the union of both key sets, so neither an added nor a dropped property
    // can slip through as "equal".
    const keys = new Set([...Object.keys(candidate), ...Object.keys(pinned)]);
    return [...keys].every(
      (key) => candidate[key] === (pinned as unknown as Record<string, unknown>)[key],
    );
  });
}

/**
 * THE MATCHED-OPTION HANDLE (TASK-20260812-auth-kind-choice, D3 — plan review B1/B2).
 *
 * Resolves WHICH human-authored option of a multi-option entry a declared field list
 * is, byte-identically: the DEFAULT (the entry itself, checked first) or one of its
 * `authOptions`. Undefined means "not any pinned list" — an authored list, which
 * Guard 2b refuses on borrowing channels exactly as before.
 *
 * ONE handle feeds BOTH halves of Guard 2b. Before it existed the exemption could
 * bless a variant's list while substitution wrote the DEFAULT's fields back over it —
 * a user's chosen flow silently undone between the click and the row, or (hostile
 * form) one option's fields passing the guard while another option's shape came back.
 * Deriving both halves from this single resolution makes that class unrepresentable:
 * the list that matched IS the flow that substitutes.
 */
function matchAuthOption(
  value: unknown,
  entry: WellKnownOauthProvider,
): WellKnownOauthProvider | WellKnownAuthOption | undefined {
  if (fieldsMatchPinnedList(value, entry.fields)) return entry;
  for (const option of entry.authOptions ?? []) {
    if (fieldsMatchPinnedList(value, option.fields)) return option;
  }
  return undefined;
}

/**
 * Structural equality for JSON-shaped values (objects key-order-insensitive, arrays
 * ordered) — the byte-match the amendment-1b exemption runs on. Structural rather than
 * reference or JSON.stringify equality for the same reason as `fieldsMatchPinnedList`:
 * the value has been through JSON round-trips by the time the second admission sees
 * it, so identity is gone and key order is an accident of serialization history.
 */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => structurallyEqual(item, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === undefined || rightRecord === undefined) return false;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => structurallyEqual(leftRecord[key], rightRecord[key]));
}

function occupiedPromptSeats(
  requirement: Record<string, unknown>,
  entry: WellKnownOauthProvider,
): string[] {
  const occupied: string[] = [];
  // THE ONE RESOLUTION (D3 + P0 amendment 1b, TASK-20260812-desktop-auth-awareness):
  // which human-authored option this requirement's field list is, resolved ONCE and
  // consulted by all three seat exemptions below AND by `applyRegistryValues`. A
  // per-seat resolution could bless one option's fields while byte-matching another
  // option's request — the mixed authored composite the single handle exists to refuse.
  // No matched fields ⇒ no exemption for ANY seat: the exemption never outruns its
  // handle, so pinned-looking request bytes beside an absent or authored field list
  // are still an authoring act.
  const matched = matchAuthOption(requirement['fields'], entry);
  for (const seat of CREDENTIAL_PROMPT_SEATS) {
    const value = requirement[seat];
    if (value === undefined || value === null) continue;
    if (seat === 'request') {
      // BOTH template seats count (P0 amendment 1a). Before the amendment only
      // `headerTemplate` was read, so a queryTemplate-only request SAILED PAST this
      // guard — an authored query placement is credentials in a URL aimed wherever the
      // borrower chose, the same harm one seat over. An empty `request` object still
      // says nothing about where a secret goes and stays exempt.
      //
      // Amendment 1b: a request byte-identical to the MATCHED option's pinned request
      // is not an authoring act — it is what `applyRegistryValues` wrote on the
      // previous admission pass (admission runs twice on the production path).
      if (matched !== undefined && structurallyEqual(value, matched.request)) continue;
      const request = asRecord(value);
      if (request?.['headerTemplate'] !== undefined) occupied.push('request.headerTemplate');
      if (request?.['queryTemplate'] !== undefined) occupied.push('request.queryTemplate');
      continue;
    }
    if (seat === 'testRequest') {
      // Amendment 1b, same exemption, same handle — per seat, so a probe re-aimed one
      // path over is refused even beside a byte-perfect request template.
      if (matched !== undefined && structurallyEqual(value, matched.testRequest)) continue;
      occupied.push(seat);
      continue;
    }
    if (seat === 'fields' && Array.isArray(value) && value.length === 0) continue;
    // A list byte-identical to ANY human-authored option's pinned list is not an
    // authoring act — see `matchAuthOption`. The DEFAULT-only form of this exemption
    // was the plan-review BLOCKER: it made a user's chosen variant refusable here and
    // corruptible below.
    if (seat === 'fields' && matched !== undefined) continue;
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

  // WHICH option's flow seats substitution honors (D3, TASK-20260812-auth-kind-choice):
  // the option whose pinned field list the declaration matches — the SAME resolution
  // the exemption above used, so the blessed list and the substituted shape can never
  // disagree. No match (an authored/absent list) ⇒ the DEFAULT, which is exactly the
  // pre-option behavior. Identity seats below (provider name, declaredApiHosts) are
  // ALWAYS the entry's regardless of option — a flow choice never moves which hosts
  // receive the credential.
  const matched = matchAuthOption(requirement['fields'], entry);
  const flow = matched ?? entry;

  // THE HOST SEAT, forked for LAN entries (ADR-0023, P0 amendment 10b — a deliberate,
  // scoped carve-out of ADR-0020 Decision 4's "hosts are ALWAYS the entry's").
  //
  // For a normal entry nothing changes and nothing may change: replacement (not merge) of
  // the declared list by the pinned one IS the borrow ban — `evil.example` is GONE, not
  // appended. That property is pinned by a test in this same suite so the fork cannot
  // quietly become "preserve declared hosts" for everyone.
  //
  // For a LAN entry there is nothing to substitute WITH — its host is the address the
  // user just typed. The old unconditional write produced `declaredApiHosts: []` and
  // deleted it (probe-reproduced: "PROBE-B: ok= true hosts= []"), silently, with ok:true,
  // so the ceiling froze around nothing and the connection could never serve a request.
  // So the declaration's own hosts are PRESERVED here — and the class re-validation in
  // `admitConnectionRequirement` is what makes preserving them safe, by refusing the
  // borrower that preserves a PUBLIC host under this brand. The two halves ship together;
  // neither is sufficient alone.
  const substituted: Record<string, unknown> = {
    ...requirement,
    provider,
    ...(entry.lanHost !== undefined
      ? {
          // Preserved verbatim, INCLUDING absent (a pre-collection row stays hostless —
          // spreading `undefined` would add the key, so the seat is written only when the
          // declaration actually carried one).
          ...(requirement['declaredApiHosts'] !== undefined
            ? { declaredApiHosts: requirement['declaredApiHosts'] }
            : {}),
          // The LAN seat itself IS pinned registry data — the class and the label the
          // wizard renders — so it substitutes like `fields` does. Deep-copied for the
          // same module-singleton reason.
          lanHost: { ...entry.lanHost },
        }
      : { declaredApiHosts: [...(entry.apiHosts ?? [])] }),
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
  if (flow.fields !== undefined) {
    substituted['fields'] = flow.fields.map((field) => ({ ...field }));
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
  if (flow.endpoints !== undefined) {
    substituted['endpoints'] = { ...flow.endpoints };
  }
  if (flow.registration !== undefined) {
    // `instructions` deep-copied like every sibling seat (TASK-20260815 plan-review
    // note): the shallow spread left the array a LIVE reference to the registry
    // singleton, which one downstream caller's mutation could repoint for every later
    // substitution — the exact reason `fields` is deep-copied above.
    substituted['registration'] = {
      ...flow.registration,
      ...(flow.registration.instructions !== undefined ? { instructions: [...flow.registration.instructions] } : {}),
    };
  }
  // THE REQUEST/TEST SEATS (ADR-0022 §1, amendment 1c) — substituted on every borrow
  // hit, channel-agnostic, because this path is what serves bare starter and inference
  // rows. Written from the SAME `matched ?? entry` flow as `fields`, so the blessed
  // list and the substituted placement cannot disagree (the two-half-guard lesson,
  // 2026-08-12). Condition is on the REGISTRY seat, not the declaration: a borrower
  // authoring these seats was refused above (non-registry channels), and a flow that
  // pins none must not inherit another flow's signing template. Deep-copied for the
  // same singleton reason as `fields`.
  if (flow.request !== undefined) {
    substituted['request'] = {
      ...(flow.request.headerTemplate !== undefined ? { headerTemplate: { ...flow.request.headerTemplate } } : {}),
      ...(flow.request.queryTemplate !== undefined ? { queryTemplate: { ...flow.request.queryTemplate } } : {}),
    };
  }
  if (flow.testRequest !== undefined) {
    substituted['testRequest'] = { ...flow.testRequest };
  }
  if (flow.authorizeParams !== undefined) {
    substituted['authorizeParams'] = { ...flow.authorizeParams };
  }
  // Same correction as `endpoints`, and the same reason it matters: the registry's own
  // Spotify walkthrough tells the user "this hub signs in with PKCE and never needs [a
  // client secret]". Dropping `pkce` because the declaration omitted it made the pinned
  // copy describe a flow the code would not perform.
  if (flow.pkce !== undefined) {
    substituted['pkce'] = flow.pkce;
  }
  // SCOPES (ADR-0028) — an IDENTITY seat, read from the ENTRY (never the matched
  // option): privilege breadth is a per-provider decision, like which hosts receive the
  // credential. REPLACEMENT, not merge, for the same reason as hosts: a borrower keeping
  // `user-read-email` beside the pinned list while presenting as registry-backed is the
  // whole harm. When the entry pins none, an authored list is left as-is — that is
  // ADR-0028 rule 5's recorded residue (beside borrowed-endpoints, next-steps
  // 2026-08-12), pinned by a characterization test, mitigated by the review screen
  // rendering scopes (AC3b) before any approval.
  //
  // Written only onto declarations whose KIND consumes scopes (Gate-5 review):
  // admission never substitutes kind, so a static-kind borrower under a scope-pinned
  // brand would otherwise gain a seat meaningless to it — and every such legacy row
  // would stage a spurious "what this sign-in may do" diff at wizard open, routing an
  // API-key user through a re-consent ceremony scopes cannot affect.
  const declarationKind = requirement['kind'];
  if (entry.scopes !== undefined && (declarationKind === 'oauth2_auth_code' || declarationKind === 'oauth2_client_creds')) {
    substituted['scopes'] = [...entry.scopes];
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

  // Guard 2c — THE LAN HOST CLASS on a borrow hit (ADR-0023, P0 amendment 10c).
  //
  // Runs BEFORE Guard 2b and on EVERY channel including `registry`, because this is not a
  // question about who may author prompt copy — it is a question about which host may end
  // up in a frozen ceiling. A public host inside a ceiling the review screen presents as
  // "a device on your own network" is wrong no matter which channel wrote it, and the
  // registry channel is exactly where a re-substitution pass lands (the P3 seat-drift
  // migration re-admits a row's own persisted shape on its stored channel).
  //
  // This is the second half of amendment 10b: preserving a borrower's declared hosts is
  // only safe because this refuses the borrower whose declared host is not of the class.
  // Refusal, never correction — there is no honest value to correct a wrong bridge
  // address TO, and silently emptying the seat is the clobber this fork exists to undo.
  if (borrowed.entry.lanHost !== undefined) {
    const declared = readDeclaredHostsSeat(record);
    if (!lanHostsAcceptable(declared, borrowed.entry)) {
      return {
        ok: false,
        borrowed: true,
        borrowedFrom: borrowed.key,
        // Substituted for the same reason Guard 2b returns a substituted value on
        // refusal: a caller rendering a refused requirement must never show the
        // attacker's rename beside registry-grade copy. `ok:false` is fatal regardless.
        requirement: applyRegistryValues(record, borrowed.entry) as T,
        issues: [
          {
            path: 'declaredApiHosts',
            message: `'${borrowed.key}' is a LAN-class provider: its host must be a single address of class '${borrowed.entry.lanHost.class}' collected from the user, so this declaration's hosts are refused rather than substituted`,
          },
        ],
      };
    }
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
    const occupied = occupiedPromptSeats(record, borrowed.entry);
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
