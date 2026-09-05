// build-stamp.ts — `<package version> <commit sha>[-dirty]` (TASK-20260905-host-kit AC11).
// The stamp is the page's provenance: `check-host-kit` reads it, and two clean builds at
// the same commit must carry the same one (reproducibility is sha256-compared there).

export function buildStamp(input: { version: string; sha: string; dirty: boolean }): string {
  if (input.version.trim() === '') throw new Error('build stamp: empty package version');
  if (input.sha.trim() === '') throw new Error('build stamp: empty commit sha');
  return `${input.version} ${input.sha}${input.dirty ? '-dirty' : ''}`;
}
