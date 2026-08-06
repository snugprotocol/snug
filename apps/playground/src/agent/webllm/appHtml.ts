// appHtml.ts — the webllm builder's app "envelope": with tools refused by the engine
// (see webllmAdapter.ts), the builder asks the model to emit the app as one fenced
// single-file HTML document and this module extracts it for the artifact sink. The
// instruction (out) and the extractor (in) live together so they cannot drift apart.
//
// Chosen over a constrained-JSON envelope on purpose: one fenced HTML block is the
// easiest structure a 1–3B model reliably produces; JSON-escaping a whole HTML
// document is precisely where small models break. Blast radius of this path vs the
// tool path is documented in the task file (no KB consult round trip, no
// schema_apply/app_doc_write in webllm mode).

/** Appended to the builder system prompt in webllm mode ONLY (after the base layers). */
export const WEBLLM_BUILD_SUFFIX = `## Building Apps Without Tools (in-browser model)

File-creation tools are not available in this mode. When the user asks you to build
or change an app, reply with the COMPLETE single-file HTML document — starting with
<!doctype html> and ending with </html> — inside ONE \`\`\`html fenced code block:
styles in a <style> block, logic in a <script> block, no separate files, and a
<title> naming the app. The host extracts that block and installs it as the app.
Keep any explanation brief and OUTSIDE the fence. Never send a partial document.`;

export interface ExtractedAppHtml {
  html: string;
  title: string;
}

/** A COMPLETE document only: doctype through closing </html>. Snippets never install. */
const DOCUMENT_PATTERN = /<!doctype html[\s\S]*?<\/html\s*>/gi;

const FENCE_PATTERN = /```(?:html)?\s*\n([\s\S]*?)```/g;

function lastCompleteDocument(text: string): string | undefined {
  const matches = [...text.matchAll(DOCUMENT_PATTERN)];
  return matches[matches.length - 1]?.[0];
}

/**
 * The app document in a builder reply, if any: the LAST complete document among the
 * fenced blocks (a model that revises itself mid-reply means the last one), falling
 * back to a bare unfenced document — small models forget fences. `undefined` for
 * prose and snippets: a reply without a complete document writes no artifact.
 */
export function extractAppHtml(text: string): ExtractedAppHtml | undefined {
  const candidates: string[] = [];
  for (const match of text.matchAll(FENCE_PATTERN)) {
    const doc = lastCompleteDocument(match[1] ?? '');
    if (doc !== undefined) candidates.push(doc);
  }
  if (candidates.length === 0) {
    const bare = lastCompleteDocument(text);
    if (bare !== undefined) candidates.push(bare);
  }
  const html = candidates[candidates.length - 1];
  if (html === undefined) return undefined;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  return { html, title: title !== undefined && title !== '' ? title : 'your app' };
}
