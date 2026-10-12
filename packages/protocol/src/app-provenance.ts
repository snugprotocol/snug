/**
 * TASK-20261010-host-broker PR-5 — the imported marker's shape (contract v2 D-PR5-9; R-77).
 * INTERNAL protocol surface: OUT of `json-schemas.ts` SOURCES, like `own-undo.ts`.
 *
 * `appProvenance:<appId>` = `{imported: true, at}` says the app ARRIVED WITH A FILE THE USER
 * IMPORTED — an untrusted import carries `install_source` verbatim, so a file can forge a
 * `starter:`, `agent:` or `share:` origin, and the host's *who made this* reads this marker over
 * every install source. Strict: the literal `true` and an ISO instant, nothing else. The storage
 * and the fail-closed read live in `@snugprotocol/db` (`userdb/app-provenance.ts`); the schema
 * lives here because every schema the user file stores is zod, and zod is this package's.
 */

import { z } from 'zod';

export const appProvenanceSchema = z.strictObject({
  imported: z.literal(true),
  /** When the import that brought it landed (ISO instant, UTC). */
  at: z.iso.datetime(),
});
export type AppProvenance = z.infer<typeof appProvenanceSchema>;
