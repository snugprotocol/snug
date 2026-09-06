// Type contract for scripts/lib/page-blocks.mjs — consumed by apps/host (the artifact
// record, the hand-in, the starters-index plugin). The `release-desktop.d.mts` precedent:
// hand-kept, one rule with the .mjs. TASK-20260905-binding-a-artifacts.

export interface TopLevelElement {
  name: string;
  attrs: Record<string, string>;
  /** Offset of the start tag's `<`. */
  index: number;
  /** Offset just past the element (the end tag's `>` for script/style; the start tag's `>` otherwise). */
  end: number;
  /** Raw body, present for `<script>` and `<style>` only. */
  body?: string;
}

export function tokenizeTopLevel(html: string): TopLevelElement[];
export function escapeForInlineScript(json: string): string;

export const DB_BLOCK_ID: 'snug-db';
export const DB_BLOCK_FORMAT: 'snug-db-block/1';
export const BUNDLE_BLOCK_TYPE: 'application/snug-app-bundle+json';
export const LINEAGE_RULE: RegExp;

export interface DbBlockManifest {
  format: 'snug-db-block/1';
  /** Byte length of the decoded file. */
  bytes: number;
  /** Hex sha-256 of the decoded file. */
  sha256: string;
  /** Monotonic save counter — the divergence direction is decided on it. */
  saved: number;
  /** ISO instant of that save. */
  savedAt: string;
}

export type DbBlockRead =
  | { manifest: DbBlockManifest; base64: string; index: number; end: number; corrupt?: undefined }
  | { corrupt: string; manifest?: undefined; base64?: undefined };

/** A db block's body parsed: the manifest (every field validated) and the base64, or `corrupt`. */
export type DbBlockBody = { manifest: DbBlockManifest; base64: string; corrupt?: undefined } | { corrupt: string; manifest?: undefined; base64?: undefined };
export function parseDbBlockBody(body: string): DbBlockBody;
export function readDbBlock(html: string): DbBlockRead | undefined;
/** Every external reference a stylesheet makes (an `@import`, or a non-`data:` `url(…)`). */
export function externalCssRefs(css: string): ({ kind: 'import' } | { kind: 'url'; url: string })[];
export function writeDbBlock(html: string, block: { manifest: DbBlockManifest; base64: string }): string;

export interface BundleBlockRead {
  lineage: string;
  /** The bundle text with `<` restored, unparsed — the strict parser decides. */
  json: string;
  index: number;
  end: number;
}

export function readBundleBlocks(html: string): BundleBlockRead[];
export function upsertBundleBlock(html: string, lineage: string, json: string): string;
export function removeBundleBlock(html: string, lineage: string): string;
export function verifyKitPage(html: string, options: { expectedStamp: string }): string[];

/** The kit document lifted out of the artifact viewer's wrapper (a bare page passes through); a named `problem` when the wrapper is not the measured shape. */
export type UnwrapResult = { html: string; wrapped: boolean; problem?: undefined } | { html?: undefined; wrapped: true; problem: string };
export function unwrapViewerPage(html: string): UnwrapResult;
