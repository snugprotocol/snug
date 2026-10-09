// D3 — the plugin archive's writer, and the reader that proves what it wrote.
//
// The archive is what a person uploads to Claude (Customize → Plugins → Add → Upload plugin),
// so each property here is one a host's unzip depends on: the names it will create, the bytes
// and their CRCs, the mode that keeps the launcher runnable, and — because the archive is
// rebuilt on every gate run — that the same tree is the same bytes. Every rule has a case
// that fails without it; the layout is also read HERE, by offsets, so the module's reader is
// not the only witness to the module's writer.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import { crc32, crc32ByTable, createZip, DOS_DATE, DOS_TIME, OS_JUNK, readZip } from './zip.mjs';

const LAUNCHER = '#!/bin/sh\necho launched\n';

/** Bytes deflate cannot shrink — a hash chain, so they are the same bytes on every run. */
function noise(length) {
  const blocks = [];
  let block = Buffer.from('snug');
  for (let have = 0; have < length; have += block.length) {
    block = createHash('sha256').update(block).digest();
    blocks.push(block);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const files = () => [
  { name: 'snug/scripts/snug', data: Buffer.from(LAUNCHER), mode: 0o755 },
  { name: 'snug/README.md', data: Buffer.from('# Snug\n'.repeat(200)), mode: 0o644 },
  { name: 'snug/skills/snug/assets/noise.bin', data: noise(4096), mode: 0o644 },
  { name: 'snug/empty', data: Buffer.alloc(0), mode: 0o644 },
  { name: 'snug/références/één.md', data: Buffer.from('héllo'), mode: 0o600 },
];

/** Every header's raw fields, by offset (APPNOTE 4.3.7, 4.3.12, 4.3.16) — not through `readZip`. */
function rawHeaders(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'the end record is the last 22 bytes');
  const count = archive.readUInt16LE(end + 10);
  const headers = [];
  let at = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    headers.push({
      name: archive.toString('utf8', at + 46, at + 46 + nameLength),
      madeBy: archive.readUInt16LE(at + 4),
      external: archive.readUInt32LE(at + 38),
      central: { flags: archive.readUInt16LE(at + 8), method: archive.readUInt16LE(at + 10), time: archive.readUInt16LE(at + 12), date: archive.readUInt16LE(at + 14) },
      local: { flags: archive.readUInt16LE(local + 6), method: archive.readUInt16LE(local + 8), time: archive.readUInt16LE(local + 10), date: archive.readUInt16LE(local + 12) },
      stored: archive.readUInt32LE(at + 20),
      size: archive.readUInt32LE(at + 24),
    });
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  assert.equal(at, end, 'the central directory ends where the end record begins');
  return headers;
}

describe('the round trip', () => {
  it('gives back every name, every byte, every CRC and every mode', () => {
    const written = files();
    const read = readZip(createZip(written));
    for (const file of written) {
      const entry = read.find((candidate) => candidate.name === file.name);
      assert.ok(entry, `${file.name} did not come back`);
      assert.deepEqual(entry.data, file.data, file.name);
      assert.equal(entry.crc32, crc32ByTable(file.data), file.name);
      assert.equal(entry.mode, 0o100000 | file.mode, `${file.name} lost its mode`);
    }
    // …and nothing else but the folders those files sit in.
    assert.deepEqual(
      read.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name).sort(),
      written.map((file) => file.name).sort(),
    );
  });

  it('writes each folder once, as a 0755 directory, ahead of what is in it', () => {
    // What `zip -r` writes: an extractor that takes a folder's mode from its own entry gets
    // one a person can enter, whatever the builder's umask was.
    const read = readZip(createZip(files()));
    const folders = read.filter((entry) => entry.name.endsWith('/'));
    assert.deepEqual(
      folders.map((entry) => entry.name),
      ['snug/', 'snug/références/', 'snug/scripts/', 'snug/skills/', 'snug/skills/snug/', 'snug/skills/snug/assets/'],
    );
    for (const folder of folders) {
      assert.equal(folder.mode, 0o040755, folder.name);
      assert.equal(folder.data.length, 0);
    }
    const names = read.map((entry) => entry.name);
    for (const name of names) {
      const parent = name.replace(/[^/]+\/?$/, '');
      if (parent !== '') assert.ok(names.indexOf(parent) < names.indexOf(name), `${parent} must come before ${name}`);
    }
  });

  it('sorts the entries by path, whatever order they were given in', () => {
    const names = readZip(createZip(files().reverse())).map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(names[0], 'snug/');
  });

  it('deflates what deflate shrinks and STORES what it does not', () => {
    const headers = rawHeaders(createZip(files()));
    const of = (name) => headers.find((header) => header.name === name);
    assert.equal(of('snug/README.md').central.method, 8);
    assert.ok(of('snug/README.md').stored < of('snug/README.md').size);
    // The mutant: deflating everything — noise comes out LARGER than it went in.
    assert.equal(of('snug/skills/snug/assets/noise.bin').central.method, 0);
    assert.equal(of('snug/skills/snug/assets/noise.bin').stored, 4096);
    assert.equal(of('snug/empty').central.method, 0);
    assert.equal(of('snug/empty').stored, 0);
    for (const header of headers) assert.equal(header.local.method, header.central.method, header.name);
  });

  it('marks every name UTF-8 and every entry as made on Unix — which is what makes the mode bits mean a mode', () => {
    const headers = rawHeaders(createZip(files()));
    for (const header of headers) {
      assert.equal(header.central.flags, 0x0800, header.name);
      assert.equal(header.local.flags, 0x0800, header.name);
      assert.equal(header.madeBy >> 8, 3, `${header.name} must say it was made on Unix`);
    }
    assert.equal(headers.find((header) => header.name === 'snug/scripts/snug').external >>> 16, 0o100755);
    assert.ok(headers.some((header) => header.name === 'snug/références/één.md'));
  });
});

describe('the same tree is the same bytes', () => {
  it('stamps every header with one FIXED time — the format’s own epoch, never the clock', () => {
    // The mutant this kills is `new Date()`: two builds a moment apart would still agree
    // (the format keeps two-second steps), so equality alone would not see it.
    assert.deepEqual([DOS_TIME, DOS_DATE], [0, (0 << 9) | (1 << 5) | 1], '1980-01-01 00:00:00');
    for (const header of rawHeaders(createZip(files()))) {
      assert.deepEqual([header.local.time, header.local.date], [DOS_TIME, DOS_DATE], header.name);
      assert.deepEqual([header.central.time, header.central.date], [DOS_TIME, DOS_DATE], header.name);
    }
  });

  it('is byte-identical across two runs, and does not depend on the order it was handed the files', () => {
    const first = createZip(files());
    assert.ok(first.equals(createZip(files())));
    assert.ok(first.equals(createZip(files().reverse())));
  });
});

describe('a name that would leave the folder it is unpacked into is REFUSED', () => {
  const file = (name) => [{ name, data: Buffer.from('x'), mode: 0o644 }];

  for (const name of ['../evil', 'snug/../../evil', 'snug/..', '..', '/etc/passwd', '//server/share', 'C:/Windows/x', 'c:evil', 'snug\\..\\..\\evil', '..\\evil', 'snug//x', 'snug/./x', './x', 'snug/', '', 'snug/a\0b']) {
    it(`refuses ${JSON.stringify(name)}`, () => {
      assert.throws(() => createZip(file(name)), /zip: refused the entry name/);
    });
  }

  it('names the entry it refused, and writes nothing for the others', () => {
    assert.throws(() => createZip([...files(), ...file('snug/../../.ssh/authorized_keys')]), /authorized_keys.*climbs out/);
  });

  it('says WHICH rule: an absolute path is called one', () => {
    assert.throws(() => createZip(file('/etc/passwd')), /"\/etc\/passwd" — an absolute path/);
  });

  it('refuses a name that is not a string at all', () => {
    assert.throws(() => createZip([{ name: undefined, data: Buffer.from('x'), mode: 0o644 }]), /zip: refused the entry name/);
  });

  it('still takes a dot that is only PART of a name', () => {
    const names = readZip(createZip(file('snug/.claude-plugin/plugin..json'))).map((entry) => entry.name);
    assert.deepEqual(names, ['snug/', 'snug/.claude-plugin/', 'snug/.claude-plugin/plugin..json']);
  });
});

describe('what a desktop leaves lying in a folder is never written', () => {
  it('names the four: Finder’s, the Mac archiver’s, and Explorer’s two', () => {
    assert.deepEqual([...OS_JUNK].sort(), ['.DS_Store', 'Thumbs.db', '__MACOSX', 'desktop.ini']);
  });

  it('drops them at any depth — the file, and everything under a folder of that name', () => {
    // `Desktop.ini`: Explorer writes both spellings and cannot tell them apart.
    const junk = ['snug/.DS_Store', 'snug/skills/.DS_Store', '__MACOSX/snug/._README.md', 'snug/__MACOSX/x', 'snug/assets/Thumbs.db', 'snug/desktop.ini', 'snug/skills/Desktop.ini'];
    const archive = createZip([...files(), ...junk.map((name) => ({ name, data: Buffer.from('junk'), mode: 0o644 }))]);
    assert.ok(archive.equals(createZip(files())), 'the archive must be exactly the one without them');
    for (const word of OS_JUNK) assert.equal(archive.includes(word), false, `${word} is in the archive's bytes`);
  });

  it('keeps a file that only resembles one', () => {
    const names = readZip(createZip([{ name: 'snug/my.DS_Store.md', data: Buffer.from('x'), mode: 0o644 }])).map((entry) => entry.name);
    assert.ok(names.includes('snug/my.DS_Store.md'));
  });
});

describe('the reader verifies what it reads', () => {
  it('catches one changed byte of a STORED file — by its CRC, and by name', () => {
    const archive = createZip(files());
    const at = archive.indexOf(noise(4096).subarray(0, 32));
    assert.ok(at > 0);
    archive[at + 7] ^= 1;
    assert.throws(() => readZip(archive), /zip: .*noise\.bin.*CRC/);
  });

  it('catches one changed byte of a DEFLATED file', () => {
    const archive = createZip(files());
    const headers = rawHeaders(archive);
    // The first data byte of the README: its local header, then its name.
    const readme = Buffer.from('snug/README.md');
    const at = archive.indexOf(readme) + readme.length;
    assert.equal(headers.find((header) => header.name === 'snug/README.md').central.method, 8);
    archive[at + 3] ^= 0x40;
    assert.throws(() => readZip(archive), /zip: .*README\.md/);
  });

  it('catches an archive cut short, and one with bytes after its end', () => {
    const archive = createZip(files());
    assert.throws(() => readZip(archive.subarray(0, archive.length - 1)), /zip: /);
    assert.throws(() => readZip(archive.subarray(0, 10)), /zip: no end record/);
    assert.throws(() => readZip(Buffer.concat([archive, Buffer.from('x')])), /zip: /);
  });

  it('does not take 22 bytes of nothing for an empty archive', () => {
    // All-zero fields are self-consistent (no entries, a directory of no bytes at offset 0):
    // only the signature says whether this is an archive at all.
    assert.throws(() => readZip(Buffer.alloc(22)), /zip: no end record/);
    assert.deepEqual(readZip(createZip([])), []);
  });

  it('catches a central directory that names a file the local header does not', () => {
    const archive = createZip(files());
    const first = archive.indexOf(Buffer.from('snug/empty')); // the local header's copy comes first
    archive.write('snug/EMPTY', first, 'utf8');
    assert.throws(() => readZip(archive), /zip: .*snug\/empty.*disagree/);
  });

  /** Where an entry's central header and local header start, found by the raw walk's own arithmetic. */
  const headersOf = (archive, name) => {
    const end = archive.length - 22;
    let at = archive.readUInt32LE(end + 16);
    for (;;) {
      const nameLength = archive.readUInt16LE(at + 28);
      if (archive.toString('utf8', at + 46, at + 46 + nameLength) === name) return { central: at, local: archive.readUInt32LE(at + 42) };
      at += 46 + nameLength;
    }
  };
  const NOISE = 'snug/skills/snug/assets/noise.bin';

  it('catches a recorded size the bytes do not have — in BOTH headers, so only the length can tell', () => {
    const archive = createZip(files());
    const { central, local } = headersOf(archive, NOISE);
    archive.writeUInt32LE(4097, central + 24);
    archive.writeUInt32LE(4097, local + 22);
    assert.throws(() => readZip(archive), /zip: .*noise\.bin: 4096 bytes came out, and the directory says 4097/);
  });

  it('catches a compression method this module does not write, by its number', () => {
    const archive = createZip(files());
    const { central, local } = headersOf(archive, NOISE);
    archive.writeUInt16LE(12, central + 10);
    archive.writeUInt16LE(12, local + 8);
    assert.throws(() => readZip(archive), /zip: .*noise\.bin: compression method 12/);
  });

  it('catches a directory entry that points somewhere a local header is not', () => {
    const archive = createZip(files());
    const { central } = headersOf(archive, NOISE);
    archive.writeUInt32LE(archive.readUInt32LE(central + 42) + 1, central + 42);
    assert.throws(() => readZip(archive), /zip: .*noise\.bin: no local header/);
    archive.writeUInt32LE(0xfffffff0, central + 42);
    assert.throws(() => readZip(archive), /zip: .*noise\.bin: no local header/);
  });

  it('catches an end record that miscounts the directory, or mis-sizes it', () => {
    const end = (archive) => archive.length - 22;
    const fewer = createZip(files());
    fewer.writeUInt16LE(fewer.readUInt16LE(end(fewer) + 10) - 1, end(fewer) + 10);
    assert.throws(() => readZip(fewer), /zip: the central directory does not end/);
    const more = createZip(files());
    more.writeUInt16LE(more.readUInt16LE(end(more) + 10) + 1, end(more) + 10);
    assert.throws(() => readZip(more), /zip: entry \d+ of \d+ has no central header/);
    const sized = createZip(files());
    sized.writeUInt32LE(sized.readUInt32LE(end(sized) + 12) - 1, end(sized) + 12);
    assert.throws(() => readZip(sized), /zip: the central directory does not end/);
  });
});

describe('CRC-32', () => {
  const vectors = [
    ['', 0x00000000],
    ['123456789', 0xcbf43926],
    ['The quick brown fox jumps over the lazy dog', 0x414fa339],
  ];

  it('the table gives the standard’s check values', () => {
    for (const [text, expected] of vectors) assert.equal(crc32ByTable(Buffer.from(text)), expected, JSON.stringify(text));
  });

  it('the one the writer uses agrees with the table — whichever of the two this Node gave it', () => {
    // `zlib.crc32` arrived in Node 20.15 / 22.2 and the repo's floor is 20: on an older Node
    // the table IS the implementation, so it must be proven on the Nodes that never run it.
    for (const bytes of [Buffer.alloc(0), Buffer.from('123456789'), noise(100_000), Buffer.from('# Snug\n'.repeat(5000))]) {
      assert.equal(crc32(bytes), crc32ByTable(bytes));
      if (typeof zlib.crc32 === 'function') assert.equal(crc32ByTable(bytes), zlib.crc32(bytes));
    }
  });
});

describe('the system’s own unzip agrees', () => {
  const UNZIP = '/usr/bin/unzip';
  const skip = existsSync(UNZIP) ? false : `${UNZIP} is not on this machine`;

  // ASCII names only: what the plugin ships. (How a given unzip build spells a non-ASCII
  // name on disk is its own business; the UTF-8 flag is asserted above.)
  const shipped = () => files().filter((file) => !/[^\x20-\x7e]/.test(file.name));

  it('`unzip -t` passes the archive', { skip }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-zip-'));
    try {
      const file = path.join(dir, 'snug.zip');
      writeFileSync(file, createZip(shipped()));
      const result = spawnSync(UNZIP, ['-t', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an extracted launcher is still executable — it RUNS — and a plain file is not', { skip }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-zip-'));
    try {
      const file = path.join(dir, 'snug.zip');
      writeFileSync(file, createZip(shipped()));
      const result = spawnSync(UNZIP, ['-q', file, '-d', path.join(dir, 'out')], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const launcher = path.join(dir, 'out', 'snug/scripts/snug');
      assert.equal(statSync(launcher).mode & 0o777, 0o755);
      assert.equal(spawnSync(launcher, [], { encoding: 'utf8', env: {} }).stdout, 'launched\n');
      assert.equal(statSync(path.join(dir, 'out', 'snug/README.md')).mode & 0o111, 0);
      for (const entry of shipped()) assert.deepEqual(readFileSync(path.join(dir, 'out', entry.name)), entry.data, entry.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
