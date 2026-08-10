/**
 * connectionPipeline — the BUILD/EDIT pipeline between the P0 contracts and the P1
 * runtime (TASK-20260810-p2-pipeline, parent plan §5 R1/R3).
 *
 * WHAT THIS SEAM IS FOR. P0 landed the contracts (`connectionRequirementSchema`, the
 * five accessors, admission, the template lint) and P1 landed the runtime (slot routing
 * against a frozen ceiling). Neither answers the motivating defect, which is a question
 * about TIMING and CALLER: a build reply's `connection_requirement` directive must become
 * a persisted `declared` row BEFORE THE APP FIRST RUNS — and a later edit must no-op,
 * replace, or stage DETERMINISTICALLY. That decision is made here.
 *
 * WHERE IT IS CALLED FROM, and why not from `artifactSink.write()` (fold). The first cut
 * put this at the version save. That is impossible: `artifact_write` is a MID-TURN tool
 * call, and the KB has the model emit the directive AFTER the write, as the closing fenced
 * block of its reply — so no reply text exists when `write()` runs. The entry point is
 * therefore `finalizeConnectionDeclaration` below, called POST-TURN from the seam that
 * already scans for the v3 `auth_wizard` directive. Post-turn is still strictly before
 * first run, so the guarantee is intact and the ordering is possible.
 *
 * THE ORDER OF THE GATES IS THE CONTRACT (and it mirrors `putDeclaredConnection`'s own):
 *
 *   1. SCHEMA — `connectionRequirementSchema.safeParse`. Fail closed at ingest; a
 *      malformed directive never reaches admission, storage, or a credential prompt.
 *   2. ADMISSION — `admitConnectionRequirement` with the channel set to the PROPOSING
 *      channel. This is the registry-borrow ban and the userLayer gate, and it may
 *      SUBSTITUTE the registry's pinned hosts for the declared ones.
 *   3. RE-PARSE the admitted value, because substitution rewrites seats (hosts, provider
 *      name, registration copy) and everything downstream — the hash, the host union,
 *      the persisted bytes — must be computed from the SUBSTITUTED requirement, never
 *      from the raw one. This is `admitAndParse`'s rule (userdb.ts), restated at the
 *      only other seat that admits.
 *   4. TEMPLATE LINT — the header template against the requirement's OWN declared field
 *      keys. Run AFTER admission so a substituted requirement is linted as it will be
 *      stored, and BEFORE any write so the engine's unknown-token→literal fallback is
 *      unreachable from a persisted template (fold S-M2).
 *   5. PROVENANCE — the `user_confirmed`-wins rule (R3, OProject verbatim).
 *   6. DELTA — `canonicalRequirementHash` decides "changed", and it is the SAME function
 *      `nextRequirementVersion` uses in the db. One definition of changed, so the two
 *      surfaces cannot drift.
 *   7. DISPATCH — `putDeclaredConnection` / `stagePendingRequirement` / no-op, chosen by
 *      the EXISTING ROW'S STATUS, never by anything the directive claims.
 *
 * C1 — nothing here reads, accepts, or logs a credential VALUE. A requirement says what
 * an app NEEDS; the credential is the user's and lives with the host. The lint sees field
 * KEYS only, and this module never touches the secret store.
 *
 * CUTOVER (fold B1): additive. Nothing here touches `llmProposalSchema` or the v3
 * `snug_auth_specs` surface, whose deletions are P4's and P3's named exit items.
 */

import type { UserDb } from '@snugprotocol/db';
import {
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  CONNECTION_STATUS,
  canonicalRequirementHash,
  connectionRequirementSchema,
  type ConnectionProvenance,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import { admitConnectionRequirement, lintAuthHeaderTemplate, type AdmissionChannel } from '@snugprotocol/auth';

import { scanForRenderDirective } from './renderDirective.js';

/**
 * The connected-surface marker. A build "is connected" exactly when its code calls
 * `useConnectedFetch` — the ONE hook through which a sandboxed app reaches an external
 * host (there is no other network path out of the iframe: `connect-src` is blocked).
 *
 * Word-bounded on the left so a longer identifier that merely ENDS in the hook's name
 * (`myUseConnectedFetch`) does not trip the gate, and matched without a call-paren so a
 * destructured or aliased use (`const { fetch: f } = useConnectedFetch()`) still counts.
 */
const CONNECTED_SURFACE_RE = /\buseConnectedFetch\b/;

/** Does this app's HTML reach the connected surface at all? */
export function htmlUsesConnectedFetch(html: string): boolean {
  return CONNECTED_SURFACE_RE.test(html);
}

export type ConnectionPersistAction =
  /** A new `declared` row was inserted for a slot that had none. */
  | 'created'
  /** An existing `declared` row's requirement was replaced (the legitimate R3 path). */
  | 'replaced'
  /** A changed requirement was staged against an APPROVED row (fold B2). */
  | 'staged'
  /** Canonically identical to what is already stored — nothing was written. */
  | 'noop'
  /** The stored row was hand-confirmed by the user; inference may not overwrite it. */
  | 'skipped_user_provenance';

export type ConnectionPersistRefusal =
  /** Failed `connectionRequirementSchema` — fail closed at ingest. */
  | 'schema_rejected'
  /** Failed the header-template lint against its own declared field keys. */
  | 'template_lint_failed'
  /** Refused by `admitConnectionRequirement` (registry borrow / userLayer channel). */
  | 'admission_refused'
  /** A db write rule refused (revoked tombstone, slot cap, slot mismatch, byte budget). */
  | 'write_refused';

export type ConnectionPersistOutcome =
  | {
      ok: true;
      action: ConnectionPersistAction;
      /** The admitted, parsed requirement — the bytes that were (or would be) stored. */
      requirement: ConnectionRequirement;
      /** True when the registry-borrow ban substituted pinned values (review provenance copy). */
      borrowed?: boolean;
      borrowedFrom?: string;
    }
  | { ok: false; reason: ConnectionPersistRefusal; message: string };

export interface PersistConnectionRequirementInput {
  appId: string;
  /** The raw directive payload — untrusted until every gate above has run. */
  requirement: unknown;
  /**
   * The PROPOSING channel. It is both the admission channel and the persisted
   * `provenance`, deliberately the same value: a channel and the provenance it writes
   * can never drift apart if there is only one of them.
   */
  channel: AdmissionChannel;
  /** Display-only inference confidence; never read by a gating decision. */
  confidence?: number;
}

/**
 * Validate a proposed requirement and persist it as the app's `declared` connection —
 * or determine, deterministically, that nothing should be written.
 *
 * Returns a typed outcome rather than throwing for the EXPECTED refusals (a model emits
 * a malformed or over-reaching requirement often enough that it is control flow, not an
 * exception). Unexpected db write-rule violations are caught and reported as
 * `write_refused` so a build cannot be torn down by a storage rule the caller cannot see.
 */
export async function persistConnectionRequirement(
  db: UserDb,
  input: PersistConnectionRequirementInput,
): Promise<ConnectionPersistOutcome> {
  // ---- Gate 1: SCHEMA. Fail closed at ingest, before admission or any row read.
  const parsed = connectionRequirementSchema.safeParse(input.requirement);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: 'schema_rejected', message: `requirement failed validation: ${issues}` };
  }

  // ---- Gate 2: ADMISSION, on the PROPOSING channel.
  const admitted = admitConnectionRequirement<ConnectionRequirement>(parsed.data, { channel: input.channel });
  if (!admitted.ok) {
    return {
      ok: false,
      reason: 'admission_refused',
      message: admitted.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    };
  }

  // ---- Gate 3: RE-PARSE the admitted value. Substitution rewrites seats, and every
  // downstream computation must run on what will actually be stored.
  const revalidated = connectionRequirementSchema.safeParse(admitted.requirement);
  if (!revalidated.success) {
    const issues = revalidated.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      reason: 'schema_rejected',
      message: `requirement failed validation after admission: ${issues}`,
    };
  }
  const requirement = revalidated.data;

  // ---- Gate 4: TEMPLATE LINT, against the requirement's OWN declared field keys.
  const headerTemplate = requirement.request?.headerTemplate;
  if (headerTemplate !== undefined) {
    const lint = lintAuthHeaderTemplate(headerTemplate, {
      fieldKeys: (requirement.fields ?? []).map((field) => field.key),
    });
    if (!lint.ok) {
      return {
        ok: false,
        reason: 'template_lint_failed',
        message: lint.issues.map((issue) => `${issue.header}: ${issue.message}`).join('; '),
      };
    }
  }

  const borrowFacts = admitted.borrowed === true ? { borrowed: true as const, borrowedFrom: admitted.borrowedFrom } : {};
  const slot = requirement.slot;
  const existing = db.getConnection(input.appId, slot);

  // ---- Gate 5: PROVENANCE. A requirement the USER hand-confirmed is never overwritten
  // by inference (R3, OProject's `user_confirmed`-wins rule adopted verbatim).
  //
  // Modelled as a SUCCESSFUL no-op rather than a refusal, because it is the rule working
  // as intended: the user's row already says what the app needs, and a build that
  // re-infers over it has not failed — it has been correctly ignored. It is keyed on
  // PROVENANCE, not on content: `user_docs` (docs the user pasted, still model-extracted)
  // stays overwritable, and the `user` channel may still overwrite the user's own row.
  if (existing !== undefined && existing.provenance === 'user' && input.channel !== 'user') {
    return { ok: true, action: 'skipped_user_provenance', requirement, ...borrowFacts };
  }

  // ---- Gate 6: DELTA. `canonicalRequirementHash` is the ONE definition of "changed",
  // shared with the db's `nextRequirementVersion`.
  //
  // On an APPROVED row the comparison is against the STAGED requirement when one is
  // already pending, and against the live grant otherwise — so re-emitting the same edit
  // twice stages once, instead of rewriting `updated_at` on every rebuild.
  if (existing !== undefined && existing.status !== CONNECTION_STATUS.revoked) {
    const stored =
      existing.status === CONNECTION_STATUS.approved
        ? (existing.pendingRequirement ?? existing.requirement)
        : existing.requirement;
    if (canonicalRequirementHash(stored) === canonicalRequirementHash(requirement)) {
      return { ok: true, action: 'noop', requirement, ...borrowFacts };
    }
  }

  // ---- Gate 7: DISPATCH on the EXISTING ROW'S STATUS.
  try {
    // An APPROVED row's changed requirement STAGES. It never replaces: the grant must
    // keep serving exactly the requirement and frozen hosts the user approved, so an
    // edit that widens the host set cannot widen the live ceiling by staging (fold B2).
    if (existing !== undefined && existing.status === CONNECTION_STATUS.approved) {
      db.stagePendingRequirement(input.appId, slot, requirement);
      return { ok: true, action: 'staged', requirement, ...borrowFacts };
    }

    // No row, or a `declared` one: insert/replace. (A revoked tombstone reaches here and
    // `putDeclaredConnection` refuses it — automatic re-declaration of a connection the
    // user revoked is exactly what the tombstone exists to prevent.)
    db.putDeclaredConnection(
      input.appId,
      slot,
      requirement,
      input.channel as ConnectionProvenance,
      input.confidence !== undefined ? { confidence: input.confidence } : {},
    );
    return {
      ok: true,
      action: existing === undefined ? 'created' : 'replaced',
      requirement,
      ...borrowFacts,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'write_refused',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export type ConnectedBuildVerdict =
  | { ok: true }
  | { ok: false; reason: 'connected_html_without_requirement'; message: string };

export interface ValidateConnectedBuildInput {
  html: string;
  /** The requirement the reply declared, if any. Presence is what the gate checks. */
  requirement?: unknown;
}

/**
 * The BUILD-VALIDATION gate (AC2) — fail-closed at BUILD, not at run.
 *
 * An app whose code calls `useConnectedFetch` but declares NO requirement is broken in a
 * way the user cannot fix and cannot even see: every call resolves `{ ok: false }`
 * forever, with no connect card to click, because a card renders from a persisted row and
 * there is no row. Catching that at run time would be too late — the app is already
 * saved, already in the library, already presenting as finished. So the gate runs at the
 * save seam and refuses the version.
 *
 * The converse is deliberately NOT gated: an app with a requirement and no connected call
 * passes. A build that declares a connection it has not wired up yet is incomplete, not
 * unsafe, and refusing it would break the legitimate staged edit where the requirement
 * lands before the code that uses it.
 */
export function validateConnectedBuild(input: ValidateConnectedBuildInput): ConnectedBuildVerdict {
  if (!htmlUsesConnectedFetch(input.html)) return { ok: true };
  if (input.requirement !== undefined && input.requirement !== null) return { ok: true };
  return {
    ok: false,
    reason: 'connected_html_without_requirement',
    message:
      'connected_html_without_requirement: the app calls useConnectedFetch but the reply declared no connection_requirement, so it would have no connect card and every call would fail',
  };
}

/** The AC2 verdict, widened so a post-turn caller can report it beside a persist refusal. */
export type ConnectionDeclarationOutcome =
  | ConnectionPersistOutcome
  | { ok: false; reason: 'connected_html_without_requirement'; message: string };

export interface FinalizeConnectionDeclarationInput {
  appId: string;
  /** The app HTML that was just saved — the connected-surface probe reads this. */
  html: string;
  /** The turn's FULL reply text. The directive is its closing fenced block. */
  reply: string;
  channel: AdmissionChannel;
  confidence?: number;
}

/**
 * THE POST-TURN SEAM (P2 fold). Where a build reply's `connection_requirement` directive
 * becomes a persisted `declared` row.
 *
 * WHY POST-TURN AND NOT AT THE VERSION SAVE. The declaration must land before the app is
 * first RUN — that is the motivating defect — but it cannot land at the version WRITE,
 * because `artifact_write` is a mid-turn tool call and the KB has the model emit the
 * directive after it, at the end of the reply. There is no reply text to scan when
 * `write()` runs. Post-turn is both the earliest moment the directive exists AND still
 * strictly before first run, so the guarantee survives intact while the ordering becomes
 * possible. It is also where the v3 `auth_wizard` scan already lives, so both directive
 * kinds are recovered from one place, by one parser.
 *
 * Returns `undefined` when there is simply nothing to say: no directive, and HTML that
 * never reaches the connected surface. Otherwise it returns an outcome the caller can
 * SURFACE — which is the second half of the fold. A refusal never unwinds the app version:
 * the HTML is the user's work and a model over-reaching on an auth seat is a recoverable
 * problem, not a reason to discard it. But the app must not fail SILENTLY either, so every
 * refusal is reported rather than swallowed, and the connected-but-undeclared case is
 * reported too.
 *
 * C1 — this reads reply TEXT and writes a requirement (field KEYS, hosts, copy). It never
 * sees, requests, or stores a credential VALUE.
 */
export async function finalizeConnectionDeclaration(
  db: UserDb,
  input: FinalizeConnectionDeclarationInput,
): Promise<ConnectionDeclarationOutcome | undefined> {
  const scan = input.reply === '' ? null : scanForRenderDirective(input.reply);
  // A directive of another kind (the v3 `auth_wizard`, still shipping under the B1
  // cutover rule) is not a requirement and is left entirely to its own path.
  const declared =
    scan !== null && 'directive' in scan && scan.directive.kind === CONNECTION_REQUIREMENT_DIRECTIVE_KIND
      ? scan.directive.requirement
      : undefined;

  if (declared === undefined) {
    // No requirement was declared. If the app never touches the connected surface that is
    // simply a normal build; if it DOES, the app is connected-but-unconnectable and the
    // user needs to be told, because there is no connect card to discover.
    const verdict = validateConnectedBuild({ html: input.html });
    return verdict.ok ? undefined : { ok: false, reason: verdict.reason, message: verdict.message };
  }

  return persistConnectionRequirement(db, {
    appId: input.appId,
    requirement: declared,
    channel: input.channel,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  });
}
