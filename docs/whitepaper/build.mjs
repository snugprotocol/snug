#!/usr/bin/env node
// build.mjs — render the Snug Protocol whitepaper to PDF
// (TASK-20260807-protocol-whitepaper).
//
// Pipeline: paper.html + figures/*.svg → a single self-contained HTML document → headless
// Chrome print-to-PDF → dist/snug-protocol-whitepaper.pdf, with the /Info dictionary
// rewritten so the embedded Title and Author are correct (AC2).
//
// Hermetic by design: no network fetch, no npm dependency, system fonts only. The only
// external requirement is a Chrome/Chromium binary, resolved from CHROME_PATH or the
// standard install locations.
//
// Why Chrome rather than pandoc/LaTeX: no TeX engine is installed on the target machine,
// and Chrome's print pipeline gives us CSS Paged Media (@page margin boxes for running
// heads and folios) plus full-fidelity inline SVG, with the source staying diffable so
// scripts/check-whitepaper.mjs can grep it.
//
//   node docs/whitepaper/build.mjs [--keep-html]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const DIST = join(HERE, 'dist');
const OUT_PDF = join(DIST, 'snug-protocol-whitepaper.pdf');

const TITLE = 'The Snug Protocol: An Open Protocol for Agent-Backed Personal Software';
const AUTHOR = 'Jeetu Maker';
const SUBJECT = 'Specification of the wire protocol, security model, and portable data format for agent-backed personal software.';

// ------------------------------------------------------------------ chrome

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  console.error('FATAL: no Chrome/Chromium binary found. Set CHROME_PATH to one.');
  console.error('Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
  process.exit(2);
}

// ------------------------------------------------------------------ assemble

/**
 * Inline every `<!--FIGURE:name|label|caption-->` marker as a real <figure> carrying the
 * SVG body. Inlining (rather than <img src>) is what makes the print job self-contained:
 * Chrome renders the vector directly, with no asset load that could race the print.
 */
function inlineFigures(html) {
  return html.replace(/<!--FIGURE:([a-z0-9-]+)\|([^|]*)\|([\s\S]*?)-->/g, (_m, name, _label, caption) => {
    const p = join(SRC, 'figures', `${name}.svg`);
    if (!existsSync(p)) {
      console.error(`FATAL: figure not found: ${p}`);
      process.exit(2);
    }
    // Strip the XML prolog if present; keep the <svg> element itself.
    const svg = readFileSync(p, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '').trim();
    return `<figure>\n${svg}\n<figcaption>${caption.trim()}</figcaption>\n</figure>`;
  });
}

/** Inline the stylesheet so the rendered document has zero external references. */
function inlineCss(html) {
  const css = readFileSync(join(SRC, 'paper.css'), 'utf8');
  return html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`);
}

function assemble() {
  let html = readFileSync(join(SRC, 'paper.html'), 'utf8');
  html = inlineFigures(html);
  html = inlineCss(html);

  const unresolved = html.match(/<!--FIGURE:[^>]*-->/g);
  if (unresolved) {
    console.error(`FATAL: unresolved figure markers: ${unresolved.join(', ')}`);
    process.exit(2);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="author" content="${AUTHOR}">
<meta name="description" content="${SUBJECT}">
</head>
<body>
${html}
</body>
</html>`;
}

// ------------------------------------------------------------------ pdf metadata

/**
 * Chrome writes /Title from the <title> tag but leaves /Author empty, so we rewrite the
 * document information dictionary ourselves.
 *
 * Approach: append a NEW Info object plus an incremental-update trailer that points at
 * it. This is the format's own append-only update mechanism — the original bytes are
 * untouched, and readers resolve the last trailer, so /Author and /Title come from ours.
 * Doing it this way avoids rewriting the xref table of the existing document.
 */
function setPdfMetadata(buf) {
  const latin1 = buf.toString('latin1');

  // Highest existing object number, so our new object cannot collide.
  let maxObj = 0;
  for (const m of latin1.matchAll(/(\d+)\s+\d+\s+obj\b/g)) maxObj = Math.max(maxObj, Number(m[1]));
  const infoNum = maxObj + 1;

  // Root catalog + previous startxref are needed for a valid update trailer.
  const rootMatch = latin1.match(/\/Root\s+(\d+)\s+(\d+)\s+R/);
  if (!rootMatch) {
    console.error('WARN: could not locate /Root; leaving PDF metadata as Chrome wrote it.');
    return buf;
  }
  const prevStartxref = [...latin1.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!prevStartxref) {
    console.error('WARN: could not locate startxref; leaving PDF metadata as Chrome wrote it.');
    return buf;
  }

  // UTF-16BE with BOM handles any non-ASCII in title/author safely.
  const pdfString = (s) => {
    const u16 = Buffer.from(`﻿${s}`, 'utf16le').swap16();
    return `<${u16.toString('hex').toUpperCase()}>`;
  };

  const infoBody =
    `${infoNum} 0 obj\n` +
    `<< /Title ${pdfString(TITLE)}` +
    ` /Author ${pdfString(AUTHOR)}` +
    ` /Subject ${pdfString(SUBJECT)}` +
    ` /Creator ${pdfString('Snug Protocol — docs/whitepaper/build.mjs')}` +
    ` /Producer ${pdfString('Chrome print-to-PDF')} >>\n` +
    `endobj\n`;

  const base = Buffer.concat([buf, Buffer.from(buf.at(-1) === 0x0a ? '' : '\n', 'latin1')]);
  const infoOffset = base.length;
  const withInfo = Buffer.concat([base, Buffer.from(infoBody, 'latin1')]);

  const xrefOffset = withInfo.length;
  const pad = (n) => String(n).padStart(10, '0');
  const trailer =
    `xref\n` +
    `0 1\n` +
    `0000000000 65535 f \n` +
    `${infoNum} 1\n` +
    `${pad(infoOffset)} 00000 n \n` +
    `trailer\n` +
    `<< /Size ${infoNum + 1}` +
    ` /Root ${rootMatch[1]} ${rootMatch[2]} R` +
    ` /Info ${infoNum} 0 R` +
    ` /Prev ${prevStartxref[1]} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([withInfo, Buffer.from(trailer, 'latin1')]);
}

// ------------------------------------------------------------------ run

function main() {
  const keepHtml = process.argv.includes('--keep-html');
  const chrome = findChrome();

  mkdirSync(DIST, { recursive: true });
  const figures = readdirSync(join(SRC, 'figures')).filter((f) => f.endsWith('.svg'));

  const html = assemble();
  const tmpHtml = join(DIST, 'paper.build.html');
  writeFileSync(tmpHtml, html, 'utf8');

  // A throwaway profile keeps the build independent of the developer's own Chrome state.
  const profile = join(DIST, '.chrome-profile');
  rmSync(OUT_PDF, { force: true }); // so a stale PDF can never be mistaken for a fresh one
  let chromeErr = null;
  try {
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-pdf-header-footer',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=12000',
        '--disable-component-update',
        '--disable-background-networking',
        `--user-data-dir=${profile}`,
        `--print-to-pdf=${OUT_PDF}`,
        `file://${tmpHtml}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 },
    );
  } catch (err) {
    // Chrome's bundled updater can exit non-zero (and chatter on stderr) even when the
    // print itself succeeded, so the written PDF — not the exit status — is the verdict.
    chromeErr = err;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    if (!keepHtml) rmSync(tmpHtml, { force: true });
  }

  if (!existsSync(OUT_PDF)) {
    console.error('FATAL: Chrome did not write a PDF.');
    console.error(chromeErr?.stderr?.toString?.() ?? chromeErr?.message ?? '(no error output)');
    process.exit(2);
  }

  writeFileSync(OUT_PDF, setPdfMetadata(readFileSync(OUT_PDF)));

  const kb = Math.round(readFileSync(OUT_PDF).length / 1024);
  console.log(`✓ ${OUT_PDF}`);
  console.log(`  ${kb} KB · ${figures.length} figures inlined · author: ${AUTHOR}`);
  console.log(`  verify: node scripts/check-whitepaper.mjs`);
}

main();
