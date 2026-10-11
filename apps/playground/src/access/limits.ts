// access/limits.ts — the in-host caps of a materialised read (TASK-20261010-host-broker PR-2;
// ADR-0076 §2; contract v2 D-PR2-6, S7/S-F8). What the chat and scheduler doors may copy of
// another app's data through the Worker: rows and UTF-8 JSON bytes per table, ONE byte budget
// across a whole set in grant order (the crossing table is cut, later tables arrive empty, a
// grant that would start past the budget is skipped), and the Worker's wall clock for one dump.
//
// A LEAF of four numbers and nothing else, so `scopedRead.ts` (the dump's default clock) and
// `materialise.ts` (the budget) read them without reaching the engine. PR-3 moves them to the
// protocol's Appendix B; until then this is their one home.

/** Rows kept per table before the dump is `truncated`. */
export const ACCESS_MATERIALISE_MAX_ROWS = 5_000;
/** UTF-8 JSON bytes kept per table before the dump is `truncated`. */
export const ACCESS_MATERIALISE_MAX_BYTES = 2 * 1024 * 1024;
/** UTF-8 JSON bytes across the whole set, in grant order. */
export const ACCESS_MATERIALISE_MAX_SET_BYTES = 8 * 1024 * 1024;
/** The Worker's wall clock for one dump — the SQL is the host's, so a timeout counts no strike. */
export const ACCESS_MATERIALISE_TIMEOUT_MS = 5_000;
