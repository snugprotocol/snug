// appIcon — TASK-20260813 AC3: the desktop app icon must fill its canvas.
//
// The bug this locks: every committed icon was a scaled copy of ONE hand-made,
// mis-composed 1024x1024 source in which the opaque plate covered only about the
// top-left 60% of the canvas, with the ember mark inset within THAT — so the mark
// occupied roughly a quarter of the tile and macOS/Windows rendered a small dark
// square shoved into the upper-left with empty space to its right and below.
//
// Why pixels and not a snapshot: an icon is a binary asset no component test can
// reach, and the defect is purely spatial — a hash comparison would say "changed"
// without saying "correct", and would need updating every time the mark is retouched.
// Asserting the COMPOSITION (corners opaque, artwork centred) states the actual
// requirement, so a future regeneration from a bad source fails here rather than
// shipping. This is the "assert the outcome, not a proxy" rule from docs/lessons.md.
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
function decodePng(file: string): Decoded {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString('hex'), `${file} is not a PNG`).toBe('89504e470d0a1a0a');

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

  expect(bitDepth, `${file} must be 8-bit`).toBe(8);
  expect(interlace, `${file} must not be interlaced`).toBe(0);
  // 6 = truecolour+alpha, 2 = truecolour. Both are decodable here.
  expect([2, 6], `${file} must be truecolour`).toContain(colorType);

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
          throw new Error(`${file}: unknown PNG filter ${filter}`);
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

const alphaAt = ({ width, pixels }: Decoded, x: number, y: number): number =>
  pixels[(y * width + x) * 4 + 3];

/** The PNGs listed in tauri.conf.json's bundle.icon array, plus the 1024 master. */
const PNGS = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png'] as const;

describe('desktop app icon composition (TASK-20260813 AC3)', () => {
  it.each(PNGS)('%s is square', (name) => {
    const img = decodePng(resolve(iconDir, name));
    expect(img.width).toBe(img.height);
  });

  it.each(PNGS)('%s fills its canvas — all four corners are opaque', (name) => {
    const img = decodePng(resolve(iconDir, name));
    const { width: w, height: h } = img;
    // THE defect, stated directly: the old artwork left the right column and bottom
    // band fully transparent, so the bottom-right corner had alpha 0. A full-bleed
    // plate makes every corner opaque.
    const corners: Array<[string, number, number]> = [
      ['top-left', 0, 0],
      ['top-right', w - 1, 0],
      ['bottom-left', 0, h - 1],
      ['bottom-right', w - 1, h - 1],
    ];
    for (const [label, x, y] of corners) {
      expect(alphaAt(img, x, y), `${name}: ${label} corner is transparent`).toBeGreaterThan(0);
    }
  });

  it.each(PNGS)('%s carries its artwork across the whole canvas, not one quadrant', (name) => {
    const img = decodePng(resolve(iconDir, name));
    const { width: w, height: h } = img;
    // The old source put every opaque pixel inside the top-left ~60%. Sampling the
    // far edges catches that without pinning the exact art: a centred, full-bleed
    // composition is opaque at the midpoint of all four edges.
    const edges: Array<[string, number, number]> = [
      ['right edge', w - 1, Math.floor(h / 2)],
      ['bottom edge', Math.floor(w / 2), h - 1],
      ['left edge', 0, Math.floor(h / 2)],
      ['top edge', Math.floor(w / 2), 0],
    ];
    for (const [label, x, y] of edges) {
      expect(alphaAt(img, x, y), `${name}: ${label} is transparent`).toBeGreaterThan(0);
    }
  });

  it('the ember mark is centred, not anchored to a corner', () => {
    // Measured on the master. The mark is the only ember-coloured region; its bounding
    // box must sit symmetrically in the canvas. The old art failed this badly — its
    // mark spanned roughly x 115..500 of 1024, i.e. entirely left of centre.
    const img = decodePng(resolve(iconDir, 'icon.png'));
    const { width: w, height: h, pixels } = img;
    const isEmber = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
      // The ember is a warm orange; the plate is near-black. Red clearly dominant
      // and a bright-ish pixel is the mark.
      return a > 128 && r > 150 && r > b + 60 && g > 60;
    };

    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (isEmber(x, y)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    expect(maxX, 'no ember-coloured mark found in icon.png').toBeGreaterThan(-1);

    // Symmetry: the gap left of the mark matches the gap right of it, within a few
    // percent of the canvas. Same vertically.
    const leftGap = minX;
    const rightGap = w - 1 - maxX;
    const topGap = minY;
    const bottomGap = h - 1 - maxY;
    const tolerance = w * 0.03;
    expect(Math.abs(leftGap - rightGap), `mark is off-centre horizontally (${leftGap} vs ${rightGap})`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(topGap - bottomGap), `mark is off-centre vertically (${topGap} vs ${bottomGap})`).toBeLessThanOrEqual(tolerance);

    // And it must be substantial — a centred speck would pass the symmetry check.
    expect((maxX - minX) / w, 'the mark is too small for the tile').toBeGreaterThan(0.5);
  });

  it.each(PNGS)('%s — the logo IS the icon: the mark reaches every edge', (name) => {
    // OWNER REPORT 2026-08-13: "the logo should cover it completely". The first fix
    // centred the mark on a dark plate at 61% of the tile (copying apple-touch-icon.svg,
    // where the plate is load-bearing because iOS squares off transparency). On a
    // desktop dock that reads as a small logo adrift in a dark square.
    //
    // THIS IS THE ASSERTION THE CENTRING TEST ABOVE COULD NOT MAKE: symmetry is
    // satisfied by ANY concentric mark, so it passed on the 61% art and on the
    // full-bleed art alike. Measuring how far the EMBER reaches is what separates them.
    const img = decodePng(resolve(iconDir, name));
    const { width: w, height: h, pixels } = img;
    const isEmber = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
      return a > 128 && r > 150 && r > b + 60 && g > 60;
    };

    // The tile is a ROUNDED square, so its corners are legitimately not ember — but the
    // midpoint of each edge must be, or the mark is not reaching the canvas bounds.
    const mid = (n: number): number => Math.floor(n / 2);
    const edges: Array<[string, number, number]> = [
      ['top', mid(w), 0],
      ['bottom', mid(w), h - 1],
      ['left', 0, mid(h)],
      ['right', w - 1, mid(h)],
    ];
    for (const [label, x, y] of edges) {
      expect(isEmber(x, y), `${name}: the mark does not reach the ${label} edge`).toBe(true);
    }

    // Belt and braces: the ember must span essentially the whole width, not 61% of it.
    let minX = w;
    let maxX = -1;
    const row = mid(h);
    for (let x = 0; x < w; x += 1) {
      if (isEmber(x, row)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    expect((maxX - minX + 1) / w, `${name}: the mark covers too little of the tile`).toBeGreaterThan(0.95);
  });
});
