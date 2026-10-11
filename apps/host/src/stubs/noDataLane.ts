// The ONE sentence the kit's dead-lane stubs throw (TASK-20261010-host-broker PR-2, the owner's
// kit-ceiling cut of 2026-10-11). Every kit binding pins the HOST brain, composed `tools: false`,
// or the DEMO brain — so the chat's data lane (the router, the lane tools, the brain's ask and
// its card) never runs in the page, and `apps/host/vite.config.ts` swaps those five modules out
// by resolved path. `src/__tests__/kitDeadLanes.test.ts` pins the sentence. Reaching one of the
// stubs is a wiring defect, never a feature gap: the error names the call so it reads as one.

/** The error a swapped-out call throws; `name` reads `module.export`, e.g. `chatRouter.routeChatMessage`. */
export const noDataLane = (name: string): Error =>
  new Error(`the host kit has no data lane — ${name} is swapped out of the kit page (apps/host/vite.config.ts)`);
