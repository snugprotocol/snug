/**
 * sidecarIdentity — the INGRESS harvest feeding the R-9 egress scrub
 * (TASK-20260820-host-pseudonymisation).
 *
 * The host observes sidecar response bodies at the one governed platform seat every
 * executor-routed sidecar read crosses (`sidecarAppFetch` in state/net.ts — app runtime,
 * wizard probe, live pump alike; the wizard's separate `sidecarWizardFetch` command
 * touches only `/pair/*` and `/session/status` today, which carry no names — if a wizard
 * surface ever uses its Rust-granted `GET /chats` capability, route it through the
 * governed executor or the harvest goes blind to it) and collects third-party identities
 * into a directory with two homes:
 *
 *  - AN IN-MEMORY SET, updated synchronously BEFORE the response body is handed back, so
 *    an app that fetches /chats and immediately sends an LLM wire cannot outrun the
 *    harvest (plan review 2026-08-20, finding 8b — the first-wire race).
 *  - A PERSISTED `snug_settings` row (owner decision: survives sessions, so an app
 *    replaying raw names out of its own SQLite in a fresh session is still scrubbed).
 *    Persistence is best-effort behind the memory set: a failed write never fails the
 *    read the app is waiting on, and the session still scrubs from memory.
 *
 * THE EXTRACTION IS THE SCRUB (the `syncStateFromChatsBody` rule): only names and jids
 * from KNOWN fields of the ONE name-bearing route (`/chats`) are read — field by field,
 * never a spread. Message text, previews, unknown keys, unknown routes never enter the
 * directory; a directory that ingested content would itself become the leak. Harvest
 * scope mirrors the reference scrub's own map (examples/whatsapp/app.html): non-group
 * chat names (a group SUBJECT is not a personal identifier, and common-word subjects
 * would over-redact every sidecar app's wires), participant names, names ≥ 3 chars,
 * jid-placeholder names skipped — plus every jid seen.
 *
 * C1 note: this module receives (pathAndQuery, body) ONLY. The seat's argument tuple
 * carries injected credential headers and must never reach here.
 *
 * SESSION LIFECYCLE (Gate-5 review, altitude finding 2 / line-scan finding 3): the memory
 * set is scoped to ONE user-database identity. `resetSidecarIdentitySession()` must run
 * whenever the page's UserDb is swapped (import, restore, pull-merge) or a sidecar
 * connection is revoked / its app deleted — otherwise a later harvest would re-persist
 * names the db-level revoke-wipe deliberately destroyed, or write one user file's
 * contacts into another user file.
 *
 * Persisted-row lifecycle: DELETED by @snugprotocol/db when the last APPROVED
 * sidecar-ceiling connection is revoked or cascade-deleted (sidecar-identity-keys.ts).
 * An import that demotes rows to `declared` deliberately does NOT wipe: the app data the
 * scrub protects against rides the same import, so the directory must ride too.
 */

import { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, type UserDb } from '@snugprotocol/db';

/** Names shorter than this are never redacted by the scrub, so harvesting them is noise. */
const MIN_NAME_CHARS = 3;

const memory = new Set<string>();
let unpersisted = false;
/** Cheap short-circuit for the 4 s sync poll re-delivering an unchanged `/chats` body. */
let lastHarvestedBody: string | undefined;
/**
 * Bumped whenever the union this module answers could have changed — the read cache and
 * the egress module's compiled-matcher cache key off it (Gate-5 review, efficiency 2/3).
 */
let revision = 0;
let readCache: { db: UserDb; revision: number; result: readonly string[] } | undefined;

/** Production reset — see SESSION LIFECYCLE above. */
export function resetSidecarIdentitySession(): void {
  memory.clear();
  unpersisted = false;
  lastHarvestedBody = undefined;
  revision += 1;
  readCache = undefined;
}

export function __resetSidecarIdentityForTests(): void {
  resetSidecarIdentitySession();
}

function readPersisted(db: UserDb): readonly string[] {
  const stored = db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The union the egress scrub reads: persisted directory plus this session's harvest.
 * Cached per (db instance, revision) and returned as a STABLE array reference — the
 * egress module memoizes its compiled matcher on that identity. Staleness is one-sided
 * by construction: additions all flow through this module (bumping `revision`) or a db
 * swap (new instance misses the cache); an external DELETE (the revoke-wipe) can only
 * make the cache OVER-scrub for the rest of the session, never under-scrub.
 */
export function readIdentityDirectory(db: UserDb): readonly string[] {
  if (readCache !== undefined && readCache.db === db && readCache.revision === revision) {
    return readCache.result;
  }
  const result = [...new Set([...readPersisted(db), ...memory])];
  readCache = { db, revision, result };
  return result;
}

function harvestName(into: Set<string>, name: unknown, jid: unknown): void {
  if (typeof name !== 'string') return;
  if (name.length < MIN_NAME_CHARS) return;
  // A jid-placeholder is NOT a name (the reference scrub's own rule).
  if (name === jid) return;
  into.add(name);
}

function harvestJid(into: Set<string>, jid: unknown): void {
  if (typeof jid === 'string' && jid.length >= MIN_NAME_CHARS) into.add(jid);
}

/** Known fields of the known route — anything else is skipped, never repaired. */
function extractIdentities(pathAndQuery: string, body: string): Set<string> {
  const found = new Set<string>();
  const path = pathAndQuery.split('?')[0];
  if (path !== '/chats') return found;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return found;
  }
  const chats = (parsed as { chats?: unknown })?.chats;
  if (!Array.isArray(chats)) return found;
  for (const row of chats) {
    // Guard BEFORE any field read — the guard is the protection, not the type.
    if (row === null || typeof row !== 'object') continue;
    const chat = row as Record<string, unknown>;
    harvestJid(found, chat.jid);
    if (chat.isGroup !== true) harvestName(found, chat.name, chat.jid);
    if (Array.isArray(chat.participants)) {
      for (const entry of chat.participants) {
        if (entry === null || typeof entry !== 'object') continue;
        const part = entry as Record<string, unknown>;
        harvestJid(found, part.jid);
        harvestName(found, part.name, part.jid);
      }
    }
  }
  return found;
}

/**
 * Harvest one sidecar response into the MEMORY set. Synchronous and never throws — the
 * app's read is not hostage to the directory, and the caller must be able to hand the
 * body back knowing the very next call (which may be the LLM wire) sees this harvest.
 * Deliberately takes no UserDb: the seat this runs at must never boot one (the
 * sidecarAutostart contract — a db-less context still serves the read).
 */
export function harvestSidecarBody(pathAndQuery: string, body: string): void {
  try {
    if (body === lastHarvestedBody) return;
    let grew = false;
    for (const identity of extractIdentities(pathAndQuery, body)) {
      if (!memory.has(identity)) {
        memory.add(identity);
        grew = true;
      }
    }
    lastHarvestedBody = body;
    if (grew) {
      unpersisted = true;
      revision += 1;
    }
  } catch {
    // A body extractIdentities cannot read is skipped, never repaired.
  }
}

/**
 * Write the directory through to `snug_settings`, only when something NEW appeared
 * since the last successful write (the 4 s sync poll re-crosses the harvest seat with
 * an unchanged body, and a write per poll would churn the row). Never throws; a failed
 * write stays queued behind the flag, and the session scrubs from memory regardless.
 */
export function persistIdentityDirectory(db: UserDb): void {
  if (!unpersisted) return;
  try {
    const merged = new Set([...readPersisted(db), ...memory]);
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, [...merged].sort());
    unpersisted = false;
  } catch {
    // Best-effort: memory already holds this session's harvest; retry on the next call.
  }
}
