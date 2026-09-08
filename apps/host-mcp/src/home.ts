// Where the process keeps its state — and the guard that makes reaching the REAL one an
// explicit act (D-B34).
//
// On 2026-09-07 a `/userdb` oversize-body test wrote 2 MiB of zeros over the owner's real
// `~/Snug/user.snug`, destroying two weeks of data no backup held. The test was wrong; the
// DEFECT was that `createRunner` and `createLoopbackServer` both defaulted to the live home,
// so forgetting to pass one was indistinguishable from asking for the user's own file.
//
// The fix is not "isolate the tests" — that repairs the tests that exist, not the next one
// someone writes. It is that the default must be a refusal, so an omission can only ever
// fail loudly and never write. Exactly one caller says `allowRealHome`: the shipped entry
// in `main.ts`, run by a host that means it.

/** Thrown when the real home would have been used without anyone asking for it. */
export class RealHomeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealHomeRefusedError';
  }
}

export interface ResolveHomeOptions {
  /** The environment to read. Injected so this is testable without touching the process's. */
  env?: Record<string, string | undefined>;
  /**
   * Opt in to the user's real `~/Snug`. The shipped process passes this; nothing else may.
   * Without it a missing `SNUG_HOME` is an error, not a silent fallback to real data.
   */
  allowRealHome?: boolean;
}

/**
 * Resolve the Snug home directory.
 *
 * `SNUG_HOME` always wins — it is the isolation seam the tests and the e2e already use, and
 * it stays honoured even under `allowRealHome` so a host can still be pointed somewhere safe.
 * Otherwise the real home is used ONLY on an explicit opt-in.
 */
export function resolveHome(options: ResolveHomeOptions = {}): string {
  const env = options.env ?? process.env;

  const explicit = env.SNUG_HOME;
  if (explicit !== undefined && explicit !== '') return explicit;

  if (options.allowRealHome !== true) {
    throw new RealHomeRefusedError(
      'refusing to use the real ~/Snug: set SNUG_HOME to an isolated directory, or pass allowRealHome for the shipped process. ' +
        'This guard exists because a test once destroyed the owner’s user file by defaulting here.',
    );
  }

  const realHome = env.HOME;
  if (realHome === undefined || realHome === '') {
    // The old code fell back to `'.'`, which turns a missing HOME into a `./Snug` written
    // wherever the process was started — a surprise store, not a safe one.
    throw new RealHomeRefusedError('refusing to guess a home directory: HOME is not set and SNUG_HOME was not given');
  }

  return `${realHome}/Snug`;
}
