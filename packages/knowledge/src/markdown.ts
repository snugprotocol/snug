// markdown.ts — internal markdown utilities shared by layers.ts and search.ts.
// Fence-aware: headings inside ``` / ~~~ code fences are never treated as structure
// (the KB embeds copy-exactly code samples). Not part of the public API.

/**
 * Strip the mandatory prompt-store header comment (`<!-- layer: ... -->`) from the top
 * of a prompt source. The header is store metadata (ADR-0004) — it never reaches an LLM.
 */
export function stripPromptHeader(text: string): string {
  if (!text.startsWith('<!--')) return text;
  const end = text.indexOf('-->');
  if (end === -1) return text;
  return text.slice(end + '-->'.length).replace(/^\r?\n+/, '');
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Heading lines (levels 1–3, e.g. `## Frames`) in document order, code fences skipped. */
export function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,3}\s+\S/.test(line)) headings.push(line.trim());
  }
  return headings;
}

export interface MarkdownSection {
  /** Heading text without the leading hashes; '' for preamble before the first heading. */
  heading: string;
  /** Section text including its heading line. */
  text: string;
}

/**
 * Split a document into sections at `##` / `###` headings (the retrieval-load-bearing
 * levels per ADR-0004). Content before the first such heading becomes a preamble section.
 */
export function splitSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading = '';
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text.length > 0) sections.push({ heading, text });
  };

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(##|###)\s+(\S.*)$/.exec(line);
    if (match) {
      flush();
      heading = (match[2] as string).trim();
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}
