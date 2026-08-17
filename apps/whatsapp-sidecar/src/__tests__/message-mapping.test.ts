/**
 * MAPPING BAILEYS MESSAGES ONTO THE SEAM (Phase C.2).
 *
 * `toWaMessage` is the one piece of the Baileys adapter that carries real logic rather than
 * wiring, and it is pure, so it is tested directly. Everything downstream — per-person
 * statistics, persona profiles, the mimic voice, the group auto-reply trigger — is computed
 * from its output, so a mapping fault does not crash anything. It quietly produces a
 * confident description of the wrong person.
 *
 * These fixtures use the payload shapes read from the published `baileys@7.0.0-rc14` tarball.
 */

import { describe, expect, it } from 'vitest';
import { toWaMessage } from '../baileys-socket.js';

const dmMessage = {
  key: { id: 'M1', remoteJid: '111@s.whatsapp.net', fromMe: false },
  message: { conversation: 'hello there' },
  messageTimestamp: 1_700_000_000,
};

describe('toWaMessage', () => {
  it('maps a plain DM text message', () => {
    const mapped = toWaMessage(dmMessage);
    expect(mapped).toEqual({
      chatJid: '111@s.whatsapp.net',
      message: { id: 'M1', from: '111@s.whatsapp.net', text: 'hello there', ts: 1_700_000_000 },
    });
  });

  it('uses the PARTICIPANT as the sender in a group, not the group jid', () => {
    // The group's own JID is the conversation, not a person. Attributing every group message
    // to the group would collapse every participant into one profile — the single most
    // damaging thing this mapper could get wrong.
    const mapped = toWaMessage({
      key: { id: 'M2', remoteJid: '999@g.us', participant: '222@s.whatsapp.net', fromMe: false },
      message: { conversation: 'in the group' },
      messageTimestamp: 5,
    });
    expect(mapped?.chatJid).toBe('999@g.us');
    expect(mapped?.message.from).toBe('222@s.whatsapp.net');
  });

  it('reads extendedTextMessage bodies (replies and link previews)', () => {
    const mapped = toWaMessage({
      key: { id: 'M3', remoteJid: '111@s.whatsapp.net', fromMe: false },
      message: { extendedTextMessage: { text: 'a reply' } },
      messageTimestamp: 5,
    });
    expect(mapped?.message.text).toBe('a reply');
  });

  it('marks the user’s OWN messages — these are the rows the mimic profile is built from', () => {
    const mapped = toWaMessage({ ...dmMessage, key: { ...dmMessage.key, fromMe: true } });
    expect(mapped?.message.fromMe).toBe(true);
  });

  it('omits fromMe entirely when false, rather than writing a falsey field', () => {
    expect(toWaMessage(dmMessage)?.message).not.toHaveProperty('fromMe');
  });

  it('captures @-mentions — the group auto-reply trigger reads them', () => {
    const mapped = toWaMessage({
      key: { id: 'M4', remoteJid: '999@g.us', participant: '222@s.whatsapp.net', fromMe: false },
      message: {
        extendedTextMessage: { text: 'hey @you', contextInfo: { mentionedJid: ['333@s.whatsapp.net'] } },
      },
      messageTimestamp: 5,
    });
    expect(mapped?.message.mentions).toEqual(['333@s.whatsapp.net']);
  });

  it('converts a protobuf Long timestamp rather than storing an object', () => {
    // Baileys hands back a Long for large timestamps. Storing it unconverted makes every
    // sort and every "since" comparison silently meaningless.
    const mapped = toWaMessage({
      ...dmMessage,
      messageTimestamp: { toNumber: () => 1_700_000_123 } as unknown as number,
    });
    expect(mapped?.message.ts).toBe(1_700_000_123);
  });

  it('drops non-text messages rather than inventing a placeholder', () => {
    // v1 is text-only. A synthesized "<image>" would enter the transcript as something the
    // person never wrote, and the LLM would then analyse it as their words.
    expect(toWaMessage({ key: { id: 'M5', remoteJid: '111@s.whatsapp.net' }, message: { imageMessage: {} }, messageTimestamp: 5 })).toBeUndefined();
    expect(toWaMessage({ key: { id: 'M6', remoteJid: '111@s.whatsapp.net' }, message: null, messageTimestamp: 5 })).toBeUndefined();
  });

  it('drops a message with no id or no chat — an unaddressable row is not a message', () => {
    expect(toWaMessage({ key: { remoteJid: '111@s.whatsapp.net' }, message: { conversation: 'x' } })).toBeUndefined();
    expect(toWaMessage({ key: { id: 'M7' }, message: { conversation: 'x' } })).toBeUndefined();
  });

  it('drops an empty-string body — it is not text, and it would skew message-length stats', () => {
    expect(
      toWaMessage({ key: { id: 'M8', remoteJid: '111@s.whatsapp.net' }, message: { conversation: '' }, messageTimestamp: 5 }),
    ).toBeUndefined();
  });
});
