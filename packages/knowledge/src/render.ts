// render.ts — strict {{placeholder}} renderer for prompt sources.
//
// Wire literals are NEVER retyped in prompt text (ADR-0004): prompt sources carry
// placeholders and this module injects the values from @snugprotocol/protocol. The
// renderer is strict — an unknown placeholder is a build-breaking error, not silence.

import {
  APP_OBJECT_NAME_RULE,
  AUTH_EVIDENCE_MAX_CHARS,
  AUTH_EVIDENCE_MAX_ITEMS,
  AUTH_KINDS,
  AUTH_WIZARD_DIRECTIVE_KIND,
  CDN_ALLOWLIST,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  SNUG_APP_REQUEST_TAG,
  STANDARD_APP_DOC_SLUGS,
} from '@snugprotocol/protocol';

/**
 * The MCP tool name of the Snug app builder. Underscore form — MCP hosts reject dots.
 * This constant is the single home of the name; prompts receive it via
 * {{appBuilderToolName}} and code imports it from here.
 */
export const APP_BUILDER_TOOL_NAME = 'snug_app_builder';

/** Host tool that executes LLM-proposed app schema DDL (ADR-0010). Single home of the name. */
export const SCHEMA_APPLY_TOOL_NAME = 'schema_apply';

/** Host tool that writes the app's knowledge-wiki docs. Single home of the name. */
export const APP_DOC_WRITE_TOOL_NAME = 'app_doc_write';

/** Static substitutions available to every prompt source — all derived from protocol constants. */
const STATIC_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  envelopeTag: SNUG_APP_REQUEST_TAG,
  appBuilderToolName: APP_BUILDER_TOOL_NAME,
  schemaApplyToolName: SCHEMA_APPLY_TOOL_NAME,
  appDocWriteToolName: APP_DOC_WRITE_TOOL_NAME,
  appObjectNameRule: APP_OBJECT_NAME_RULE.source,
  standardDocSlugs: STANDARD_APP_DOC_SLUGS.join(', '),
  cdnAllowlist: CDN_ALLOWLIST.join(', '),
  protocolVersion: String(PROTOCOL_VERSION),
  maxArtifactBytes: `${LIMITS.MAX_ARTIFACT_BYTES / (1024 * 1024)} MB`,
  maxFrameKiB: `${LIMITS.MAX_FRAME_BYTES / 1024} KiB`,
  maxParseFailures: String(LIMITS.MAX_PARSE_FAILURES),
  rawExcerptChars: String(LIMITS.RAW_EXCERPT_CHARS),
  // AL-04 D8: the auth-spec-inferrer prompt injects the persisted kind literals and
  // the evidence bounds from protocol — never retyped in prompt text (ADR-0004).
  authKinds: AUTH_KINDS.join(', '),
  authEvidenceMaxItems: String(AUTH_EVIDENCE_MAX_ITEMS),
  authEvidenceMaxChars: String(AUTH_EVIDENCE_MAX_CHARS),
  // AL-05 M48: the directive-kind discriminator, injected — never retyped in KB text.
  authWizardDirectiveKind: AUTH_WIZARD_DIRECTIVE_KIND,
};

const FRAME_TYPE_PREFIX = 'frameType:';

/**
 * Triple-brace first so `{{{name}}}` never half-matches as a double-brace placeholder.
 * Triple-brace marks a RUNTIME placeholder: the renderer emits it as `{{name}}`,
 * untouched, for downstream runtime injection (e.g. tenant/user data).
 */
const PLACEHOLDER = /\{\{\{([A-Za-z0-9_:-]+)\}\}\}|\{\{([A-Za-z0-9_:-]+)\}\}/g;

function resolvePlaceholder(name: string): string {
  if (name.startsWith(FRAME_TYPE_PREFIX)) {
    const key = name.slice(FRAME_TYPE_PREFIX.length);
    if (Object.prototype.hasOwnProperty.call(FRAME_TYPES, key)) {
      return FRAME_TYPES[key as keyof typeof FRAME_TYPES];
    }
    throw new Error(
      `Unknown frame-type placeholder {{${name}}} — known keys: ${Object.keys(FRAME_TYPES).join(', ')}`,
    );
  }
  const value = STATIC_SUBSTITUTIONS[name];
  if (value === undefined) {
    throw new Error(
      `Unknown placeholder {{${name}}} — known placeholders: ${[
        ...Object.keys(STATIC_SUBSTITUTIONS),
        `${FRAME_TYPE_PREFIX}<key>`,
      ].join(', ')} (use {{{${name}}}} if this is a runtime placeholder)`,
    );
  }
  return value;
}

/**
 * Render a prompt source: substitute every `{{placeholder}}` from the protocol-derived
 * table, pass `{{{name}}}` through as `{{name}}`, and throw on anything unknown.
 */
export function renderPrompt(source: string): string {
  return source.replace(PLACEHOLDER, (_match, runtimeName: string | undefined, name: string | undefined) => {
    if (runtimeName !== undefined) return `{{${runtimeName}}}`;
    // The alternation guarantees exactly one group matched.
    return resolvePlaceholder(name as string);
  });
}
