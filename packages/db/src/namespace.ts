// Namespace → filename mapping. The namespace is HOST-assigned (never the app-claimed
// appId — runner F5), but hosts are free-form strings, so it is still sanitized before
// becoming an OPFS/IndexedDB file name. Sanitized names carry a hash of the ORIGINAL
// namespace so two distinct namespaces can never collide onto one file.

const SAFE_NAMESPACE = /^[A-Za-z0-9._-]+$/;
const MAX_STEM_CHARS = 64;

/** djb2 over UTF-16 code units, rendered as unsigned hex — stable and dependency-free. */
function hashHex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

export function namespaceToFileName(namespace: string): string {
  if (namespace.length > 0 && namespace.length <= MAX_STEM_CHARS && SAFE_NAMESPACE.test(namespace)) {
    return `${namespace}.sqlite`;
  }
  const stem = namespace.slice(0, MAX_STEM_CHARS).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${stem.length > 0 ? stem : 'ns'}-${hashHex(namespace)}.sqlite`;
}
