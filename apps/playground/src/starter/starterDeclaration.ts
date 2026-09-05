// starterDeclaration.ts — TASK-20260807-connection-reachability, plan v2 §V2-2/V2-3/V2-7.
//
// The INSTALL ACT as a connection channel. A chat-less app (a starter, imported HTML,
// hand-authored code) can never reach the auth wizard through a directive, because the
// only non-test `putAuthSpec` lives behind a build conversation it does not have. This
// module is the third rung of the ratified trust ladder: the user, the reviewed builder
// directive, and — here — the act of installing an app that SHIPS a declaration.
//
// POSTURE (owner, 2026-08-08, do not relax): an app may NEVER propose a connection at
// runtime. What this module resolves is not an app's request; it is a first-party,
// in-repo, PR-reviewed manifest that the user's own install act brought into the
// library. It gets the SAME strong field-by-field review as an inferred spec — it only
// PREFILLS that review, it never shortens it.
//
// TWO INDEPENDENT FACTS, or nothing:
//   1. the app's `install_source` resolves to a bundled `connection.json`, AND
//   2. the app's NEWEST PINNED factory HTML (v1 at install; each starter update adds a
//      newer pin — ADR-0045) *and* the version that actually RUNS (`current_version`)
//      both match the bundled starter HTML.
//
// The "and the version that runs" half was added by the Gate-4 implementation review:
// validating v1 alone vouched for archival bytes while the iframe executed something
// else entirely. See the long comment at the check itself.
//
// (1) alone is worthless: `install_source` is a plain column that a whole-DB import
// lets an attacker write, so an imported app could otherwise claim a starter's identity
// and inherit its declaration. (2) is what makes the claim first-party — the bytes came
// from this repo. The comparison is NORMALIZED and a failure is REPORTED rather than
// swallowed, because a silent withdrawal drops the user back into the empty wizard this
// task exists to eliminate, with no diagnostic.

import { connectionRequirementSchema, type ConnectionRequirement } from '@snugprotocol/protocol';
import { admitConnectionRequirement } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import { STARTER_PREFIX } from './starterApps.js';
import { starterSource } from './starterSource.js';

/**
 * Raw glob, exactly like `starterApps.ts`'s `app.html` pattern. `query: '?raw'` is
 * load-bearing: Vite never parses the manifest at transform time, so a malformed
 * `connection.json` can never break the BUILD — it degrades to "this app declares
 * nothing", which is the state every non-declaring example (chess, flying-pig, the
 * pillar games) is already in.
 */
// (The manifest and html globs live in `starterSource.ts` — TASK-20260905-host-kit AC14.)

/** Why a declaration that exists on disk did not reach the user. Never a silent drop. */
export type DeclarationMismatch = 'html_mismatch';

export interface DeclaredIntent {
  /** The manifest's requirement, verbatim and unenriched. Absent when nothing declared. */
  declaration?: ConnectionRequirement;
  /**
   * Set when a manifest EXISTS for this app's starter but the app no longer matches it.
   * Everything treats it as "no declaration". Distinct from the common case of an app that
   * simply never declared, which reports nothing.
   *
   * NO UI RENDERS THIS TODAY — the only signal a user could ever see is the `console.warn`
   * at the detection site below. This comment used to claim "the Settings surface renders
   * this ('this app's code no longer matches its starter')"; no such surface was ever
   * built, and the claim was corrected in P4 of TASK-20260812-desktop-auth-awareness
   * rather than left describing a promise as a fact. The consequence is real and worth
   * naming: a user who edits an installed starter loses its guided connection setup
   * SILENTLY, with only a console line explaining why. The seat exists precisely so that
   * surface can be built without re-deriving the fact — queued in docs/next-steps.md,
   * deliberately not built here (P4 is starter realignment, not a new UI surface).
   */
  mismatch?: DeclarationMismatch;
}

/** Test seam: bundled folders → their manifest + factory HTML. */
type BundledFixtures = Record<string, { manifest: string; html: string }>;
let fixtures: BundledFixtures | undefined;

export function __setDeclarationManifestsForTests(next: BundledFixtures): void {
  fixtures = next;
}

export function __resetDeclarationManifestsForTests(): void {
  fixtures = undefined;
}

async function bundled(folder: string): Promise<{ manifest: string; html: string } | null> {
  if (fixtures !== undefined) return fixtures[folder] ?? null;
  const source = starterSource();
  const [manifest, html] = await Promise.all([source.manifest(folder), source.html(folder)]);
  if (manifest === undefined || html === undefined) return null;
  return { manifest, html };
}

/**
 * The same normalization the examples validate suite uses for its hooks-block comparison
 * (`examples/validate.test.mjs:55–60`). Line endings and trailing whitespace differ
 * across checkouts and formatters; treating those as a mismatch would strand users in
 * the empty wizard on nothing more than a `.gitattributes` setting. A SEMANTIC edit
 * still fails, which is the property that matters.
 */
export function normalizeStarterHtml(html: string): string {
  return html.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}
const normalize = normalizeStarterHtml;

/**
 * Parse-and-drop. Invalid JSON, schema-invalid shapes, and admission refusals all yield
 * `null` plus ONE console warning — never a throw, never a partial object.
 *
 * REWIRED TO v4 (TASK-20260810-p4-starters, the named exit item). This used to parse with
 * `llmProposalSchema`, which is now DELETED. The change is not cosmetic and is asserted
 * BEHAVIOURALLY rather than by grep, precisely because this function fails soft: a v3
 * manifest (`kindHint`/`providerName`) is now REFUSED — it was the only accepted shape
 * before — and a v4 requirement carrying `fields`/`registration` is now ACCEPTED, which
 * the omit-list contract structurally could not express. That asymmetry is the proof.
 *
 * ADMISSION RUNS HERE, ON THE `starter` CHANNEL. A manifest is first-party and
 * PR-reviewed, but it is still a CHANNEL, and admission is where a channel's claims are
 * judged. Two things it does that the schema cannot:
 *
 *   1. REFUSES a manifest that authors a `userLayer` (registry-synthesized only). Without
 *      this the install act would be the one hole every other channel is gated against.
 *   2. Applies the REGISTRY-BORROW BAN. This is why the four registry-backed starters
 *      ship BARE manifests: naming CoinGecko or declaring `api.coingecko.com` substitutes
 *      the registry's pinned hosts, registration walkthrough and display name over
 *      whatever the manifest said. The user therefore reviews registry-grade copy, and a
 *      manifest that tried to author its own credential-prompt seats beside a borrowed
 *      brand is refused outright (Guard 2b) rather than admitted with a partial fix.
 *
 * The SUBSTITUTED requirement is what we return, so every downstream surface — the
 * disclosure, the copied row, the review — sees the pinned values rather than the
 * declared ones.
 */
function parseManifest(raw: string, folder: string): ConnectionRequirement | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[snug] examples/${folder}/connection.json is not valid JSON — ignoring its declaration`);
    return null;
  }
  const result = connectionRequirementSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[snug] examples/${folder}/connection.json does not match the requirement schema — ignoring it`);
    return null;
  }

  const admitted = admitConnectionRequirement(result.data, { channel: 'starter' });
  if (!admitted.ok) {
    console.warn(
      `[snug] examples/${folder}/connection.json was refused by requirement admission ` +
        `(${admitted.issues.map((issue) => issue.path).join(', ')}) — ignoring it`,
    );
    return null;
  }
  // Re-parse the SUBSTITUTED record: admission is a structural pass over `unknown`, so
  // this is what turns its output back into a typed requirement rather than casting.
  const substituted = connectionRequirementSchema.safeParse(admitted.requirement);
  if (!substituted.success) {
    console.warn(`[snug] examples/${folder}/connection.json did not survive registry substitution — ignoring it`);
    return null;
  }
  return substituted.data;
}

/**
 * Resolve what the install act declared for `appId`, with the reason when a manifest
 * exists but no longer applies. This is the full-fidelity entry point; most callers want
 * `starterDeclarationFor`.
 */
export async function resolveDeclaredIntent(db: UserDb, appId: string): Promise<DeclaredIntent> {
  const app = db.getApp(appId);
  const source = app?.installSource;
  if (source === undefined || !source.startsWith('starter:')) return {};

  const folder = source.slice('starter:'.length);
  const found = await bundled(folder);
  if (found === null) return {};

  const declaration = parseManifest(found.manifest, folder);
  if (declaration === null) return {};

  // Fact 2. BOTH the newest PINNED factory version AND the version that actually RUNS
  // must match the bundle. Each half closes a different hole, and shipping either alone
  // is unsafe:
  //
  //  - the factory pin alone (the original implementation) was defeated by the Gate-4
  //    review: the iframe executes `current_version` (`RunView` → `library.getHtml` →
  //    `getAppHtml(id)` with no version), so a whole-DB import could supply a pinned
  //    version = the repo's real bytes (public, free to copy) plus current_version =
  //    attacker code. Both facts held while the running app had shipped nothing — and
  //    since credential brokering is keyed on appId, the attacker's version was the
  //    beneficiary of any approval. Fact 2's claim is "the bytes came from this repo",
  //    which is only an inference about the RUNNING app when the compared bytes are the
  //    ones that run.
  //  - current alone would be defeated the other way: an importer could ship no pinned
  //    row at all (or a foreign one) and set the latest version to the bundle, minting a
  //    declaration for an app whose install act never happened. Hence `find(pinned)`
  //    below: an EMPTY pinned set is a mismatch, never a pass.
  //
  // Fact 1's subject is the NEWEST pinned version, not literally v1 (ADR-0045): the
  // starter-update act lands each release as a new factory pin, so after an update the
  // newest pin is the bundle the user is on while v1 still holds install-day bytes.
  // Forgery still requires controlling both the newest pinned row and `current_version`
  // — the same strength as the original two facts — and, as before, an app the user has
  // genuinely edited stops declaring, which is correct: the guided setup vouches for
  // shipped code, not for code the user has since changed.
  const newestPin = db.listAppVersions(appId).find((version) => version.pinned); // DESC ⇒ newest
  const factory = newestPin === undefined ? undefined : db.getAppHtml(appId, newestPin.version);
  const running = db.getAppHtml(appId);
  const bundledHtml = normalize(found.html);
  if (
    factory === undefined ||
    running === undefined ||
    normalize(factory) !== bundledHtml ||
    normalize(running) !== bundledHtml
  ) {
    console.warn(
      `[snug] "${appId}" was installed from examples/${folder} but its code no longer matches that starter — ` +
        'its declared connection is withdrawn until the app is reinstalled',
    );
    return { mismatch: 'html_mismatch' };
  }

  return { declaration };
}

/**
 * The declaration for an installed app, or `null`. Both facts must hold; a mismatch is
 * reported by `resolveDeclaredIntent` and reads as `null` here.
 */
export async function starterDeclarationFor(
  db: UserDb,
  appId: string,
): Promise<{ declaration: ConnectionRequirement } | null> {
  const intent = await resolveDeclaredIntent(db, appId);
  return intent.declaration === undefined ? null : { declaration: intent.declaration };
}

/** The starter id a declaring folder installs as — pinned through the ONE prefix rule. */
export function declaringStarterId(folder: string): string {
  return `${STARTER_PREFIX}${folder}`;
}

/**
 * THE INSTALL ACT AS A COPY (TASK-20260810-p4-starters, AC3/AC4; parent plan R4).
 *
 * WHAT CHANGED. Before this phase the declaration was resolved ON DEMAND and never
 * persisted: every read re-globbed the bundle, re-parsed it, and re-ran the two-fact
 * vouch. Install now COPIES the manifest into `snug_connections` as a `declared` row, and
 * from that moment the requirement is the USER'S OWN ROW. That is what makes the zero-key
 * path work — running an installed starter needs no LLM, no re-resolution and no glob,
 * because the row is already there.
 *
 * WHAT IT NEVER COPIES: a credential. A manifest ships in a public repo. It declares field
 * DEFINITIONS ("you will need an API key and a secret") and never values, so there is
 * nothing here that could carry one — and the row lands as `declared`, never `approved`,
 * so there is no grant for a value to attach to. Install PREFILLS a review; it never
 * shortens or skips one (C1).
 *
 * THE TWO-FACT VOUCH STILL GATES THE COPY, and persistence makes it MORE important rather
 * than less: an on-demand resolution that was wrong got withdrawn on the next read, but a
 * wrong ROW persists until someone revokes it. So this routes through
 * `starterDeclarationFor` — install_source AND both HTML versions — rather than reading
 * the bundle directly.
 *
 * THE LOCK (AC4). Reinstalling is a routine click (the hub dedups on install_source), and
 * a reinstall that refreshed an APPROVED row would swap the requirement out from under a
 * grant the user reviewed field-by-field — silently re-pointing a live credential at
 * whatever the new manifest declares. `putDeclaredConnection` already encodes exactly this
 * rule: it THROWS on an approved row and on a revoked tombstone. The install act's job is
 * to HONOR that rather than catch-and-ignore it, so it checks status FIRST and declines
 * quietly, leaving the throw as the db's backstop rather than this function's control flow.
 *
 * Never throws: a starter the user already owns must stay installable.
 */
export async function installStarterConnections(db: UserDb, appId: string): Promise<void> {
  const resolved = await starterDeclarationFor(db, appId);
  if (resolved === null) return; // declares nothing, or the vouch failed — either way, no row

  const requirement = resolved.declaration;
  const existing = db.getConnection(appId, requirement.slot);

  // Only a still-`declared` row may be refreshed. An APPROVED row protects a grant the
  // user reviewed; a REVOKED row is a tombstone, and flipping it back to `declared` would
  // turn the user's "no" into "ask me again" without them acting. Both decline silently —
  // a reinstall is not an error.
  if (existing !== undefined && existing.status !== 'declared') return;

  try {
    db.putDeclaredConnection(appId, requirement.slot, requirement, 'starter');
  } catch (error) {
    // Defense in depth for the races and the caps the status check above cannot see
    // (AUTH_MAX_SLOTS_PER_APP, a concurrent approval). An install must never break on a
    // connection that could not be written.
    console.warn(`[snug] could not copy the declared connection for "${appId}":`, error);
  }
}

/**
 * The PRE-INSTALL lookup: what a READ-ONLY starter declares, before the user owns
 * anything (§V2-6, the install disclosure).
 *
 * DELIBERATELY WEAKER THAN THE TWO-FACT RESOLVER, because it answers a weaker question.
 * There is no app row and no stored HTML on the starter route, so there is nothing to
 * compare — this reads the BUNDLED manifest directly and makes a claim strictly about
 * bundled bytes: "this starter ships a declared connection". It grants no trust and
 * prefills no review; it exists so the install act is INFORMED rather than surprising.
 *
 * The id guard matters: an installed app's uuid must never resolve here, or the HTML
 * check could be sidestepped by asking this question instead of the real one.
 */
export async function starterDeclarationForStarterId(starterId: string): Promise<ConnectionRequirement | null> {
  if (!starterId.startsWith(STARTER_PREFIX)) return null;

  const folder = starterId.slice(STARTER_PREFIX.length);
  const found = await bundled(folder);
  if (found === null) return null;

  return parseManifest(found.manifest, folder);
}
