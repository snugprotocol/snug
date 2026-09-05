// artifactHtml.ts — the hosted artifact's durable record OVER the browser bucket
// (TASK-20260905-binding-a-artifacts AC5, ADR-0065 §2). Two seams, not one:
//
//   the BUCKET (OPFS / IndexedDB / memory — the rung the probe found working) holds the
//   WORKING COPY: every debounced `openUserDb` save lands there in milliseconds (S4b: 5 ms).
//   the PAGE's own `snug-db` block holds the DURABLE COPY: written by ONE explicit act —
//   `publish()` — that republishes the artifact's html with the bytes embedded (S4b: 1.8 s
//   per 2 MiB, a version and a reload). Never on load, never on a timer.
//
// `load` is bucket-first and seeds the bucket from the block ONLY when the bucket is empty
// (one counted save). A bucket copy that differs from the block is a DIVERGENCE with a
// direction (the block's save counter against the counter the bucket last saw, kept in a
// magic-prefixed sidecar file); nothing is overwritten — the chip offers the two acts.
//
// The page source for a republish is FETCHED (`canonicalSource`) and verified by the shared
// tokenizer — never serialized from the live DOM, which carries the viewer's injected runtime
// (artifact.d.ts 0.2.41). A page that is not the kit page is refused by name; a projected
// page over the artifact cap is refused with its three parts named; nothing in the bucket
// is "nothing to save". Every runtime code is mapped, and `conflict` keeps the copy safe:
// the bucket still holds it, the note survives the reload through sessionStorage.

import { SYNC_SIDECAR_MAGIC, bytesToBase64, base64ToBytes, type PersistenceBackend } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';

import { DB_BLOCK_FORMAT, readBundleBlocks, verifyKitPage, writeDbBlock, type DbBlockManifest, type DbBlockRead } from '../../../../scripts/lib/page-blocks.mjs';
import type { CustodyStore } from './custodyStore.js';
import { sha256Hex } from './sha256.js';

/** The viewer's 16 MiB page cap, minus a margin for the runtime the viewer injects. */
export const ARTIFACT_MAX_PAGE_BYTES = 16 * 1024 * 1024 - 512 * 1024;
/** Where "load the page's copy" parks the browser's copy first. */
export const BEFORE_LOAD_FILE = `${USERDB_FILE}.before-load`;
/** The bucket's counter sidecar — the save number this browser last published or loaded. Magic-prefixed: every backend gates completeness on first bytes. */
export const CUSTODY_SIDECAR_FILE = `${USERDB_FILE}.custody`;
/** A publish reloads the view; the note is stashed here and rendered after. */
export const CUSTODY_NOTE_STASH_KEY = 'snug-host:custody-note';

export type PublishOutcome =
  | { ok: true; version: string; saved: number }
  | { ok: false; reason: 'read-only' | 'not-the-kit-page' | 'too-large' | 'nothing-to-save' | 'conflict' | 'busy' | 'failed'; message: string };

export interface ArtifactRecordOptions {
  bucket: PersistenceBackend;
  /** The page's own block as read at boot (`readDbBlock`), or `undefined` when the page carries none. */
  pageBlock: DbBlockRead | undefined;
  /** The page's canonical source — `fetch(location.href)` on the real page, never the DOM. */
  canonicalSource: () => Promise<string>;
  /** The running page's build stamp; the fetched source must carry the same one. */
  expectedStamp: string;
  /** `artifact.publish` (html form); absent → read-only from the start. */
  publish: ((html: string) => Promise<{ version: string }>) | undefined;
  store: CustodyStore;
  /** Test seam: the counter the bucket last saw (production reads the sidecar). */
  custodyStart?: { saved: number };
  maxPageBytes?: number;
  now?: () => Date;
}

export interface ArtifactRecord {
  backend: PersistenceBackend;
  publish(): Promise<PublishOutcome>;
  canSave(): boolean;
  /** Keep the browser copy under BEFORE_LOAD_FILE, then take the page's copy. */
  loadPageCopy(): Promise<void>;
  /** Keep the browser copy; the divergence is resolved and the copy is dirty relative to the page. */
  keepBrowserCopy(): void;
}

export class ArtifactRecordCorrupt extends Error {
  constructor(detail: string) {
    super(`the copy of your file saved in this artifact is corrupt: ${detail}`);
    this.name = 'ArtifactRecordCorrupt';
  }
}

const format = (n: number): string => n.toLocaleString('en-US');
const utf8 = (s: string): number => new TextEncoder().encode(s).length;

function stashNote(note: string): void {
  try {
    sessionStorage.setItem(CUSTODY_NOTE_STASH_KEY, note);
  } catch {
    /* no session storage here — the store still carries the note */
  }
}

export function createArtifactRecord(options: ArtifactRecordOptions): ArtifactRecord {
  const { bucket, pageBlock, store } = options;
  const maxPageBytes = options.maxPageBytes ?? ARTIFACT_MAX_PAGE_BYTES;
  const now = options.now ?? (() => new Date());
  let readOnly = options.publish === undefined;
  if (readOnly) store.patch({ readOnly: true });
  /** The counter this browser last published or loaded; `undefined` until read. */
  let custody: { saved: number } | undefined = options.custodyStart;
  let custodyRead = options.custodyStart !== undefined;

  const readCustody = async (): Promise<{ saved: number } | undefined> => {
    if (custodyRead) return custody;
    custodyRead = true;
    try {
      const raw = await bucket.load(CUSTODY_SIDECAR_FILE);
      if (raw === undefined) return undefined;
      const text = new TextDecoder().decode(raw);
      if (!text.startsWith(SYNC_SIDECAR_MAGIC)) return undefined;
      const parsed = JSON.parse(text.slice(SYNC_SIDECAR_MAGIC.length)) as { saved?: unknown };
      custody = typeof parsed.saved === 'number' ? { saved: parsed.saved } : undefined;
    } catch {
      custody = undefined;
    }
    return custody;
  };
  const writeCustody = async (saved: number): Promise<void> => {
    custody = { saved };
    custodyRead = true;
    await bucket.save(CUSTODY_SIDECAR_FILE, new TextEncoder().encode(`${SYNC_SIDECAR_MAGIC}${JSON.stringify({ saved })}`));
  };

  const blockOrCorrupt = (): { manifest: DbBlockManifest; base64: string } | undefined => {
    if (pageBlock === undefined) return undefined;
    if (pageBlock.corrupt !== undefined) throw new ArtifactRecordCorrupt(pageBlock.corrupt);
    return { manifest: pageBlock.manifest, base64: pageBlock.base64 };
  };

  /** The block's bytes, verified against its own manifest — corrupt is a throw, never "fresh". */
  const decodeBlock = async (block: { manifest: DbBlockManifest; base64: string }): Promise<Uint8Array> => {
    const bytes = base64ToBytes(block.base64);
    if (bytes === undefined) throw new ArtifactRecordCorrupt('the embedded bytes are not base64');
    if (bytes.length !== block.manifest.bytes || (await sha256Hex(bytes)) !== block.manifest.sha256) {
      throw new ArtifactRecordCorrupt('the embedded bytes do not match their sha256');
    }
    return bytes;
  };

  const savedOf = (m: DbBlockManifest): { saved: number; savedAt: string } => ({ saved: m.saved, savedAt: m.savedAt });

  const loadUserFile = async (): Promise<Uint8Array | undefined> => {
    const mine = await bucket.load(USERDB_FILE);
    let block: { manifest: DbBlockManifest; base64: string } | undefined;
    try {
      block = blockOrCorrupt();
    } catch (error) {
      // A good bucket copy beside an unreadable page block: the user keeps working; the
      // chip says the page's copy is unreadable. An empty bucket has nothing to fall back on.
      if (mine === undefined) throw error;
      store.patch({ dirty: true, note: (error as Error).message });
      return mine;
    }
    if (mine === undefined) {
      if (block === undefined) return undefined; // genuinely fresh
      const bytes = await decodeBlock(block);
      await bucket.save(USERDB_FILE, bytes);
      await writeCustody(block.manifest.saved);
      store.patch({ dirty: false, divergence: undefined, saved: savedOf(block.manifest) });
      return bytes;
    }
    if (block === undefined) {
      store.patch({ dirty: true, divergence: undefined });
      return mine;
    }
    const seen = await readCustody();
    if ((await sha256Hex(mine)) === block.manifest.sha256) {
      if (seen === undefined) await writeCustody(block.manifest.saved);
      store.patch({ dirty: false, divergence: undefined, saved: savedOf(block.manifest) });
      return mine;
    }
    // Different bytes: a divergence with a direction. An unknown counter reads as "newer" —
    // the copy the user has been working in is never suggested away.
    const direction = seen === undefined || seen.saved >= block.manifest.saved ? 'newer' : 'older';
    store.patch({ divergence: direction, saved: savedOf(block.manifest) });
    return mine;
  };

  const backend: PersistenceBackend = {
    kind: 'artifact-html',
    load: (file) => (file === USERDB_FILE ? loadUserFile() : bucket.load(file)),
    async save(file, bytes) {
      await bucket.save(file, bytes);
      if (file === USERDB_FILE) store.patch({ dirty: true });
    },
  };

  const refuse = (reason: Exclude<PublishOutcome, { ok: true }>['reason'], message: string): PublishOutcome => {
    store.patch({ note: message });
    return { ok: false, reason, message };
  };

  const publish = async (): Promise<PublishOutcome> => {
    if (readOnly || options.publish === undefined) return refuse('read-only', 'this view cannot save to the artifact — export to keep a copy');
    const bytes = await bucket.load(USERDB_FILE);
    if (bytes === undefined) return refuse('nothing-to-save', 'there is no file to save yet');
    let source: string;
    try {
      source = await options.canonicalSource();
    } catch (error) {
      return refuse('failed', `the page’s own source could not be read (${(error as Error).message}) — nothing was saved`);
    }
    const problems = verifyKitPage(source, { expectedStamp: options.expectedStamp });
    if (problems.length > 0) {
      return refuse('not-the-kit-page', `the page’s source is not the Snug page this view is running (${problems[0]}) — nothing was saved; export to keep a copy`);
    }
    const seen = await readCustody();
    const previous = Math.max(pageBlock?.manifest?.saved ?? 0, seen?.saved ?? 0);
    const saved = previous + 1;
    const base64 = bytesToBase64(bytes);
    const manifest: DbBlockManifest = { format: DB_BLOCK_FORMAT, bytes: bytes.length, sha256: await sha256Hex(bytes), saved, savedAt: now().toISOString() };
    const html = writeDbBlock(source, { manifest, base64 });
    const projected = utf8(html);
    if (projected > maxPageBytes) {
      const bundles = readBundleBlocks(source).reduce((n, b) => n + utf8(b.json), 0);
      const pageAlone = projected - base64.length - bundles;
      return refuse(
        'too-large',
        `the saved page would be ${format(projected)} bytes (the page ${format(pageAlone)} + your file as text ${format(base64.length)} + handed-in apps ${format(bundles)}), over this artifact’s ${format(maxPageBytes)}-byte limit — export your file to keep it`,
      );
    }
    stashNote(`saved to this artifact (save #${saved})`);
    try {
      const { version } = await options.publish(html);
      await writeCustody(saved);
      store.patch({ dirty: false, divergence: undefined, note: undefined, saved: { saved, savedAt: manifest.savedAt } });
      return { ok: true, version, saved };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      switch (code) {
        case 'conflict': {
          const note = 'someone published this artifact first — your copy is safe in this browser; save again';
          stashNote(note);
          return refuse('conflict', note);
        }
        case 'not_writer':
        case 'not_granted':
        case 'not_declared':
        case 'capability_disabled':
        case 'capability_removed':
          readOnly = true;
          store.patch({ readOnly: true });
          stashNote('read-only view — export to keep a copy');
          return refuse('read-only', 'this view can read the artifact but not save it — export to keep a copy');
        case 'too_large':
          return refuse('too-large', `the artifact refused the page as too large (${format(projected)} bytes) — export your file to keep it`);
        case 'rate_limited':
          return refuse('busy', 'the artifact is being saved too often — wait a moment and save again');
        default:
          return refuse('failed', `the save failed${typeof code === 'string' ? ` (${code})` : ''} — your copy is safe in this browser; export to keep it`);
      }
    }
  };

  return {
    backend,
    publish,
    canSave: () => !readOnly && options.publish !== undefined,
    async loadPageCopy() {
      const block = blockOrCorrupt();
      if (block === undefined) return;
      const bytes = await decodeBlock(block);
      const mine = await bucket.load(USERDB_FILE);
      if (mine !== undefined) await bucket.save(BEFORE_LOAD_FILE, mine);
      await bucket.save(USERDB_FILE, bytes);
      await writeCustody(block.manifest.saved);
      store.patch({ dirty: false, divergence: undefined, saved: savedOf(block.manifest) });
    },
    keepBrowserCopy() {
      store.patch({ divergence: undefined, dirty: true });
    },
  };
}
