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
//   2. the app's PINNED FACTORY HTML (version 1) *and* the version that actually RUNS
//      (`current_version`) both match the bundled starter HTML.
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

import { llmProposalSchema, type LlmProposal } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { STARTER_PREFIX } from './starterApps.js';

/**
 * Raw glob, exactly like `starterApps.ts`'s `app.html` pattern. `query: '?raw'` is
 * load-bearing: Vite never parses the manifest at transform time, so a malformed
 * `connection.json` can never break the BUILD — it degrades to "this app declares
 * nothing", which is the state every example except `connection-demo` is already in.
 */
const manifestModules = import.meta.glob('../../../../examples/*/connection.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const htmlModules = import.meta.glob('../../../../examples/*/app.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** Why a declaration that exists on disk did not reach the user. Never a silent drop. */
export type DeclarationMismatch = 'html_mismatch';

export interface DeclaredIntent {
  /** The manifest's proposal, verbatim and unenriched. Absent when nothing declared. */
  declaration?: LlmProposal;
  /**
   * Set when a manifest EXISTS for this app's starter but the app no longer matches it.
   * The Settings surface renders this ("this app's code no longer matches its starter");
   * everything else treats it as "no declaration". Distinct from the common case of an
   * app that simply never declared, which reports nothing.
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

function folderOf(path: string, file: string): string {
  const match = new RegExp(`examples/([^/]+)/${file.replace('.', '\\.')}$`).exec(path);
  return match?.[1] ?? path;
}

async function bundled(folder: string): Promise<{ manifest: string; html: string } | null> {
  if (fixtures !== undefined) return fixtures[folder] ?? null;

  const manifestEntry = Object.entries(manifestModules).find(
    ([path]) => folderOf(path, 'connection.json') === folder,
  );
  const htmlEntry = Object.entries(htmlModules).find(([path]) => folderOf(path, 'app.html') === folder);
  if (manifestEntry === undefined || htmlEntry === undefined) return null;

  return { manifest: await manifestEntry[1](), html: await htmlEntry[1]() };
}

/**
 * The same normalization the examples validate suite uses for its hooks-block comparison
 * (`examples/validate.test.mjs:55–60`). Line endings and trailing whitespace differ
 * across checkouts and formatters; treating those as a mismatch would strand users in
 * the empty wizard on nothing more than a `.gitattributes` setting. A SEMANTIC edit
 * still fails, which is the property that matters.
 */
function normalize(html: string): string {
  return html.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Parse-and-drop. Invalid JSON and schema-invalid shapes both yield `null` plus ONE
 * console warning — never a throw, never a partial object. The strict `llmProposalSchema`
 * is deliberately reused rather than relaxed: a manifest is first-party today, but this
 * must not become the one place where the proposal contract is looser than the directive
 * channel's, or a future app-import channel would inherit that hole.
 */
function parseManifest(raw: string, folder: string): LlmProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[snug] examples/${folder}/connection.json is not valid JSON — ignoring its declaration`);
    return null;
  }
  const result = llmProposalSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[snug] examples/${folder}/connection.json does not match the proposal schema — ignoring it`);
    return null;
  }
  return result.data;
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

  // Fact 2. BOTH the pinned factory version AND the version that actually RUNS must match
  // the bundle. Each half closes a different hole, and shipping either alone is unsafe:
  //
  //  - v1 alone (the original implementation) was defeated by the Gate-4 review: the
  //    iframe executes `current_version` (`RunView` → `library.getHtml` →
  //    `getAppHtml(id)` with no version), so a whole-DB import could supply v1 = the
  //    repo's real bytes (public, free to copy) plus current_version = attacker code.
  //    Both facts held while the running app had shipped nothing — and since credential
  //    brokering is keyed on appId, the attacker's version was the beneficiary of any
  //    approval. Fact 2's claim is "the bytes came from this repo", which is only an
  //    inference about the RUNNING app when the compared bytes are the ones that run.
  //  - current alone would be defeated the other way: an importer could leave a foreign
  //    v1 and set the latest version to the bundle, minting a declaration for an app
  //    whose install act never happened.
  //
  // Requiring both means a forgery must control every version row, and — more usefully —
  // an app the user has genuinely edited stops declaring, which is correct: the guided
  // setup vouches for shipped code, not for code the user has since changed.
  const factory = db.getAppHtml(appId, 1);
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
): Promise<{ declaration: LlmProposal } | null> {
  const intent = await resolveDeclaredIntent(db, appId);
  return intent.declaration === undefined ? null : { declaration: intent.declaration };
}

/** The starter id a declaring folder installs as — pinned through the ONE prefix rule. */
export function declaringStarterId(folder: string): string {
  return `${STARTER_PREFIX}${folder}`;
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
export async function starterDeclarationForStarterId(starterId: string): Promise<LlmProposal | null> {
  if (!starterId.startsWith(STARTER_PREFIX)) return null;

  const folder = starterId.slice(STARTER_PREFIX.length);
  const found = await bundled(folder);
  if (found === null) return null;

  return parseManifest(found.manifest, folder);
}
