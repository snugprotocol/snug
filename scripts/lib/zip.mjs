// A zip writer, and the reader that proves what it wrote (D3).
//
// WHY IT IS HERE. Claude's "Customize → Plugins → Add → Upload plugin" takes a zip, and the
// plugin tree is built by a script with no dependencies (`docs/conventions.md`: one ADR per
// added dependency; a marketplace plugin's build is a scrutiny target). Shelling out to the
// machine's `zip` would put the builder's clock, umask, locale and Finder droppings into the
// archive. So the format is written here, from `node:zlib` alone — and narrowly:
//
//   - names are UTF-8 (general-purpose bit 11), sorted by their bytes, and every folder a
//     file sits in gets its own entry ahead of it, as `zip -r` writes them;
//   - DEFLATE when it shrinks the file, STORE when it does not;
//   - ONE fixed timestamp, so the same tree is the same bytes on every build;
//   - entries are "made on Unix" and carry their mode in the external attributes, because
//     that is the only place an unzip finds the bit that keeps a launcher runnable;
//   - a name that would land outside the folder the archive is unpacked into is REFUSED, and
//     a desktop's droppings (`OS_JUNK`) are never written.
//
// No zip64, no comment, no extra fields, no data descriptors: a count or a size the classic
// fields cannot hold fails in `Buffer`'s own range check rather than writing an archive that
// lies. The reader reads exactly this dialect — it is the writer's witness, not an unzip.
//
// Dependency-free node builtins only, like every other file under `scripts/`.

import zlib from 'node:zlib';

/**
 * What Finder, the Mac's archiver and Explorer leave in a folder a person has looked at.
 * The plugin directory refuses a tree that carries one; this module never writes one, and
 * `build-plugin.mjs` holds the built tree to the same list.
 */
export const OS_JUNK = Object.freeze(['.DS_Store', '__MACOSX', 'Thumbs.db', 'desktop.ini']);

const JUNK = new Set(OS_JUNK.map((name) => name.toLowerCase()));

/** Is any segment of this `/`-separated path one of `OS_JUNK`? (Explorer is case-blind, so this is too.) */
export function isOsJunk(name) {
  return name.split('/').some((segment) => JUNK.has(segment.toLowerCase()));
}

/**
 * 1980-01-01 00:00:00 — the earliest moment the format can name, which reads as "no time"
 * rather than as a build that happened. MS-DOS packing: date = (year − 1980) << 9 | month << 5
 * | day; time = hour << 11 | minute << 5 | second / 2.
 */
export const DOS_TIME = 0;
export const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, reflected, as zip uses it), a byte at a time. */
export function crc32ByTable(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `zlib.crc32` arrived in Node 20.15 / 22.2; the repo's floor is 20, so the table stands in below that. */
export const crc32 = typeof zlib.crc32 === 'function' ? (bytes) => zlib.crc32(bytes) : crc32ByTable;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_BYTES = 30;
const CENTRAL_BYTES = 46;
const END_BYTES = 22;
/** 2.0 — the version that reads DEFLATE and folders. */
const VERSION = 20;
/** Host 3 is Unix: it is what tells an unzip the top half of the external attributes is a `st_mode`. */
const MADE_ON_UNIX = (3 << 8) | VERSION;
const UTF8_NAMES = 0x0800;
const STORE = 0;
const DEFLATE = 8;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
/** The MS-DOS directory attribute, in the low byte — what a non-Unix unzip reads instead. */
const DOS_DIRECTORY = 0x10;

/** Why a name may not be an entry; undefined when it may. */
function nameRefusal(name) {
  if (typeof name !== 'string' || name === '') return 'a name is a non-empty string';
  if (name.includes('\\')) return 'a backslash is a path separator to a Windows unzip';
  if (name.includes('\0')) return 'a NUL ends the name early in a C unzip';
  if (/^[A-Za-z]:/.test(name)) return 'a drive letter makes it absolute';
  const segments = name.split('/');
  if (segments[0] === '') return 'an absolute path';
  if (segments.includes('..')) return '".." climbs out of the folder it is unpacked into';
  if (segments.includes('.') || segments.includes('')) return 'a path of plain names, with no empty or "." segment (folders are written for you)';
  return undefined;
}

/**
 * The 26 bytes a local header and a central header share (APPNOTE 4.3.7 from offset 4,
 * 4.3.12 from offset 6): version needed, flags, method, time, date, CRC, both sizes, the
 * name's length and a zero extra length.
 */
function sharedFields({ method, crc, stored, size, nameLength }) {
  const fields = Buffer.alloc(26);
  fields.writeUInt16LE(VERSION, 0);
  fields.writeUInt16LE(UTF8_NAMES, 2);
  fields.writeUInt16LE(method, 4);
  fields.writeUInt16LE(DOS_TIME, 6);
  fields.writeUInt16LE(DOS_DATE, 8);
  fields.writeUInt32LE(crc, 10);
  fields.writeUInt32LE(stored, 14);
  fields.writeUInt32LE(size, 18);
  fields.writeUInt16LE(nameLength, 22);
  return fields;
}

/**
 * The archive's bytes.
 *
 * @param {{ name: string, data: Buffer, mode: number }[]} files regular files: a relative
 *   `/`-separated name, the bytes, and the Unix permission bits (0o755, 0o644)
 * @returns {Buffer}
 */
export function createZip(files) {
  // By name, so a folder many files share is written once.
  const entries = new Map();
  for (const file of files) {
    const refusal = nameRefusal(file.name);
    if (refusal !== undefined) throw new Error(`zip: refused the entry name ${JSON.stringify(file.name)} — ${refusal}`);
    if (isOsJunk(file.name)) continue;
    const segments = file.name.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = `${segments.slice(0, depth).join('/')}/`;
      // 0755 whatever the builder's umask made of the real folder: the same tree, the same bytes.
      entries.set(folder, { name: folder, data: Buffer.alloc(0), mode: S_IFDIR | 0o755 });
    }
    entries.set(file.name, { name: file.name, data: file.data, mode: S_IFREG | (file.mode & 0o7777) });
  }

  const sorted = [...entries.values()]
    .map((entry) => ({ ...entry, nameBytes: Buffer.from(entry.name, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.nameBytes, b.nameBytes));

  const body = [];
  const directory = [];
  let offset = 0;
  for (const { data, mode, nameBytes } of sorted) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const shrinks = deflated.length < data.length;
    const packed = shrinks ? deflated : data;
    const shared = sharedFields({ method: shrinks ? DEFLATE : STORE, crc: crc32(data), stored: packed.length, size: data.length, nameLength: nameBytes.length });

    const local = Buffer.alloc(4);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    body.push(local, shared, nameBytes, packed);

    const central = Buffer.alloc(CENTRAL_BYTES);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(MADE_ON_UNIX, 4);
    shared.copy(central, 6);
    // 32–37: no comment, disk 0, no internal attributes.
    central.writeUInt32LE((((mode << 16) >>> 0) | (mode & S_IFDIR ? DOS_DIRECTORY : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);

    offset += LOCAL_BYTES + nameBytes.length + packed.length;
  }

  const directoryBytes = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(END_BYTES);
  end.writeUInt32LE(END_SIGNATURE, 0);
  // 4–7: this is disk 0, and the directory starts on it.
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directoryBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, ...directory, end]);
}

/**
 * Read an archive `createZip` wrote, VERIFYING it: each entry's local header against the
 * central directory, its inflated length against the recorded size, its bytes against the
 * recorded CRC. Throws `zip: …`, naming the entry, on the first thing that does not hold.
 *
 * @param {Buffer} archive
 * @returns {{ name: string, data: Buffer, crc32: number, mode: number, method: number }[]} in
 *   archive order; a folder's name ends in `/`; `mode` is the whole `st_mode` (type and permissions)
 */
export function readZip(archive) {
  const fail = (what) => {
    throw new Error(`zip: ${what}`);
  };
  const end = archive.length - END_BYTES;
  if (end < 0 || archive.readUInt32LE(end) !== END_SIGNATURE) fail('no end record in the last 22 bytes — the archive is cut short, or something follows it');
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  if (at + archive.readUInt32LE(end + 12) !== end) fail('the central directory does not end where the end record begins');

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_BYTES > end || archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) fail(`entry ${index + 1} of ${count} has no central header`);
    const shared = archive.subarray(at + 6, at + 32);
    const method = shared.readUInt16LE(4);
    const crc = shared.readUInt32LE(10);
    const stored = shared.readUInt32LE(14);
    const size = shared.readUInt32LE(18);
    const nameBytes = archive.subarray(at + CENTRAL_BYTES, at + CENTRAL_BYTES + shared.readUInt16LE(22));
    const name = nameBytes.toString('utf8');
    const mode = archive.readUInt32LE(at + 38) >>> 16;
    const local = archive.readUInt32LE(at + 42);
    at += CENTRAL_BYTES + nameBytes.length + shared.readUInt16LE(24) + archive.readUInt16LE(at + 32);

    const dataAt = local + LOCAL_BYTES + nameBytes.length;
    if (dataAt + stored > end || archive.readUInt32LE(local) !== LOCAL_SIGNATURE) fail(`${name}: no local header where the directory says it is`);
    if (!archive.subarray(local + 4, local + LOCAL_BYTES).equals(shared) || !archive.subarray(local + LOCAL_BYTES, dataAt).equals(nameBytes)) {
      fail(`${name}: its local header and the central directory disagree`);
    }
    if (method !== STORE && method !== DEFLATE) fail(`${name}: compression method ${method} is not one this module writes`);
    const packed = archive.subarray(dataAt, dataAt + stored);
    let data;
    try {
      data = method === DEFLATE ? zlib.inflateRawSync(packed) : Buffer.from(packed);
    } catch (error) {
      fail(`${name}: its data does not inflate (${error instanceof Error ? error.message : String(error)})`);
    }
    if (data.length !== size) fail(`${name}: ${data.length} bytes came out, and the directory says ${size}`);
    if (crc32(data) !== crc) fail(`${name}: CRC mismatch — these are not the bytes that were written`);
    entries.push({ name, data, crc32: crc, mode, method });
  }
  if (at !== end) fail('the central directory does not end where the end record begins');
  return entries;
}
