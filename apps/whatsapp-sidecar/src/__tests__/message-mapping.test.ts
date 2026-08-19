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

  /**
   * THE PUSH NAME IS THE RICHEST NAME SOURCE IN A HISTORY SYNC (owner report 2026-08-18:
   * "most participants show Unknown contact"). Baileys stamps `pushName` — the sender's
   * self-set display name — on every message row, and it is the ONLY name source for a group
   * member who never had a 1:1 chat with the user: history-sync contact rows are synthesized
   * one-per-conversation, and `contacts.update` is emitted from pushName only for LIVE
   * messages, never for history replay. Discarding it here was the dominant cause.
   */
  it('carries the sender push name for a row someone else sent', () => {
    const mapped = toWaMessage({
      key: { id: 'M20', remoteJid: '999@g.us', participant: '222@s.whatsapp.net', fromMe: false },
      message: { conversation: 'hi' },
      messageTimestamp: 5,
      pushName: 'Bo Chen',
    });
    expect(mapped?.senderPushName).toBe('Bo Chen');
  });

  it("never harvests a push name from the user's OWN row", () => {
    // On a fromMe row the sender seat resolves to the CHAT PARTNER (a DM's remoteJid) while
    // `pushName` is the USER's own name — harvesting it would rename the partner as the
    // user. The worst possible spelling of this bug: every DM partner becomes "you".
    const mapped = toWaMessage({
      key: { id: 'M21', remoteJid: '111@s.whatsapp.net', fromMe: true },
      message: { conversation: 'me' },
      messageTimestamp: 5,
      pushName: 'My Own Name',
    });
    expect(mapped).toBeDefined();
    expect(mapped).not.toHaveProperty('senderPushName');
  });

  it('omits the seat for an empty or missing push name rather than writing a blank', () => {
    expect(toWaMessage({ ...dmMessage, pushName: '' })).not.toHaveProperty('senderPushName');
    expect(toWaMessage(dmMessage)).not.toHaveProperty('senderPushName');
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

  it('drops unsupported message kinds rather than inventing a placeholder', () => {
    // A synthesized "<sticker>" would enter the transcript as something the person never
    // wrote, and the LLM would then analyse it as their words. Images are the ONE exception
    // now (below) — and only because they map as a TYPED row, never as invented text.
    for (const message of [
      { audioMessage: {} },
      { stickerMessage: {} },
      { videoMessage: {} },
      { reactionMessage: { text: '👍' } },
      { protocolMessage: {} },
      null,
    ]) {
      expect(
        toWaMessage({ key: { id: 'M5', remoteJid: '111@s.whatsapp.net' }, message, messageTimestamp: 5 }),
        JSON.stringify(message),
      ).toBeUndefined();
    }
  });

  // ---- surface v2 (ADR-0034, TASK-20260817-telepath): images become typed rows ----

  it('maps an image message as a TYPED row — its caption as text, never invented words', () => {
    const mapped = toWaMessage({
      key: { id: 'IMG1', remoteJid: '111@s.whatsapp.net', fromMe: false },
      message: {
        imageMessage: {
          caption: 'look at this',
          mimetype: 'image/jpeg',
          jpegThumbnail: new Uint8Array([1, 2, 3]),
        },
      },
      messageTimestamp: 9,
    });
    expect(mapped?.message.kind).toBe('image');
    expect(mapped?.message.text).toBe('look at this');
    // The media id IS the message id — `GET /chats/:jid/media/:id` dereferences it.
    expect(mapped?.message.mediaId).toBe('IMG1');
    expect(mapped?.message.thumbnailBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('maps a captionless image with EMPTY text — typed, not worded', () => {
    const mapped = toWaMessage({
      key: { id: 'IMG2', remoteJid: '111@s.whatsapp.net' },
      message: { imageMessage: {} },
      messageTimestamp: 9,
    });
    expect(mapped?.message.kind).toBe('image');
    expect(mapped?.message.text).toBe('');
    expect(mapped?.message).not.toHaveProperty('thumbnailBase64');
  });

  it('accepts a base64-string thumbnail as-is (Baileys serializes bytes both ways)', () => {
    const mapped = toWaMessage({
      key: { id: 'IMG3', remoteJid: '111@s.whatsapp.net' },
      message: { imageMessage: { jpegThumbnail: 'AQID' } },
      messageTimestamp: 9,
    });
    expect(mapped?.message.thumbnailBase64).toBe('AQID');
  });

  it('leaves plain text rows UNMARKED — v1 consumers keep reading them unchanged', () => {
    expect(toWaMessage(dmMessage)?.message).not.toHaveProperty('kind');
    expect(toWaMessage(dmMessage)?.message).not.toHaveProperty('mediaId');
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
