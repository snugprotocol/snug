// The ONE source for every plugin manifest (ADR-0068 §8, program D7).
//
// Three manifests describe the same plugin to three hosts, and the repo's own rule is that
// one contract never lives in two artifacts by convention — inject from one source or
// byte-compare in CI. This module is that source: `build-plugin.mjs` writes the local
// install tree from it today, and T6's generator emits the distribution repo's copies from
// it later. Neither hand-writes a field.
//
// Dependency-free node builtins only, like every other file under `scripts/`.

/** The plugin's identity, shared by all three manifests. */
export const PLUGIN = {
  name: 'snug',
  version: '0.1.0',
  description: 'Build and run your own micro apps, on your machine, with your own data.',
  author: { name: 'TechVoyage LLC' },
  homepage: 'https://snugprotocol.org',
  license: 'MIT',
};

export const MARKETPLACE = {
  name: 'snug-local',
  description: 'Snug — user-owned micro apps built by your agent.',
  owner: { name: 'TechVoyage LLC', email: 'hello@snugprotocol.org' },
};

/** The server's id inside the plugin; tools appear to the agent as `mcp__plugin_snug_snug__*`. */
export const MCP_SERVER_ID = 'snug';

/** The bundle's path inside the plugin, from its root. */
export const BUNDLE_PATH = 'scripts/snug-mcp.mjs';

/**
 * Claude Code and Cowork: `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install
 * directory, which changes on every update — which is exactly why nothing may be stored
 * under it. Verified against the installed marketplace's own plugins, which spell it the
 * same way.
 */
export function claudeMcpConfig() {
  return {
    mcpServers: {
      [MCP_SERVER_ID]: {
        command: 'node',
        args: [`\${CLAUDE_PLUGIN_ROOT}/${BUNDLE_PATH}`],
      },
    },
  };
}

/**
 * Codex has no plugin-root variable (openai/codex#22842 — relative paths resolve from the
 * cwd), so the published package is the only stable reference. Until `@snugprotocol/host-mcp`
 * exists — an owner act — an absolute path is the documented interim.
 *
 * @param {{ absolutePath?: string }} [options] the interim form, when the package is unpublished
 */
export function codexMcpConfig(options = {}) {
  const server =
    options.absolutePath === undefined
      ? { command: 'npx', args: ['-y', '@snugprotocol/host-mcp'] }
      : { command: 'node', args: [options.absolutePath] };
  return { mcpServers: { [MCP_SERVER_ID]: server } };
}

export function claudePluginManifest() {
  return {
    name: PLUGIN.name,
    version: PLUGIN.version,
    description: PLUGIN.description,
    author: PLUGIN.author,
    homepage: PLUGIN.homepage,
    license: PLUGIN.license,
  };
}

export function codexPluginManifest() {
  return { ...claudePluginManifest() };
}

/** A marketplace of one, for installing from a local path. */
export function marketplaceManifest(source = './snug') {
  return {
    name: MARKETPLACE.name,
    description: MARKETPLACE.description,
    owner: MARKETPLACE.owner,
    plugins: [
      {
        name: PLUGIN.name,
        description: PLUGIN.description,
        author: PLUGIN.author,
        source,
      },
    ],
  };
}
