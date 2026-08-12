// Debug-gate host remap for the desktop fetch path (TASK-20260812 P0 amendment 4).
//
// This module IS the production fetch path — `platform-desktop.ts` routes every
// outbound URL through `remapUrl` — precisely so the in-shell gate exercises the
// bytes that ship rather than a test-only fork. It is safe to ship because the
// table is DOUBLY gated and carries NO data of its own:
//
//   1. The table is populated exclusively from the `shell_gate_config` Rust
//      command, which exists ONLY in `#[cfg(debug_assertions)]` builds. In a
//      release binary the invoke fails, the config is null, and the table stays
//      empty for the life of the process.
//   2. Even in a debug binary, the Rust side answers `None` unless
//      SNUG_SHELL_GATE=1 (+OUT) was present in the environment at first read
//      (read once, immutable — gate.rs).
//
// NO HOST LITERALS LIVE HERE (or anywhere in the desktop TS): the journey's
// provider hosts and their loopback targets arrive via SNUG_SHELL_GATE_REMAP
// through the debug-only config. The gate driver's
// `remap-absent-from-release-bundle` check greps the built dist for remap
// mapping strings to hold this line. (The playground's `?demoreq=` demo-brain
// seam legitimately carries provider-shaped hostnames in EVERY web build — that
// is a pre-existing e2e seam, not a remap, and it maps nothing to loopback.)
//
// Note on tree-shaking: this module cannot be compiled out via
// `import.meta.env.PROD` because the SAME production bundle must serve both the
// release shell (remap inert) and the debug gate run (remap armed) — the switch
// is the debug-only Rust command, not a bundle variant. The
// `import.meta.env.DEV ||` clause below exists so a vite dev-server session
// (`tauri dev`) behaves identically to the built bundle: in both, only a
// non-null gate config can populate the table.

/** Pure: gate-config remap → table. `null`/`undefined` config ⇒ EMPTY table —
 *  the in-shell check `remap-inert-without-config` pins this path. */
export function buildRemapTable(
  remap: Readonly<Record<string, string>> | null | undefined,
): Map<string, string> {
  return remap == null ? new Map() : new Map(Object.entries(remap));
}

let table: ReadonlyMap<string, string> = new Map();

/**
 * Install the remap table from the gate config. Called once at boot by the gate
 * branch; the normal boot path never calls it, and calling with `null` is the
 * documented no-op (table stays empty).
 */
export function installGateRemap(config: { remap?: Record<string, string> } | null): void {
  if (!(import.meta.env.DEV || config !== null)) return;
  table = buildRemapTable(config?.remap ?? null);
}

/** Number of installed remap entries — exposed for the gate's inertness check. */
export function remapTableSize(): number {
  return table.size;
}

/**
 * Rewrite the URL's origin when its hostname is in the table; identity
 * otherwise (including on unparseable input — the real fetch reports that
 * error, not the remap). With an empty table this is a single size check.
 */
export function remapUrl(url: string): string {
  if (table.size === 0) return url;
  try {
    const u = new URL(url);
    const target = table.get(u.hostname);
    if (target === undefined) return url;
    const t = new URL(target);
    u.protocol = t.protocol;
    u.hostname = t.hostname;
    u.port = t.port;
    return u.toString();
  } catch {
    return url;
  }
}
