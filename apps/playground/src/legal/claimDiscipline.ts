// claimDiscipline.ts — the whitepaper's AC6 claim-discipline rules, portable
// (TASK-20260823-legal-terms-privacy-eula AC3; mirrors scripts/check-whitepaper.mjs).
//
// ADR-0014 §5 and threat-model §7 bound what may be CLAIMED about custody and
// encryption. The whitepaper checker enforces that at the website; the legal documents
// are read by the same stranger and must keep the same discipline — a privacy statement
// that says "zero-knowledge" is a false claim with a signature on it. The rules are
// restated here rather than imported because the checker is a node script over HTML and
// this runs over plain data in three places (playground test, desktop test over the
// EULA, and — through the same module — anything else that publishes legal prose).
//
// Returns the violations rather than throwing, so a test can assert the list is empty
// AND assert the checker catches a planted violation (a checker nothing can trip is
// decoration, lessons 2026-08-20).

/** Terms that may appear ONLY in negation ("not zero-knowledge"). */
const NEGATION_ONLY: Array<{ re: RegExp; label: string }> = [
  { re: /zero[-\s]knowledge/gi, label: 'zero-knowledge' },
  { re: /end-to-end encrypt\w*/gi, label: 'end-to-end encryption' },
  // ADR-0014 §5: the absolute custody claim is never made — a personal sync origin the
  // user connects legitimately carries the keys.
  { re: /never leaves? your (file|device|machine)/gi, label: 'keys-never-leave' },
];

/** Framings that may not appear at all. */
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /encrypted on our servers/i, why: 'there are no servers of ours holding anything (ADR-0013/0014)' },
  { re: /we protect your data/i, why: 'custody is the user\'s; we hold nothing to protect' },
  { re: /military[-\s]grade/i, why: 'unsupportable security claim' },
  { re: /fully (private|secure|anonymous)/i, why: 'absolute claim the threat model does not support (§7)' },
];

export function findClaimViolations(text: string): string[] {
  const violations: string[] = [];

  for (const t of NEGATION_ONLY) {
    for (const m of text.matchAll(t.re)) {
      const index = m.index ?? 0;
      const before = text.slice(Math.max(0, index - 60), index);
      if (!/\b(not|never|no|nor|neither|isn't|aren't)\b[^.]*$/i.test(before)) {
        violations.push(`${t.label} asserted: "…${text.slice(Math.max(0, index - 40), index + m[0].length + 10).trim()}…"`);
      }
    }
  }

  // "host-blind" may be named only to disclaim it (ADR-0003/0014).
  const asserted = /(?:is|are|we are|it['’]s|fully|truly|provides?|guarantees?|offers?)\s+(?:a\s+)?host-blind/i;
  const negated = /(?:no|never|not|without)\b[^.]{0,60}host-blind/i;
  for (const m of text.matchAll(/[^.]*host-blind[^.]*\./gi)) {
    const sentence = m[0].trim();
    if (asserted.test(sentence) && !negated.test(sentence)) violations.push(`host-blind asserted: "${sentence}"`);
  }

  for (const f of FORBIDDEN) {
    if (f.re.test(text)) violations.push(`forbidden framing ${f.re.source}: ${f.why}`);
  }

  // ADR-0043: an encryption claim is bounded wherever it is made.
  if (/passphrase/i.test(text) && !(/only (the user|they|you) holds?/i.test(text) && /unrecoverable/i.test(text))) {
    violations.push('passphrase protection mentioned without the ADR-0043 bound ("only you hold" + "unrecoverable")');
  }

  // ADR-0040: the pseudonymisation class statement travels with the feature.
  if (/pseudonymi[sz]/i.test(text) && !(/anti-default/i.test(text) && /not anti-adversarial/i.test(text))) {
    violations.push('pseudonymisation mentioned without the ADR-0040 class statement ("anti-default … not anti-adversarial")');
  }

  return violations;
}
