// search.ts — keyword section search over the rendered knowledge base.
//
// Ancestor pattern, ported: split each KB document on ##/### headings (which is why
// heading structure is retrieval-load-bearing), tokenize the query, score sections by
// keyword presence (heading hits weighted), return the top sections; when nothing
// matches, fall back to the full documents so the caller never gets an empty answer.

import { getKnowledgeBase } from './layers.js';
import { splitSections } from './markdown.js';

export interface KnowledgeSearchResult {
  /** KB file the section came from (posix path relative to prompts/). */
  file: string;
  /** Section heading text; '' for a file preamble or a full-document fallback result. */
  heading: string;
  /** Rendered section text (or full document text on fallback). */
  text: string;
  /** Keyword score; 0 on full-document fallback. */
  score: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'use', 'using', 'what', 'when', 'where', 'with',
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  return matches.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const HEADING_WEIGHT = 2;
const DEFAULT_LIMIT = 5;

/**
 * Search the rendered KB. Returns up to `limit` best-scoring sections (document order
 * breaks ties); when no section scores above zero, returns every KB document in full
 * with score 0 (full-document fallback).
 */
export function searchKnowledge(query: string, options?: { limit?: number }): KnowledgeSearchResult[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const queryTokens = [...new Set(tokenize(query))];
  const kb = getKnowledgeBase();

  const scored: KnowledgeSearchResult[] = [];
  for (const doc of kb) {
    for (const section of splitSections(doc.text)) {
      const bodyTokens = new Set(tokenize(section.text));
      const headingTokens = new Set(tokenize(section.heading));
      let score = 0;
      for (const token of queryTokens) {
        if (bodyTokens.has(token)) score += 1;
        if (headingTokens.has(token)) score += HEADING_WEIGHT;
      }
      if (score > 0) {
        scored.push({ file: doc.file, heading: section.heading, text: section.text, score });
      }
    }
  }

  if (scored.length === 0) {
    return kb.map((doc) => ({ file: doc.file, heading: '', text: doc.text, score: 0 }));
  }
  scored.sort((a, b) => b.score - a.score); // stable: ties keep document order
  return scored.slice(0, limit);
}
