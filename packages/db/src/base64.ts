// Browser-safe base64 <-> bytes. Uses the atob/btoa globals (browsers and Node >= 16) —
// never node:buffer, so the package stays free of node: imports (AC-8).

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Total decoder: undefined on malformed input instead of throwing. */
export function base64ToBytes(b64: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
