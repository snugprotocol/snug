// copy.ts — run-surface copy that depends on which surfaces the platform allows
// (TASK-20260905-host-kit P3, the copy pass): a sentence that instructs the user to use
// a control the host hides is a lie in waiting, so the variant is chosen where the
// control's gate is known. Pure, so both arms are pinned byte-for-byte.

/** The install disclosure's closing sentence (RunView, §V2-6). */
export function starterInstallDisclosureTail(connectionsAllowed: boolean): string {
  return connectionsAllowed
    ? '. installing only copies the app — nothing is connected until you review and approve it yourself.'
    : '. installing only copies the app — connections aren’t available in this host, so it runs in its sample mode.';
}

/**
 * The run view's "no html" state (TASK-20260905-host-kit AC2). Without a reason it is the
 * library miss it always was, byte-identical; with one — the host kit's starter loader
 * refusing by name because the page is offline — the reason IS the lesson, so the user
 * reads "starters load from the network…" and never a dead "app not found".
 */
export function missingAppCopy(reason?: string): { title: string; lesson: string } {
  return reason === undefined
    ? { title: 'app not found', lesson: 'it may live in the other mode — check settings, or build a new one.' }
    : { title: 'this app didn’t load', lesson: reason };
}
