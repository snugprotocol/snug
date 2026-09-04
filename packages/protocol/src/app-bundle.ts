/**
 * App bundle — `snug-app-bundle/1`, the portable-starter format (TASK-20260904-app-sharing,
 * ADR-0063 §2). INTERNAL protocol surface.
 *
 * WHAT IT IS. One app, lifted out of a user's `.snug` file so another person can install
 * it: the app's identity fields, the CURRENT version's html, its runtime contract, the
 * registered data schema as DDL, the wiki docs its owner chose to include, and every
 * connection's REQUIREMENT half. It is what a starter is — code + declaration + docs —
 * minus the first-party trust, which is why the receiving side treats it as the untrusted
 * declaration channel ADR-0016 clause 6 anticipated.
 *
 * WHAT IT NEVER CARRIES, by shape. No `snug_secrets`, no grant fields (`status`,
 * `allowed_hosts`, `approved_at`, pending edits), no version history, no chat, no app
 * data rows — none of those have a seat, and `strictObject` at every level makes an
 * extra seat a rejection rather than a passthrough. Two seats are refused deliberately
 * even though the underlying schemas allow them: a connection's `userLayer` (registry-
 * synthesized only — a bundle aiming the three-legged flow at its own endpoints is the
 * v3 hole named in connection-requirement.ts), and any identity field — the receiver
 * computes `appBundleId` from the bytes, so a re-share cannot spoof dedup.
 *
 * DDL IS STRUCTURE ONLY. Every `schema.ddl` entry must be a single `CREATE …` statement:
 * `applyAppDdl` on the receiving hub executes whatever it is handed (only ATTACH /
 * writable_schema / load_extension are refused at the driver), so "structure only" is
 * enforced here, at the boundary, not by trusting the exporter.
 *
 * BOUNDS AT PARSE (C5). A bundle reaches the recipient from a mail attachment or a relay
 * fetch — both fully sender-controlled — so every cap is enforced here: per-field, per-list,
 * and a whole-bundle UTF-8 byte cap that is also the relay's admission size (ADR-0064).
 *
 * PUBLICATION LINE: like connection-requirement.ts and runtime-contract.ts, deliberately
 * NOT in `json-schemas.ts` SOURCES. Promotion to `schemas/` is its own spec-sync.
 */

import { z } from 'zod';
import { LIMITS } from './constants.js';
import { AUTH_MAX_SLOTS_PER_APP, connectionRequirementSchema } from './connection-requirement.js';
import { runtimeContractSchema } from './runtime-contract.js';

// ------------------------------------------------------------------ constants

export const APP_BUNDLE_FORMAT = 'snug-app-bundle/1' as const;

/** Whole-bundle cap in UTF-8 BYTES of the serialized JSON — also the relay's admission size. */
export const APP_BUNDLE_MAX_BYTES = 1024 * 1024;
/** The html seat, in code units. The largest shipped starter is ~117 KB; this leaves 6× headroom under the byte cap. */
export const APP_BUNDLE_MAX_HTML_CHARS = 768 * 1024;
export const APP_BUNDLE_MAX_DOCS = 16;
export const APP_BUNDLE_MAX_DOC_CONTENT_CHARS = 128 * 1024;
export const APP_BUNDLE_MAX_DOC_TITLE_CHARS = 200;
export const APP_BUNDLE_MAX_DDL_STATEMENTS = 64;
export const APP_BUNDLE_MAX_DDL_STATEMENT_CHARS = 16 * 1024;
export const APP_BUNDLE_MAX_HUB_VERSION_CHARS = 40;

/**
 * Doc slug charset — the app-doc-write tool's own contract ("lowercase, hyphens
 * allowed"), bounded. A doc whose slug does not fit does not travel; the exporter says so.
 */
export const APP_BUNDLE_DOC_SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Lineage = the sharer's app id, a lowercase UUID. The charset is the security property:
 * the installer mints `install_source = 'share:<lineage>'` from this value, and a UUID
 * cannot spell `starter:<folder>` (or carry a `:` at all), so a bundle can never claim a
 * starter's identity and reach `starterDeclaration`'s vouch (ADR-0063 §5, finding 9).
 */
export const APP_BUNDLE_LINEAGE_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The statement PREFIX every DDL entry must carry. Case-insensitive because SQLite is.
 * `isStructureOnlyDdl` adds the "one statement" half: a regex cannot parse SQL, so the
 * rule is deliberately narrow — for everything but a trigger, no `;` may appear before
 * an optional trailing one; a trigger (whose body legitimately holds `;`) must end at
 * its `END` and may carry no comment token, which is the only way a second statement
 * could hide behind a trailing `END`. Statements the registry emits (`sqlite_master.sql`
 * verbatim) satisfy this; a hand-edited file that does not simply does not travel.
 */
export const APP_BUNDLE_DDL_STATEMENT_RULE =
  /^\s*CREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|VIRTUAL\s+TABLE)\b/i;

const TRIGGER_PREFIX_RULE = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const TRIGGER_TAIL_RULE = /\bEND\s*;?\s*$/i;
const SINGLE_STATEMENT_RULE = /^[^;]*;?\s*$/;

export function isStructureOnlyDdl(sql: string): boolean {
  if (!APP_BUNDLE_DDL_STATEMENT_RULE.test(sql)) return false;
  if (TRIGGER_PREFIX_RULE.test(sql)) {
    return TRIGGER_TAIL_RULE.test(sql) && !sql.includes('--') && !sql.includes('/*');
  }
  return SINGLE_STATEMENT_RULE.test(sql);
}

/** ISO-8601 UTC instant, as `new Date().toISOString()` emits it. */
const ISO_INSTANT_RULE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HUB_VERSION_RULE = /^[A-Za-z0-9.+-]+$/;

// --------------------------------------------------------------------- schema

const appIdentitySchema = z.strictObject({
  displayName: z.string().min(1).max(LIMITS.DISPLAY_NAME_CHARS),
  description: z.string().max(LIMITS.DESCRIPTION_CHARS).optional(),
  iconEmoji: z.string().max(LIMITS.ICON_EMOJI_CHARS).optional(),
  iconColor: z.string().max(LIMITS.ICON_COLOR_CHARS).optional(),
  usesDb: z.boolean(),
});

const appBundleDocSchema = z.strictObject({
  slug: z.string().regex(APP_BUNDLE_DOC_SLUG_RULE),
  title: z.string().min(1).max(APP_BUNDLE_MAX_DOC_TITLE_CHARS).optional(),
  content: z.string().min(1).max(APP_BUNDLE_MAX_DOC_CONTENT_CHARS),
});

const appBundleSchemaSeat = z.strictObject({
  ddl: z
    .array(
      z
        .string()
        .min(1)
        .max(APP_BUNDLE_MAX_DDL_STATEMENT_CHARS)
        .refine(isStructureOnlyDdl, 'schema.ddl entries must each be one CREATE statement — structure travels, rows never'),
    )
    .max(APP_BUNDLE_MAX_DDL_STATEMENTS),
});

const producerSchema = z.strictObject({
  hubVersion: z.string().min(1).max(APP_BUNDLE_MAX_HUB_VERSION_CHARS).regex(HUB_VERSION_RULE).optional(),
});

const bundleConnectionSchema = connectionRequirementSchema.refine(
  (requirement) => requirement.userLayer === undefined,
  { message: 'a bundle may not carry a userLayer — that seat is registry-synthesized only', path: ['userLayer'] },
);

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const appBundleSchema = z
  .strictObject({
    format: z.literal(APP_BUNDLE_FORMAT),
    lineage: z.string().regex(APP_BUNDLE_LINEAGE_RULE),
    sharedAt: z.string().regex(ISO_INSTANT_RULE),
    producer: producerSchema.optional(),
    app: appIdentitySchema,
    html: z.string().min(1).max(APP_BUNDLE_MAX_HTML_CHARS),
    contract: runtimeContractSchema.optional(),
    schema: appBundleSchemaSeat.optional(),
    docs: z.array(appBundleDocSchema).max(APP_BUNDLE_MAX_DOCS).optional(),
    connections: z.array(bundleConnectionSchema).max(AUTH_MAX_SLOTS_PER_APP),
  })
  .superRefine((bundle, ctx) => {
    const slots = new Set<string>();
    bundle.connections.forEach((connection, index) => {
      if (slots.has(connection.slot)) {
        ctx.addIssue({ code: 'custom', message: `duplicate connection slot "${connection.slot}"`, path: ['connections', index, 'slot'] });
      }
      slots.add(connection.slot);
    });
    const slugs = new Set<string>();
    (bundle.docs ?? []).forEach((doc, index) => {
      if (slugs.has(doc.slug)) {
        ctx.addIssue({ code: 'custom', message: `duplicate doc slug "${doc.slug}"`, path: ['docs', index, 'slug'] });
      }
      slugs.add(doc.slug);
    });
    if (utf8Bytes(JSON.stringify(bundle)) > APP_BUNDLE_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `the serialized bundle must be at most ${APP_BUNDLE_MAX_BYTES} bytes` });
    }
  });

export type AppBundle = z.infer<typeof appBundleSchema>;
export type AppBundleDoc = z.infer<typeof appBundleDocSchema>;

// ------------------------------------------------------------------ boundary read

export type AppBundleParse =
  | { ok: true; bundle: AppBundle }
  | { ok: false; reason: 'too-large' }
  | { ok: false; reason: 'not-json' }
  | { ok: false; reason: 'not-a-bundle' }
  | { ok: false; reason: 'invalid'; issues: readonly { path: string; message: string }[] };

/**
 * The ONE reader for bundle text arriving from outside — an attachment's bytes, a relay
 * fetch's plaintext. Size is checked before `JSON.parse` so an oversized file cannot
 * cost a parse; a leading BOM and whitespace are tolerated because mail clients add them;
 * `not-a-bundle` is distinguished from `invalid` so a user who picked the wrong file kind
 * gets told that, not a schema error.
 */
export function parseAppBundle(text: string): AppBundleParse {
  if (utf8Bytes(text) > APP_BUNDLE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const trimmed = text.replace(/^﻿/, '').trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof json !== 'object' || json === null || (json as { format?: unknown }).format !== APP_BUNDLE_FORMAT) {
    return { ok: false, reason: 'not-a-bundle' };
  }
  const parsed = appBundleSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
    };
  }
  return { ok: true, bundle: parsed.data };
}

// ------------------------------------------------------------- content identity

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

/**
 * Canonical bytes: key-sorted, whitespace-free JSON. ARRAY ORDER IS PRESERVED — docs and
 * DDL are ordered content (the same reasoning as `canonicalRequirementHash`).
 */
export function canonicalAppBundleJson(bundle: AppBundle): string {
  return JSON.stringify(sortKeysDeep(bundle));
}

/**
 * `bundleId` — sha-256 of the canonical JSON, hex. Computed by the RECEIVER from the
 * bytes it holds (never read from the bundle); it is the inbox's dedup key and the
 * per-app "which bundle did I install" marker that detects a re-share as an update by
 * identity rather than by html byte-equality (lesson 2026-08-21).
 */
export async function appBundleId(bundle: AppBundle): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalAppBundleJson(bundle));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
