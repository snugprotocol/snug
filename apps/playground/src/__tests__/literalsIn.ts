// literalsIn.ts — the ONE TypeScript-compiler walker the two vocabulary scans share
// (TASK-20261010-host-broker PR-4, D-PR4-21). Not a test file (no `.test.` in the name).
//
// `accessCopy.test.ts` introduced it (PR-3); `scheduleCopy.test.ts` moved onto it from its regex
// scan, so a JSX text node (`<p>a task</p>`) — which the regex could not see — is a sentence to
// both. What it reports, by the parser (never a regex): string literals (JSX attribute strings
// included), template literals (nested ones too) and JSX text nodes; comments are trivia and never
// seen; a module specifier (`'./grants.js'`) is a file name, not a sentence.

import ts from 'typescript';

/** One piece of text a person could read: as it is reported, and the words a rule is applied to. */
export interface Literal {
  /** The literal as reported — a template's source text between its backticks, substitutions included. */
  text: string;
  /** Only what a person reads: a template's LITERAL parts (a `${grant.id}` substitution is code, not copy). */
  words: string;
}

/** A string that names a module — `from './grants.js'`, `import('./x.js')`, `require`-style references — is a file name, not a sentence. */
export function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

/**
 * Every piece of text in a source, by the TypeScript parser (comments are trivia, never seen):
 * string literals (JSX attribute strings included), template literals (nested ones too), and
 * JSX text nodes — module specifiers left out.
 */
export function literalsIn(code: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): Literal[] {
  const source = ts.createSourceFile(kind === ts.ScriptKind.TSX ? 'scan.tsx' : 'scan.ts', code, ts.ScriptTarget.Latest, true, kind);
  const out: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) out.push({ text: node.text, words: node.text });
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      out.push({ text: node.getText(source).slice(1, -1), words: parts.join(' … ') });
    } else if (ts.isJsxText(node)) {
      if (node.text.trim() !== '') out.push({ text: node.text.trim(), words: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The parser's script kind for a file on disk: `.tsx` parses JSX, `.ts` does not (a `<T>` cast is not an element). */
export const scriptKindOf = (file: string): ts.ScriptKind => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
