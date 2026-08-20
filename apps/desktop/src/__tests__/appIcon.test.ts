// appIcon — TASK-20260819 (supersedes TASK-20260813 AC3): per-platform icon composition.
//
// The bugs this locks (found 2026-08-19 by pixel-sampling the shipped set):
//   1. The arched niche rendered WHITE, not the dark ground. The generator drew a
//      dark backing path under the evenodd ember path, but the mark's inner subpath
//      winds opposite to its outer square, so nonzero filling knocked the niche out
//      of the backing layer too — the Chromium page background showed through both.
//   2. The screenshot baked that page background in (omitBackground: false), so the
//      canvas corners outside the rounded tile were opaque WHITE.
//   3. The mark was scaled full-bleed with zero margin. macOS does NOT mask or inset
//      app icons — the squircle shape and ~10% transparent margin must be baked into
//      the PNG (Apple grid: 824px artwork centred in a 1024 canvas) — so the dock
//      showed an oversized white-chipped square next to properly-shaped neighbours.
//
// The set is therefore split per platform (owner decision 2026-08-19):
//   mac-facing  (icon.png, icon.icns): transparent margin, Apple-radius squircle
//                filled ember, niche painted the dark ground #171310.
//   win-facing  (32x32.png, 128x128.png, 128x128@2x.png): full-bleed and
//                fully opaque (Windows expects no margin) on a dark plate — corners
//                are the PLATE, never white — with the same dark niche.
//   TASK-20260820: `icon.ico` is no longer shipped at all — ADR-0021 D8 restricted the
//   bundle to macOS targets (`bundleTargets.test.ts` pins that). It was never parsed
//   here anyway (ICO entries may be BMP DIBs; the PNGs stood evidence for it), so its
//   removal costs this suite no assertion. These three PNGs STAY: they come from the
//   win master but are generic sizes tauri reads on every platform.
//
// Why pixels and not a snapshot: an icon is a binary asset no component test can
// reach, and these defects are spatial/chromatic — a hash comparison would say
// "changed" without saying "correct". Asserting the COMPOSITION states the actual
// requirement ("assert the outcome, not a proxy", docs/lessons.md 2026-08-04 — the
// previous revision of this file is the cited failure: white passed every assertion).
//
// PNG decoding is done inline: zlib is in the Node stdlib and the IDAT format is
// small enough to read directly, so this adds no dependency for one assertion.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = resolve(here, '../../src-tauri/icons');

interface Decoded {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer;
}

/**
 * Decode a non-interlaced 8-bit RGBA/RGB PNG.
 *
 * Handles the five PNG filter types, which is the whole of the format that matters
 * here — the icons are plain truecolour-with-alpha, written by one generator.
 */
function decodePngBuffer(buf: Buffer, label: string): Decoded {
  expect(buf.subarray(0, 8).toString('hex'), `${label} is not a PNG`).toBe('89504e470d0a1a0a');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  expect(bitDepth, `${label} must be 8-bit`).toBe(8);
  expect(interlace, `${label} must not be interlaced`).toBe(0);
  // 6 = truecolour+alpha, 2 = truecolour. Both are decodable here.
  expect([2, 6], `${label} must be truecolour`).toContain(colorType);

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prior = Buffer.alloc(stride);

  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    raw.copy(line, 0, pos, pos + stride);
    pos += stride;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prior[i];
      const c = i >= channels ? prior[i - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[i] = (line[i] + a) & 0xff;
          break;
        case 2:
          line[i] = (line[i] + b) & 0xff;
          break;
        case 3:
          line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`${label}: unknown PNG filter ${filter}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    line.copy(prior);
  }

  return { width, height, pixels: out };
}

const decodePng = (file: string): Decoded => decodePngBuffer(readFileSync(file), file);

/**
 * Pull the largest embedded PNG out of icon.icns. The icns container is a flat run
 * of [4-byte type][4-byte big-endian length] chunks; modern sizes (ic07..ic13) carry
 * whole PNG files as their payload, so finding the PNG magic is all the parsing the
 * assertion needs.
 */
function largestIcnsPng(file: string): Decoded {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 4).toString('ascii'), `${file} is not an icns`).toBe('icns');
  const PNG_MAGIC = '89504e470d0a1a0a';
  let best: Decoded | null = null;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset + 4);
    const payload = buf.subarray(offset + 8, offset + length);
    if (payload.subarray(0, 8).toString('hex') === PNG_MAGIC) {
      const decoded = decodePngBuffer(payload, `${file} entry @${offset}`);
      if (!best || decoded.width > best.width) best = decoded;
    }
    offset += length;
  }
  expect(best, `${file} contains no PNG entries`).not.toBeNull();
  return best as Decoded;
}

const EMBER = { r: 232, g: 135, b: 58 }; // #e8873a
const NICHE = { r: 23, g: 19, b: 16 }; // #171310 — the dark-theme ground

const rgbaAt = ({ width, pixels }: Decoded, x: number, y: number): [number, number, number, number] => {
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
};

const alphaAt = (img: Decoded, x: number, y: number): number => rgbaAt(img, x, y)[3];

/** Warm-orange heuristic: red clearly dominant on a bright-ish opaque pixel. */
const isEmber = (img: Decoded, x: number, y: number): boolean => {
  const [r, g, b, a] = rgbaAt(img, x, y);
  return a > 128 && r > 150 && r > b + 60 && g > 60;
};

/** The dark ground, exactly (± antialias slack), and OPAQUE — never white, never a hole. */
const isNiche = (img: Decoded, x: number, y: number): boolean => {
  const [r, g, b, a] = rgbaAt(img, x, y);
  const tol = 10;
  return (
    a === 255 &&
    Math.abs(r - NICHE.r) <= tol &&
    Math.abs(g - NICHE.g) <= tol &&
    Math.abs(b - NICHE.b) <= tol
  );
};

// The mark's geometry in its 32-unit viewBox: the tile spans units 2..30; the arched
// niche spans x 11..21, y 11..23. Interior sample points, safely off every edge:
const NICHE_SAMPLES: Array<[string, number, number]> = [
  ['niche centre', 16, 17],
  ['mid-arch', 16, 13],
];
const TILE_INSET = 2;
const TILE_SPAN = 28;

// Apple icon grid: artwork occupies 824/1024 of the canvas, margin 100/1024 per side.
const MAC_MARGIN_FRACTION = 100 / 1024;

/** Map a mark-space unit to a pixel for a FULL-BLEED (win) canvas. */
const winPx = (img: Decoded, u: number): number =>
  Math.round(((u - TILE_INSET) / TILE_SPAN) * img.width);

/** Map a mark-space unit to a pixel for a MARGINED (mac) canvas. */
const macPx = (img: Decoded, u: number): number => {
  const margin = Math.round(img.width * MAC_MARGIN_FRACTION);
  const artSpan = img.width - margin * 2;
  return Math.round(margin + ((u - TILE_INSET) / TILE_SPAN) * artSpan);
};

const WIN_PNGS = ['32x32.png', '128x128.png', '128x128@2x.png'] as const;

const macImages = (): Array<[string, Decoded]> => [
  ['icon.png', decodePng(resolve(iconDir, 'icon.png'))],
  ['icon.icns (largest entry)', largestIcnsPng(resolve(iconDir, 'icon.icns'))],
];

describe('desktop app icon composition (TASK-20260819)', () => {
  it.each([...WIN_PNGS, 'icon.png'] as const)('%s is square', (name) => {
    const img = decodePng(resolve(iconDir, name));
    expect(img.width).toBe(img.height);
  });

  describe('mac-facing files: Apple-grid squircle on a transparent canvas', () => {
    it('corners and the margin band are fully transparent', () => {
      // macOS composites the PNG as-is: anything opaque outside the squircle renders
      // as chips on the dock. The previous set had opaque WHITE corners (the baked-in
      // Chromium page background) and no margin at all.
      for (const [label, img] of macImages()) {
        const { width: w, height: h } = img;
        const margin = Math.round(w * MAC_MARGIN_FRACTION);
        const probes: Array<[string, number, number]> = [
          ['top-left corner', 0, 0],
          ['top-right corner', w - 1, 0],
          ['bottom-left corner', 0, h - 1],
          ['bottom-right corner', w - 1, h - 1],
          ['left margin band', Math.floor(margin / 2), Math.floor(h / 2)],
          ['right margin band', w - 1 - Math.floor(margin / 2), Math.floor(h / 2)],
          ['top margin band', Math.floor(w / 2), Math.floor(margin / 2)],
          ['bottom margin band', Math.floor(w / 2), h - 1 - Math.floor(margin / 2)],
        ];
        for (const [where, x, y] of probes) {
          expect(alphaAt(img, x, y), `${label}: ${where} is not transparent`).toBe(0);
        }
      }
    });

    it('ember fills the squircle to its edges, and the artwork sits on the 824/1024 grid', () => {
      for (const [label, img] of macImages()) {
        const { width: w, height: h } = img;
        const margin = Math.round(w * MAC_MARGIN_FRACTION);
        const inside = Math.max(2, Math.round(w * 0.01)); // just inside the artwork edge
        const mid = Math.floor(h / 2);
        const edgeProbes: Array<[string, number, number]> = [
          ['left squircle edge', margin + inside, mid],
          ['right squircle edge', w - 1 - margin - inside, mid],
          ['top squircle edge', Math.floor(w / 2), margin + inside],
          ['bottom squircle edge', Math.floor(w / 2), h - 1 - margin - inside],
        ];
        for (const [where, x, y] of edgeProbes) {
          expect(isEmber(img, x, y), `${label}: no ember at the ${where}`).toBe(true);
        }

        // The opaque artwork must START at the margin (both sides): centred and
        // grid-sized, not full-bleed and not adrift.
        let minX = w;
        let maxX = -1;
        for (let x = 0; x < w; x += 1) {
          if (alphaAt(img, x, mid) > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
        const tolerance = Math.max(3, w * 0.015);
        expect(Math.abs(minX - margin), `${label}: artwork left edge off-grid (${minX} vs ${margin})`).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(w - 1 - maxX - margin), `${label}: artwork right edge off-grid`).toBeLessThanOrEqual(tolerance);
      }
    });

    it('the niche is the dark ground — not white, not a hole', () => {
      // THE 2026-08-19 owner report: the icon centre rendered white. The niche must
      // read as the same dark ground the web logo's knockout shows (#171310).
      for (const [label, img] of macImages()) {
        for (const [where, ux, uy] of NICHE_SAMPLES) {
          const x = macPx(img, ux);
          const y = macPx(img, uy);
          const [r, g, b, a] = rgbaAt(img, x, y);
          expect(
            isNiche(img, x, y),
            `${label}: ${where} at (${x},${y}) is rgba(${r},${g},${b},${a}) — expected opaque #171310`,
          ).toBe(true);
        }
      }
    });
  });

  describe('win-facing files: full-bleed, fully opaque, dark plate — never white', () => {
    it.each(WIN_PNGS)('%s corners are opaque PLATE pixels', (name) => {
      // Windows expects no margin, so full-bleed stays — but the corner pixels outside
      // the tile's rounded corners must be the dark plate, not baked-in page white.
      const img = decodePng(resolve(iconDir, name));
      const { width: w, height: h } = img;
      const corners: Array<[string, number, number]> = [
        ['top-left', 0, 0],
        ['top-right', w - 1, 0],
        ['bottom-left', 0, h - 1],
        ['bottom-right', w - 1, h - 1],
      ];
      for (const [where, x, y] of corners) {
        const [r, g, b, a] = rgbaAt(img, x, y);
        expect(a, `${name}: ${where} corner is transparent`).toBe(255);
        expect(
          isNiche(img, x, y),
          `${name}: ${where} corner is rgba(${r},${g},${b},${a}) — expected the dark plate #171310`,
        ).toBe(true);
      }
    });

    it.each(WIN_PNGS)('%s — the mark reaches every edge and spans the tile', (name) => {
      const img = decodePng(resolve(iconDir, name));
      const { width: w, height: h } = img;
      const mid = (n: number): number => Math.floor(n / 2);
      const edges: Array<[string, number, number]> = [
        ['top', mid(w), 0],
        ['bottom', mid(w), h - 1],
        ['left', 0, mid(h)],
        ['right', w - 1, mid(h)],
      ];
      for (const [where, x, y] of edges) {
        expect(isEmber(img, x, y), `${name}: the mark does not reach the ${where} edge`).toBe(true);
      }

      let minX = w;
      let maxX = -1;
      const row = mid(h);
      for (let x = 0; x < w; x += 1) {
        if (isEmber(img, x, row)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      expect((maxX - minX + 1) / w, `${name}: the mark covers too little of the tile`).toBeGreaterThan(0.95);
    });

    it.each(WIN_PNGS)('%s niche is the dark ground — not white, not a hole', (name) => {
      const img = decodePng(resolve(iconDir, name));
      for (const [where, ux, uy] of NICHE_SAMPLES) {
        const x = winPx(img, ux);
        const y = winPx(img, uy);
        const [r, g, b, a] = rgbaAt(img, x, y);
        expect(
          isNiche(img, x, y),
          `${name}: ${where} at (${x},${y}) is rgba(${r},${g},${b},${a}) — expected opaque #171310`,
        ).toBe(true);
      }
    });
  });
});
