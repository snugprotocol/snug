// Shared in-memory OPFS fake covering exactly the surface the OPFS backend uses
// (getDirectoryHandle/getFileHandle/createWritable/getFile/keys/removeEntry, with
// lastModified stamped on close). Used by persistence tests and by sync tests that
// must exercise the PRODUCTION (A/B-slot) backend path rather than the memory backend.

export function fakeOpfs(files = new Map<string, Uint8Array>()) {
  const notFound = (): Error => Object.assign(new Error('file not found'), { name: 'NotFoundError' });
  let clock = 0;
  const mtimes = new Map<string, number>();
  const fileHandle = (path: string) => ({
    async getFile() {
      const bytes = files.get(path);
      if (!bytes) throw notFound();
      return {
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
        lastModified: mtimes.get(path) ?? 0,
      };
    },
    /** Chromium rename semantics: replaces the destination, removes the source. */
    async move(newName: string) {
      const bytes = files.get(path);
      if (!bytes) throw notFound();
      const dirPrefix = path.slice(0, path.lastIndexOf('/') + 1);
      files.delete(path);
      files.set(`${dirPrefix}${newName}`, bytes);
    },
    async createWritable() {
      const chunks: Uint8Array[] = [];
      return {
        async write(data: Uint8Array) {
          chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data));
        },
        async close() {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          files.set(path, merged);
          mtimes.set(path, ++clock);
        },
      };
    },
  });
  const dirHandle = (prefix: string) => ({
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      void opts;
      return dirHandle(`${prefix}${name}/`);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const path = `${prefix}${name}`;
      if (!files.has(path) && !opts?.create) throw notFound();
      if (opts?.create && !files.has(path)) files.set(path, new Uint8Array(0));
      return fileHandle(path);
    },
    async *keys() {
      for (const path of [...files.keys()]) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) yield path.slice(prefix.length);
      }
    },
    async removeEntry(name: string) {
      files.delete(`${prefix}${name}`);
    },
  });
  return {
    files,
    storage: { getDirectory: async () => dirHandle('/') },
  };
}
