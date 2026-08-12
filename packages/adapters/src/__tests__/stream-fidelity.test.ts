/**
 * TASK-20260812-app-reply-parse-failure, AC2 — the owner's REAL failing stream, replayed
 * byte-faithfully through the real Anthropic adapter (fixture verbatim in the task file).
 *
 * What the capture shows: the network delivered deltas `{`, `{`, ` streaks AS (…` — the
 * `"sql":"WITH ordered AS (…)` head of the reply never arrived, yet the delivered tail
 * references `FROM ordered` and `message_delta` bills 215 output tokens (~3–4× the
 * delivered text) with a clean `end_turn`. The generation was complete; the DELIVERY was
 * not. This suite exists to establish, with proof rather than by inspection, that OUR
 * layer (parseSse + the anthropic adapter) is loss-free and byte-faithful for exactly
 * this stream under every possible chunk split — so the loss is upstream of the client
 * and no amount of client-side parsing work can fix it, only classify it.
 *
 * These are green tests pinning correct behavior. If one ever goes red, our SSE layer
 * has ACQUIRED the delivery bug this task chased — treat as a P0.
 */

import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../anthropic.js';
import { fakeFetch, sseResponse } from './helpers.js';

// The wire bytes as captured, including Anthropic's interior whitespace padding and the
// doubled `{` delta. Do not "clean this up" — byte fidelity is the point.
const OWNER_STREAM = `event: message_start
data: {"type":"message_start","message":{"model":"claude-sonnet-5","id":"msg_011CdyXaRqJ9KTpSWEt2LPL5","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":1426,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard","inference_geo":"global"}}   }

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}   }

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{"}      }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{"}      }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" streaks AS (SELECT habit_id, COUNT(*) AS streak_len FROM ordered GROUP BY habit_id, grp) SELECT h.name, h.emoji, s.streak_len FROM streaks s J"}               }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OIN habits h ON h.id = s.habit_id ORDER BY s.streak_len DESC LIMIT 1;\\",\\"message\\":\\"Let's see which habit has your longest streak!\\"}"}           }

event: content_block_stop
data: {"type":"content_block_stop","index":0         }

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":1426,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":215,"output_tokens_details":{"thinking_tokens":0}}               }

event: message_stop
data: {"type":"message_stop"            }

`;

/** The text those deltas assemble to — corrupt AS DELIVERED, not as generated. */
const DELIVERED_TEXT =
  '{{ streaks AS (SELECT habit_id, COUNT(*) AS streak_len FROM ordered GROUP BY habit_id, grp) ' +
  'SELECT h.name, h.emoji, s.streak_len FROM streaks s JOIN habits h ON h.id = s.habit_id ' +
  'ORDER BY s.streak_len DESC LIMIT 1;","message":"Let\'s see which habit has your longest streak!"}';

const turn = { messages: [{ role: 'user' as const, content: 'which habit has my longest streak?' }] };

async function replay(chunks: string[]): Promise<{ text: string; stopReason: string } | null> {
  const { fetchImpl } = fakeFetch(() => sseResponse(chunks));
  const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
  const result = await adapter.complete({ system: 'S', ...turn });
  return result.ok ? { text: result.text, stopReason: result.stopReason } : null;
}

describe('owner repro stream — our layer is byte-faithful and loss-free', () => {
  it('assembles exactly the delivered bytes, with end_turn and the billed usage surfaced', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(OWNER_STREAM));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(DELIVERED_TEXT);
    // end_turn, NOT max_tokens — the truncation hypothesis is refuted for this repro.
    expect(result.stopReason).toBe('end');
    expect(result.model).toBe('claude-sonnet-5');
    // The token-gap evidence rides to the inspector: 215 billed vs ~245 delivered CHARS.
    expect(result.usage).toMatchObject({ inputTokens: 1426, outputTokens: 215 });
  });

  it('EVERY two-chunk split of the stream assembles the identical text — no boundary loses a delta', async () => {
    // Exhaustive: a chunk boundary at every byte position, including mid-"data:",
    // mid-JSON-escape (\\"), mid-multibyte would-be positions, and between \n\n.
    for (let split = 1; split < OWNER_STREAM.length; split++) {
      const result = await replay([OWNER_STREAM.slice(0, split), OWNER_STREAM.slice(split)]);
      expect(result, `split at byte ${split} broke the stream`).not.toBeNull();
      expect(result!.text, `split at byte ${split} altered the text`).toBe(DELIVERED_TEXT);
      expect(result!.stopReason).toBe('end');
    }
  }, 30_000);

  it('a pathological one-byte-per-chunk delivery still assembles the identical text', async () => {
    const result = await replay([...OWNER_STREAM]);
    expect(result).not.toBeNull();
    expect(result!.text).toBe(DELIVERED_TEXT);
    expect(result!.stopReason).toBe('end');
  });
});
