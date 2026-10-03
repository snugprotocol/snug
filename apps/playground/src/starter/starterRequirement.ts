// starterRequirement.ts — one starter's `connection.json`, parsed for FIRST PAINT
// (TASK-20261003 S2, ADR-0072 §4).
//
// The shelf decides at its first render whether each starter can run on this host
// (`platform/availability.ts`), so both starter sources — the glob on web and desktop, the
// baked index in the host kit — answer `requirement(folder)` SYNCHRONOUSLY. They share this
// one parse because the kit replaces `starterSource.ts` wholesale (a build-time alias of the
// resolved module), so nothing in that file can be imported by its replacement.
//
// SCHEMA ONLY, deliberately not `starterDeclaration.ts`'s admission pass. Admission is where
// a declaration earns a review (registry substitution, the borrow ban), and it runs where the
// two-fact vouch runs: at install, over an app row and the starter's html — neither of which
// exists at first paint. What a tile needs is the shape — kind, LAN class, provider name —
// and `availability.test.ts` pins that the needs derived from this parse equal the needs of
// the admitted row for every shipped starter.
//
// Fails soft, like every reader of a `?raw` manifest: bad JSON or a shape the schema refuses
// is "this starter declares nothing" — never a throw at first paint.

import { connectionRequirementSchema, type ConnectionRequirement } from '@snugprotocol/protocol';

export function parseStarterRequirement(raw: string | undefined): ConnectionRequirement | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = connectionRequirementSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
