"use strict";

// P-256 test wire protocol. No DOM, storage, network, or implicit identity state.
// See docs/PROTOCOL.md before implementing another client. This is not a ratchet.
const SidewordProtocol = (() => {
  class ProtocolError extends Error {}
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const keyAlgorithm = Object.freeze({ name: "ECDH", namedCurve: "P-256" });

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  const MAX_FILE_BYTES = 1048576;
  const MAX_TEXT_BYTES = 16000;
  const MAX_PAYLOAD_BYTES = 1400000;
  const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
  const MAX_WIRE_CHARS = 4 * Math.ceil(MAX_ENVELOPE_BYTES / 3);
  const MAX_SEND_BYTES = 10 * 1024 * 1024;
  // Sender-made link previews travel inside the encrypted text payload; recipients never fetch.
  const MAX_PREVIEW_IMAGE_BYTES = 96 * 1024;
  const PREVIEW_FIELDS = ["url", "title", "description", "site_name", "final_host", "image"];
  // Reactions: thumbs up, red heart, tears of joy, thinking, crying; exact fully qualified forms.
  const REACTION_EMOJI = Object.freeze(["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F914}", "\u{1F622}"]);
  const REACTION_FIELDS = ["v", "type", "target_author", "target", "emoji", "rev"];
  const REFERENCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  // Optional reply on text and attachment-ref payloads: the quoted message's author public ID and
  // client message ID in the same chat, plus the sender's short excerpt (null without text).
  const REPLY_FIELDS = ["author", "target", "excerpt"];
  const MAX_REPLY_EXCERPT = 200;
  // Controls, bidirectional formatting and unpaired surrogates never appear in an excerpt.
  const EXCERPT_FORBIDDEN = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  function payloadError() {
    return new ProtocolError("Invalid or unsupported message payload. The message was not saved or acknowledged.");
  }

  function attachmentBytes(payload) {
    if (typeof payload.data !== "string" || !Number.isInteger(payload.size)
        || payload.size < 0 || payload.size > MAX_FILE_BYTES
        || payload.data.length !== 4 * Math.ceil(payload.size / 3)) throw payloadError();
    let bytes;
    try { bytes = base64ToBytes(payload.data); } catch { throw payloadError(); }
    // Reject whitespace, URL alphabet, missing padding and nonzero pad bits.
    if (bytes.length !== payload.size || bytesToBase64(bytes) !== payload.data) throw payloadError();
    return bytes;
  }

  function exactKeys(value, fields) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  }

  // Optional text, bounded; null when absent.
  function previewText(value, limit) {
    return value === null || (typeof value === "string" && value.length > 0 && value.length <= limit
      && !/[\x00-\x1f\x7f]/.test(value));
  }

  function validatePreview(preview) {
    if (!exactKeys(preview, PREVIEW_FIELDS) || typeof preview.url !== "string" || preview.url.length > 2048
        || !previewText(preview.title, 200) || !previewText(preview.description, 400)
        || !previewText(preview.site_name, 80)
        || !(preview.final_host === null || (typeof preview.final_host === "string"
          && /^[a-z0-9.:-]{1,253}$/.test(preview.final_host)))) throw payloadError();
    let url;
    try { url = new URL(preview.url); } catch { throw payloadError(); }
    if (url.protocol !== "https:" || url.href !== preview.url || url.username || url.password) throw payloadError();
    if (preview.image !== null) {
      const image = preview.image;
      if (!exactKeys(image, ["mime", "data"]) || image.mime !== "image/jpeg" || typeof image.data !== "string"
          || image.data.length > 4 * Math.ceil(MAX_PREVIEW_IMAGE_BYTES / 3)) throw payloadError();
      let bytes;
      try { bytes = base64ToBytes(image.data); } catch { throw payloadError(); }
      if (bytes.length < 4 || bytesToBase64(bytes) !== image.data
          || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw payloadError();
    }
    if (!preview.title && !preview.description && !preview.image) throw payloadError();
  }

  function validateReply(reply) {
    if (!exactKeys(reply, REPLY_FIELDS) || typeof reply.author !== "string" || !REFERENCE_ID.test(reply.author)
        || typeof reply.target !== "string" || !REFERENCE_ID.test(reply.target)
        || !(reply.excerpt === null || (typeof reply.excerpt === "string" && reply.excerpt.length > 0
          && reply.excerpt.length <= MAX_REPLY_EXCERPT && reply.excerpt.trim() === reply.excerpt
          && !EXCERPT_FORBIDDEN.test(reply.excerpt)))) throw payloadError();
  }

  function validatePayload(payload) {
    if (!payload || Array.isArray(payload) || payload.v !== 1) throw payloadError();
    if (payload.type === "link-preview") {
      // A sender's later preview for its own earlier text message, identified by client message ID.
      if (!exactKeys(payload, ["v", "type", "target", "preview"]) || typeof payload.target !== "string"
          || !/^[A-Za-z0-9_-]{1,58}$/.test(payload.target)) throw payloadError();
      validatePreview(payload.preview);
      return payload;
    }
    if (payload.type === "reaction") {
      // Sets (emoji) or removes (null) the sender's one reaction to a message in the same chat,
      // named by its author's public ID and client message ID. The highest `rev` wins.
      if (!exactKeys(payload, REACTION_FIELDS) || typeof payload.target_author !== "string"
          || !REFERENCE_ID.test(payload.target_author) || typeof payload.target !== "string"
          || !REFERENCE_ID.test(payload.target)
          || !(payload.emoji === null || REACTION_EMOJI.includes(payload.emoji))
          || !Number.isSafeInteger(payload.rev) || payload.rev < 1) throw payloadError();
      return payload;
    }
    const required = payload.type === "text" ? ["v", "type", "text"]
      : payload.type === "attachment" ? ["v", "type", "name", "mime", "size", "data"]
      : payload.type === "attachment-ref" ? ["v", "type", "text", "name", "mime", "size", "media_id"] : [];
    const optional = payload.type === "text" ? ["preview", "reply"] : payload.type === "attachment-ref" ? ["reply"] : [];
    const fields = [...required, ...optional.filter(field => Object.hasOwn(payload, field))];
    if (Object.keys(payload).length !== fields.length
        || !fields.every(field => Object.hasOwn(payload, field))) throw payloadError();
    if (Object.hasOwn(payload, "reply")) validateReply(payload.reply);
    if (payload.type === "text") {
      if (typeof payload.text !== "string" || !payload.text.length
          || encoder.encode(payload.text).length > MAX_TEXT_BYTES) {
        throw new ProtocolError("Text messages must contain 1–16,000 UTF-8 bytes.");
      }
      if (Object.hasOwn(payload, "preview")) validatePreview(payload.preview);
    } else {
      if (typeof payload.name !== "string" || !payload.name.length || payload.name.length > 255
          || typeof payload.mime !== "string" || payload.mime.length > 127
          || /[^\x20-\x7e]/.test(payload.mime)) throw payloadError();
      if (payload.type === "attachment") attachmentBytes(payload);
      else if (!Number.isInteger(payload.size) || payload.size < 0 || payload.size > MAX_FILE_BYTES
          || typeof payload.text !== "string" || encoder.encode(payload.text).length > MAX_TEXT_BYTES
          || typeof payload.media_id !== "string"
          || !/^[A-Za-z0-9_-]{1,58}\.media$/.test(payload.media_id)) throw payloadError();
    }
    return payload;
  }

  function encodePayload(payload) { return JSON.stringify(validatePayload(payload)); }

  function decodePayload(plaintext) {
    if (typeof plaintext !== "string" || plaintext.length > MAX_PAYLOAD_BYTES
        || encoder.encode(plaintext).length > MAX_PAYLOAD_BYTES) throw payloadError();
    let payload;
    try { payload = JSON.parse(plaintext); } catch { throw payloadError(); }
    return validatePayload(payload);
  }

  function textPayload(text, preview = null, reply = null) {
    const payload = { v: 1, type: "text", text };
    if (preview) payload.preview = preview;
    if (reply) payload.reply = reply;
    return validatePayload(payload);
  }

  function linkPreviewPayload(target, preview) {
    return validatePayload({ v: 1, type: "link-preview", target, preview });
  }

  function reactionPayload(targetAuthor, target, emoji, rev) {
    return validatePayload({ v: 1, type: "reaction", target_author: targetAuthor, target, emoji, rev });
  }

  function filePayload(name, mime, bytes) {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ProtocolError("Files must be 1 MiB or smaller.");
    return validatePayload({ v: 1, type: "attachment", name, mime,
      size: bytes.byteLength, data: bytesToBase64(bytes) });
  }

  function fileReference(name, mime, size, mediaId, text = "", reply = null) {
    const payload = { v: 1, type: "attachment-ref", name, mime, size, media_id: mediaId, text };
    if (reply) payload.reply = reply;
    return validatePayload(payload);
  }

  function safeDownloadName(name) {
    return name.replace(/[\/\\\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/^[. ]+|[. ]+$/g, "").slice(0, 180) || "download";
  }

  // Upper bound includes maximal JSON escaping and outer request fields.
  function attachmentSendBytes(size, recipients) {
    const payloadBytes = 4 * Math.ceil(size / 3) + 255 * 6 + 127 * 2 + 100;
    const envelopeBytes = 4 * Math.ceil((payloadBytes + 16) / 3) + 220;
    return 512 + recipients * (4 * Math.ceil(envelopeBytes / 3) + 512);
  }

  function envelopeContext(chatId, messageId, senderId, recipientId) {
    return encoder.encode(`sideword-web-p256-v1|${chatId}|${messageId}|${senderId}|${recipientId}`);
  }

  async function importPublicKey(value) {
    let bytes;
    try {
      bytes = base64ToBytes(value);
    } catch {
      throw new ProtocolError("Invalid P-256 public key: the participant's encryption key is not valid base64 data.");
    }
    if (bytes.length !== 65 || bytes[0] !== 4) {
      throw new ProtocolError("Invalid P-256 public key: the participant's encryption key has the wrong format.");
    }
    try {
      return await crypto.subtle.importKey("raw", bytes, keyAlgorithm, false, []);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") throw error;
      throw new ProtocolError("Invalid P-256 public key: the supplied point is not a valid key on this curve.");
    }
  }

  async function deriveSharedSecret(privateKey, publicKey) {
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      256,
    ));
  }

  async function deriveMessageKey(sharedSecret, salt, info, usage) {
    const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
    sharedSecret.fill(0);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
  }

  async function encryptForRecipient(identity, plaintext, chatId, messageId, recipient) {
    if (encoder.encode(plaintext).length > MAX_PAYLOAD_BYTES) throw payloadError();
    const recipientKey = await importPublicKey(recipient.public_key);
    const ephemeral = await crypto.subtle.generateKey(keyAlgorithm, false, ["deriveBits"]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const info = envelopeContext(chatId, messageId, identity.publicId, recipient.public_id);
    const staticSecret = await deriveSharedSecret(identity.privateKey, recipientKey);
    const ephemeralSecret = await deriveSharedSecret(ephemeral.privateKey, recipientKey);
    const combinedSecret = new Uint8Array(staticSecret.length + ephemeralSecret.length);
    combinedSecret.set(staticSecret);
    combinedSecret.set(ephemeralSecret, staticSecret.length);
    staticSecret.fill(0);
    ephemeralSecret.fill(0);
    const key = await deriveMessageKey(combinedSecret, salt, info, "encrypt");
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: info, tagLength: 128 },
      key,
      encoder.encode(plaintext),
    );
    const ephemeralPublicKey = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
    const envelope = {
      v: 1,
      alg: "P256-2DH-HKDF-SHA256-AES256GCM",
      epk: bytesToBase64(new Uint8Array(ephemeralPublicKey)),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext)),
    };
    return bytesToBase64(encoder.encode(JSON.stringify(envelope)));
  }

  async function decryptMessage(identity, message, sender) {
    if (typeof message.ciphertext !== "string" || message.ciphertext.length > MAX_WIRE_CHARS) throw payloadError();
    let envelope;
    try {
      envelope = JSON.parse(decoder.decode(base64ToBytes(message.ciphertext)));
    } catch {
      throw new ProtocolError("Invalid ciphertext format: this message is not valid encrypted-message data.");
    }
    if (!envelope || envelope.v !== 1 || envelope.alg !== "P256-2DH-HKDF-SHA256-AES256GCM") {
      throw new ProtocolError("Unsupported ciphertext format: this message uses an encryption format this client does not support.");
    }
    const senderKey = await importPublicKey(sender.public_key);
    const ephemeralKey = await importPublicKey(envelope.epk);
    let salt, iv, ciphertext;
    try {
      salt = base64ToBytes(envelope.salt);
      iv = base64ToBytes(envelope.iv);
      ciphertext = base64ToBytes(envelope.ct);
    } catch {
      throw new ProtocolError("Invalid ciphertext format: encryption parameters are missing or are not valid base64 data.");
    }
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
      throw new ProtocolError("Invalid ciphertext format: encryption parameters are missing or have invalid lengths.");
    }
    const info = envelopeContext(
      message.chat_id,
      message.client_message_id,
      message.sender_public_id,
      identity.publicId,
    );
    const staticSecret = await deriveSharedSecret(identity.privateKey, senderKey);
    const ephemeralSecret = await deriveSharedSecret(identity.privateKey, ephemeralKey);
    const combinedSecret = new Uint8Array(staticSecret.length + ephemeralSecret.length);
    combinedSecret.set(staticSecret);
    combinedSecret.set(ephemeralSecret, staticSecret.length);
    staticSecret.fill(0);
    ephemeralSecret.fill(0);
    const key = await deriveMessageKey(combinedSecret, salt, info, "decrypt");
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: info, tagLength: 128 }, key, ciphertext,
      );
    } catch {
      throw new ProtocolError("This message could not be authenticated or decrypted: its encrypted data or encryption keys do not match.");
    }
    try { return decoder.decode(plaintext); } catch { throw payloadError(); }
  }

  async function publicKeyFingerprint(publicKey) {
    const bytes = base64ToBytes(publicKey);
    await importPublicKey(publicKey);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  return Object.freeze({ bytesToBase64, base64ToBytes, encryptForRecipient,
    decryptMessage, publicKeyFingerprint, ProtocolError, encodePayload, decodePayload,
    textPayload, linkPreviewPayload, reactionPayload, filePayload, fileReference, validatePayload, attachmentBytes, safeDownloadName,
    attachmentSendBytes, MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_SEND_BYTES, MAX_WIRE_CHARS, MAX_PREVIEW_IMAGE_BYTES,
    MAX_REPLY_EXCERPT, REACTION_EMOJI });
})();
