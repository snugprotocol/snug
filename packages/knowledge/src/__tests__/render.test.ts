import { describe, expect, it } from 'vitest';
import {
  CDN_ALLOWLIST,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  SNUG_APP_REQUEST_TAG,
} from '@snugprotocol/protocol';

import { APP_BUILDER_TOOL_NAME, renderPrompt } from '../index.js';

describe('APP_BUILDER_TOOL_NAME (single home of the tool name)', () => {
  it('is the underscore form — MCP hosts reject dots', () => {
    expect(APP_BUILDER_TOOL_NAME).toBe('snug_app_builder');
    expect(APP_BUILDER_TOOL_NAME).not.toContain('.');
  });
});

describe('renderPrompt', () => {
  it('injects {{envelopeTag}} from SNUG_APP_REQUEST_TAG', () => {
    expect(renderPrompt('Tag: {{envelopeTag}}')).toBe(`Tag: ${SNUG_APP_REQUEST_TAG}`);
  });

  it('injects {{appBuilderToolName}}', () => {
    expect(renderPrompt('Call {{appBuilderToolName}}.')).toBe('Call snug_app_builder.');
  });

  it('injects {{cdnAllowlist}} as the comma-joined CDN_ALLOWLIST', () => {
    expect(renderPrompt('{{cdnAllowlist}}')).toBe(CDN_ALLOWLIST.join(', '));
  });

  it('injects {{maxArtifactBytes}} derived from LIMITS.MAX_ARTIFACT_BYTES', () => {
    expect(renderPrompt('max {{maxArtifactBytes}}')).toBe(
      `max ${LIMITS.MAX_ARTIFACT_BYTES / (1024 * 1024)} MB`,
    );
    expect(renderPrompt('max {{maxArtifactBytes}}')).toBe('max 5 MB');
  });

  it('injects {{protocolVersion}} from PROTOCOL_VERSION', () => {
    expect(renderPrompt('v: {{protocolVersion}}')).toBe(`v: ${String(PROTOCOL_VERSION)}`);
  });

  it('injects {{maxFrameKiB}} derived from LIMITS.MAX_FRAME_BYTES', () => {
    expect(renderPrompt('{{maxFrameKiB}}')).toBe(`${LIMITS.MAX_FRAME_BYTES / 1024} KiB`);
    expect(renderPrompt('{{maxFrameKiB}}')).toBe('256 KiB');
  });

  it('injects {{maxParseFailures}} from LIMITS.MAX_PARSE_FAILURES', () => {
    expect(renderPrompt('{{maxParseFailures}}')).toBe(String(LIMITS.MAX_PARSE_FAILURES));
  });

  it('injects {{rawExcerptChars}} from LIMITS.RAW_EXCERPT_CHARS', () => {
    expect(renderPrompt('{{rawExcerptChars}}')).toBe(String(LIMITS.RAW_EXCERPT_CHARS));
  });

  it('injects {{frameType:<key>}} from FRAME_TYPES', () => {
    expect(renderPrompt('{{frameType:appMessage}}')).toBe(FRAME_TYPES.appMessage);
    expect(renderPrompt('{{frameType:announce}}')).toBe(FRAME_TYPES.announce);
    expect(renderPrompt('{{frameType:hostReady}}')).toBe(FRAME_TYPES.hostReady);
    expect(renderPrompt('{{frameType:dbRequest}}')).toBe(FRAME_TYPES.dbRequest);
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(renderPrompt('{{envelopeTag}} then {{envelopeTag}}')).toBe(
      `${SNUG_APP_REQUEST_TAG} then ${SNUG_APP_REQUEST_TAG}`,
    );
  });

  it('throws on an unknown placeholder (strict renderer)', () => {
    expect(() => renderPrompt('hello {{noSuchThing}}')).toThrowError(/Unknown placeholder/);
  });

  it('throws on an unknown frame-type key', () => {
    expect(() => renderPrompt('{{frameType:nope}}')).toThrowError(/Unknown frame-type/);
  });

  it('passes triple-brace runtime placeholders through as double-brace, unresolved', () => {
    expect(renderPrompt('Hello {{{userName}}}!')).toBe('Hello {{userName}}!');
    // Even when the name collides with a build-time placeholder, triple-brace stays runtime.
    expect(renderPrompt('{{{envelopeTag}}}')).toBe('{{envelopeTag}}');
  });

  it('leaves text without placeholders untouched', () => {
    const text = 'plain prose with { single } braces and code `${x}`';
    expect(renderPrompt(text)).toBe(text);
  });
});
