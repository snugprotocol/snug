// starterSource.ts — the ONE module that owns every `examples/` glob (TASK-20260905-host-kit
// AC14, A3). The shelf (`starterApps`), the release metadata (`starterMeta`), the authored
// runtime contracts (`starterRuntimeContract`), the authoring docs (`starterDocs`) and the
// connection manifests (`starterDeclaration`) all read through the `StarterSource` this
// module returns, and none of them declares a glob of its own — pinned by
// `examples/validate.test.mjs`, which parses the producers rather than restating them.
//
// WHY ONE MODULE. `import.meta.glob` is BUILD-time: whatever it matches lands in the bundle
// whether or not the runtime ever calls it, and a single-file build (`inlineDynamicImports`)
// inlines every lazy chunk. The host kit keeps the ≈ 1 MB of starter bytes out of its page
// by aliasing exactly this module to an on-demand implementation of the same interface —
// card metadata inline, each starter's bundle loaded on click from a content-pinned
// package. A runtime seat could not do that; five scattered globs would need five aliases.
//
// The glob PATTERNS are the contract (each artifact class reaches exactly its file and
// nothing deeper — ADR-0031 AC9, ADR-0035, ADR-0045). `?raw`: Vite never parses these at
// transform time, so a malformed file degrades to "this starter ships none" instead of
// breaking the build.

const htmlModules = import.meta.glob('../../../../examples/*/app.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const metaModules = import.meta.glob('../../../../examples/*/starter.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const contractModules = import.meta.glob('../../../../examples/*/runtime-contract.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const manifestModules = import.meta.glob('../../../../examples/*/connection.json', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const docModules = import.meta.glob('../../../../examples/*/authoring/{docs,prompts}/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** One starter's authoring bundle: `{ docs: { 'vision.md': '…' }, prompts: { '01-build.md': '…' } }`. */
export interface StarterAuthoringBundle {
  docs: Record<string, string>;
  prompts: Record<string, string>;
}

/**
 * Where the starters come from. Every method is keyed by the starter FOLDER (`chess`), never
 * by the shelf id (`starter--chess`) — the id is the shelf's business.
 *
 * `appFolders()` is synchronous on purpose: the shelf renders its cards from it at first
 * paint, so an implementation must know its catalogue without a round trip (the glob knows
 * it at build time; the kit ships the card metadata inline). Everything else is async and
 * resolves `undefined` for a folder that ships no such file.
 */
export interface StarterSource {
  appFolders(): string[];
  html(folder: string): Promise<string | undefined>;
  meta(folder: string): Promise<string | undefined>;
  contract(folder: string): Promise<string | undefined>;
  manifest(folder: string): Promise<string | undefined>;
  authoring(): Promise<Record<string, StarterAuthoringBundle>>;
}

function folderOf(path: string, file: string): string | undefined {
  return new RegExp(`examples/([^/]+)/${file.replace(/\./g, '\\.')}$`).exec(path)?.[1];
}

function byFolder(modules: Record<string, () => Promise<string>>, file: string): Map<string, () => Promise<string>> {
  const out = new Map<string, () => Promise<string>>();
  for (const [path, load] of Object.entries(modules)) {
    const folder = folderOf(path, file);
    if (folder !== undefined) out.set(folder, load);
  }
  return out;
}

const html = byFolder(htmlModules, 'app.html');
const meta = byFolder(metaModules, 'starter.json');
const contracts = byFolder(contractModules, 'runtime-contract.json');
const manifests = byFolder(manifestModules, 'connection.json');

const load = async (table: Map<string, () => Promise<string>>, folder: string): Promise<string | undefined> => {
  const loader = table.get(folder);
  return loader === undefined ? undefined : loader();
};

const GLOB_SOURCE: StarterSource = {
  appFolders: () => [...html.keys()].sort((a, b) => a.localeCompare(b)),
  html: (folder) => load(html, folder),
  meta: (folder) => load(meta, folder),
  contract: (folder) => load(contracts, folder),
  manifest: (folder) => load(manifests, folder),
  async authoring() {
    const out: Record<string, StarterAuthoringBundle> = {};
    for (const [path, loader] of Object.entries(docModules)) {
      const match = /examples\/([^/]+)\/authoring\/(docs|prompts)\/([^/]+\.md)$/.exec(path);
      if (match === null) continue;
      const [, folder, kind, file] = match as unknown as [string, string, 'docs' | 'prompts', string];
      const bundle = out[folder] ?? { docs: {}, prompts: {} };
      bundle[kind][file] = await loader();
      out[folder] = bundle;
    }
    return out;
  },
};

/** The bundled starters — the glob-backed source on web and desktop; the host kit aliases this module. */
export function starterSource(): StarterSource {
  return GLOB_SOURCE;
}
