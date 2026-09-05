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
