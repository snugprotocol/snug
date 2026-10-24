/**
 * The one record guard this package's parsers share (Gate 5 ST6 of
 * TASK-20261023-siwc-chatgpt-plan: two private copies had drifted — one let an array through,
 * so `body['access_token']` could be read off a list). A record is a JSON object: not null,
 * not an array. Anything that then reads a member by name is reading the object its author
 * meant, never index `0` of a list.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
