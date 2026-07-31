import { describe, expect, it } from 'vitest';

import { parseSse, tryParseJsonRecord } from '../sse.js';
import { collect, streamOf } from './helpers.js';

describe('parseSse', () => {
  it('parses named events with data', async () => {
    const events = await collect(parseSse(streamOf('event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n')));
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('defaults the event name to "message" when absent', async () => {
    const events = await collect(parseSse(streamOf('data: [DONE]\n\n')));
    expect(events).toEqual([{ event: 'message', data: '[DONE]' }]);
  });

  it('joins multi-line data with newlines', async () => {
    const events = await collect(parseSse(streamOf('data: line one\ndata: line two\n\n')));
    expect(events).toEqual([{ event: 'message', data: 'line one\nline two' }]);
  });

  it('skips comment lines (heartbeats) without disturbing surrounding blocks', async () => {
    const events = await collect(parseSse(streamOf(':hb\n\nevent: delta\ndata: {"text":"a"}\n\n:hb\n\ndata: b\n\n')));
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('ignores unknown fields and blocks without data (one malformed block never kills the stream)', async () => {
    const body = 'id: 7\nretry: 100\ngarbage without meaning\nevent: orphan\n\nevent: delta\ndata: ok\n\n';
    const events = await collect(parseSse(streamOf(body)));
    expect(events).toEqual([{ event: 'delta', data: 'ok' }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(parseSse(streamOf('event: delta\r\ndata: hi\r\n\r\n')));
    expect(events).toEqual([{ event: 'delta', data: 'hi' }]);
  });

  it('reassembles lines split across arbitrary chunk boundaries', async () => {
    const events = await collect(parseSse(streamOf('event: de', 'lta\nda', 'ta: {"text":"Hel', 'lo"}\n', '\n')));
    expect(events).toEqual([{ event: 'delta', data: '{"text":"Hello"}' }]);
  });

  it('flushes a trailing block that lacks the final blank line', async () => {
    const events = await collect(parseSse(streamOf('event: done\ndata: {"text":"end"}\n')));
    expect(events).toEqual([{ event: 'done', data: '{"text":"end"}' }]);
  });

  it('yields nothing for a null body', async () => {
    expect(await collect(parseSse(null))).toEqual([]);
  });
});

describe('tryParseJsonRecord', () => {
  it('returns the object for JSON objects and null for everything else', () => {
    expect(tryParseJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJsonRecord('{broken')).toBeNull();
    expect(tryParseJsonRecord('[1,2]')).toBeNull();
    expect(tryParseJsonRecord('"str"')).toBeNull();
    expect(tryParseJsonRecord('')).toBeNull();
  });
});
