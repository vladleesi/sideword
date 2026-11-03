const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { client } = require('./client_dom.cjs');

function protocolModule() {
  const context = vm.createContext({ TextEncoder, TextDecoder, DOMException, crypto: webcrypto, btoa, atob, URL });
  vm.runInContext(fs.readFileSync('app/static/client-protocol.js', 'utf8'), context);
  return vm.runInContext('SidewordProtocol', context);
}
const protocol = protocolModule();
const plain = value => JSON.parse(JSON.stringify(value));
const reply = (author, target, excerpt = null) => ({ author, target, excerpt });

test('reply references are optional, strictly bounded and only allowed on text and file references', () => {
  const valid = reply('ab12cd34ef56', 'm-1', 'hello there');
  assert.deepEqual(plain(protocol.textPayload('re', null, valid)), { v: 1, type: 'text', text: 're', reply: valid });
  assert.deepEqual(plain(protocol.fileReference('a.txt', 'text/plain', 3, 'm2.media', '', reply('p', 'm', null))).reply,
    reply('p', 'm', null));
  assert.equal(protocol.validatePayload({ v: 1, type: 'text', text: 'x', reply: { ...valid, excerpt: 'x'.repeat(200) } }).reply.excerpt.length, 200);
  for (const bad of [
    { ...valid, excerpt: 'x'.repeat(201) }, { ...valid, excerpt: '' }, { ...valid, excerpt: ' padded' },
    { ...valid, excerpt: 'line\nbreak' }, { ...valid, excerpt: 'a\u202Eb' }, { ...valid, excerpt: 'a\u2066b' },
    { ...valid, excerpt: '\uD83D' }, { ...valid, excerpt: 7 }, { ...valid, author: '' }, { ...valid, author: 'a:b' },
    { ...valid, target: 'x'.repeat(65) }, { ...valid, target: '../m' }, { ...valid, reply: valid },
    { author: 'a', target: 'b' }, null, 'm-1', [valid],
  ]) {
    assert.throws(() => protocol.validatePayload({ v: 1, type: 'text', text: 'x', reply: bad }), /Invalid/, JSON.stringify(bad));
  }
  // No replies on control payloads, and file bytes never carry one.
  assert.throws(() => protocol.validatePayload({ v: 1, type: 'reaction', target_author: 'a', target: 'b', emoji: null, rev: 1, reply: valid }));
  assert.throws(() => protocol.validatePayload({ v: 1, type: 'link-preview', target: 'b', reply: valid,
    preview: { url: 'https://example.com/', title: 't', description: null, site_name: null, final_host: null, image: null } }));
  assert.throws(() => protocol.validatePayload({ v: 1, type: 'attachment', name: 'a', mime: '', size: 0, data: '', reply: valid }));
  // Text payloads may combine a link preview and a reply.
  const preview = { url: 'https://example.com/', title: 't', description: null, site_name: null, final_host: null, image: null };
  assert.ok(protocol.textPayload('https://example.com/', preview, valid).preview);
});

test('reply references and quotes travel only inside the authenticated envelope', async () => {
  const identity = async publicId => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    return { publicId, privateKey: pair.privateKey, public_id: publicId, public_key: protocol.bytesToBase64(raw) };
  };
  const alice = await identity('alice'), bob = await identity('bob');
  const payload = protocol.textPayload('agreed', null, reply('bob', 'original-message', 'Shall we meet at noon?'));
  const ciphertext = await protocol.encryptForRecipient(alice, protocol.encodePayload(payload), 7, 'reply-1', bob);
  const wire = Buffer.from(ciphertext, 'base64').toString('utf8');
  for (const secret of ['original-message', 'noon', 'reply', '"bob"']) assert.ok(!wire.includes(secret), secret);
  const message = { chat_id: 7, client_message_id: 'reply-1', sender_public_id: 'alice', ciphertext };
  assert.deepEqual(plain(protocol.decodePayload(await protocol.decryptMessage(bob, message, alice))), plain(payload));
  await assert.rejects(protocol.decryptMessage(bob, { ...message, chat_id: 8 }, alice));
});

let deliveryCounter = 0;
function replyClient() {
  const app = client();
  app.run(`globalThis.persisted = []; globalThis.acked = []; globalThis.queued = [];
    chats.push({ id: 8, title: 'other', chat_type: 'group', participants: chats[0].participants });
    persistHistoryEntry = async (chatId, entry) => { persisted.push([chatId, JSON.parse(JSON.stringify(entry))]); };
    queueDelivery = message => { acked.push(message.client_message_id); };
    decryptMessage = async message => JSON.stringify(message.testPayload);
    assertTrustedPeer = async () => {};
    flushOutbox = async () => {};
    renderOutbox = async () => {};
    queueEncryptedMessage = async (chat, recipients, messageId, payload, { onQueued } = {}) => {
      if (globalThis.failQueue) throw new ClientError('The encrypted local outbox is full.');
      queued.push({ chat: chat.id, recipients: recipients.map(peer => peer.public_id), messageId, payload });
      onQueued?.();
      await storeOutgoing({ chatId: chat.id, messageId, payload, createdAt: Date.now(),
        envelopes: recipients.map(peer => ({ recipient_public_id: peer.public_id, ciphertext: 'opaque' })) });
    };`);
  return app;
}

async function receive(app, sender, clientMessageId, payload, chatId = 7) {
  const message = { chat_id: chatId, sender_public_id: sender, client_message_id: clientMessageId,
    delivery_id: (++deliveryCounter).toString(16).padStart(32, '0'), created_at: '2026-11-01T00:00:00Z',
    testPayload: payload };
  app.run('value => { globalThis.incomingMessage = value; }')(message);
  await app.run('processMessages([incomingMessage])');
}
const text = (body, replyTo) => (replyTo ? { v: 1, type: 'text', text: body, reply: replyTo } : { v: 1, type: 'text', text: body });
const fileRef = (id, name, mime, replyTo) => ({ v: 1, type: 'attachment-ref', text: '', name, mime, size: 3,
  media_id: `${id}.media`, ...(replyTo ? { reply: replyTo } : {}) });
const incomingId = (sender, id, chatId = 7) => `incoming:${JSON.stringify([chatId, sender, id])}`;
const rows = app => app.nodes.get('#message-list').children;
const rowFor = (app, id) => rows(app).find(row => row.messageEntry.id === id);
const quoteOf = row => row.replyQuote && {
  name: row.replyQuote.replyName.textContent, text: row.replyQuote.replyText.hidden ? null : row.replyQuote.replyText.textContent,
  note: row.replyQuote.replyNote.hidden ? null : row.replyQuote.replyNote.textContent,
  disabled: row.replyQuote.attributes.get('aria-disabled') };
const entry = (app, id) => `messagesByChat.get(7).find(item => item.id === ${JSON.stringify(id)})`;
async function send(app, body) {
  app.run(`value => { elements.messageInput.value = value; }`)(body);
  await app.nodes.get('#message-form').emit('submit', { preventDefault() {} });
}

test('replying to a received message previews it, sends the reference and quotes it in the new message', async () => {
  const app = replyClient();
  await receive(app, 'peer-a', 'm1', text('  Lunch\nat   noon?  '));
  const original = rowFor(app, incomingId('peer-a', 'm1'));
  assert.equal(original.replyAction.attributes.get('aria-label'), 'Reply');
  original.replyAction.emit('click', { stopPropagation() {} });
  assert.equal(app.nodes.get('#reply-preview').hidden, false);
  assert.equal(app.nodes.get('#message-form').attributes.get('has-reply'), true);
  assert.equal(app.nodes.get('#reply-preview-name').textContent, 'Alex');
  assert.equal(app.nodes.get('#reply-preview-excerpt').textContent, 'Lunch at noon?');
  assert.equal(app.document.activeElement, app.nodes.get('#message-input'));
  await send(app, 'Yes!');
  const [sent] = plain(app.run('queued'));
  assert.deepEqual(sent.payload, { v: 1, type: 'text', text: 'Yes!', reply: reply('peer-a', 'm1', 'Lunch at noon?') });
  assert.deepEqual(sent.recipients, ['peer-a', 'peer-b']);
  // Cleared only once the reply is queued; the new message quotes the original.
  assert.equal(app.nodes.get('#reply-preview').hidden, true);
  assert.equal(app.run('replyDrafts.has(7)'), false);
  const replyRow = rowFor(app, `outgoing:${sent.messageId}`);
  assert.deepEqual(quoteOf(replyRow), { name: 'Alex', text: 'Lunch at noon?', note: null, disabled: 'false' });
  assert.equal(replyRow.replyQuote.parent, replyRow.messageBubble);
  assert.equal(replyRow.messageBubble.children.indexOf(replyRow.replyQuote) < replyRow.messageBubble.children.indexOf(replyRow.messageContent), true);
  assert.equal(replyRow.messageBubble.attributes.get('has-reply'), true);
});

test('attachment messages can be replied to and can carry replies; quotes never nest', async () => {
  const app = replyClient();
  await receive(app, 'peer-a', 'img', fileRef('img', 'cat.png', 'image/png'));
  await receive(app, 'peer-b', 'r1', text('so cute', reply('peer-a', 'img', null)));
  await receive(app, 'peer-a', 'r2', fileRef('r2', 'more.pdf', 'application/pdf', reply('peer-b', 'r1', 'so cute')));
  assert.deepEqual(quoteOf(rowFor(app, incomingId('peer-b', 'r1'))), { name: 'Alex', text: 'Image', note: null, disabled: 'false' });
  // A reply to a reply quotes only that message's own text.
  const nested = rowFor(app, incomingId('peer-a', 'r2'));
  assert.deepEqual(quoteOf(nested), { name: '<b>Alex</b>', text: 'so cute', note: null, disabled: 'false' });
  assert.equal(nested.replyQuote.children.length, 3);
  // Replying to a file shows its kind, never its name, and works with a new attachment.
  await app.run(`startReply(7, ${entry(app, incomingId('peer-a', 'r2'))})`);
  assert.equal(app.nodes.get('#reply-preview-excerpt').textContent, 'File');
  app.run(`selectedFile = { name: 'photo.jpg', type: 'image/jpeg', size: 3 }; selectChat(7);`);
  await send(app, '');
  const [sent] = plain(app.run('queued'));
  assert.equal(sent.payload.type, 'attachment-ref');
  assert.deepEqual(sent.payload.reply, reply('peer-a', 'r2', null));
  assert.equal(JSON.stringify(sent.payload.reply).includes('more.pdf'), false);
});

test('missing and late originals show the sender quote until the real message arrives', async () => {
  const app = replyClient();
  // The reply arrives first, with a misleading excerpt.
  await receive(app, 'peer-b', 'r1', text('agreed', reply('peer-a', 'late', 'I owe you 100 dollars')));
  const row = rowFor(app, incomingId('peer-b', 'r1'));
  assert.deepEqual(quoteOf(row), { name: 'Alex', text: 'I owe you 100 dollars',
    note: 'Quoted by sender · original not on this device', disabled: 'true' });
  assert.match(row.replyQuote.attributes.get('aria-label'), /Quoted by sender/);
  // Clicking an unavailable quote does nothing.
  row.replyQuote.emit('click', { stopPropagation() {} });
  await receive(app, 'peer-a', 'late', text('See you at noon'));
  assert.deepEqual(quoteOf(row), { name: 'Alex', text: 'See you at noon', note: null, disabled: 'false' });
  // No excerpt and no original: a neutral placeholder; the reply itself still shows.
  await receive(app, 'peer-a', 'r2', text('ok', reply('peer-b', 'never', null)));
  assert.deepEqual(quoteOf(rowFor(app, incomingId('peer-a', 'r2'))), { name: '<b>Alex</b>', text: null,
    note: 'Original message not on this device', disabled: 'true' });
  assert.equal(rowFor(app, incomingId('peer-a', 'r2')).messageContent.textContent, 'ok');
});

test('forged authors, other chats and markup never resolve or render as HTML', async () => {
  const app = replyClient();
  await receive(app, 'peer-a', 'm1', text('real text'));
  // Same message ID claimed for another author, and a reference from another chat.
  await receive(app, 'peer-b', 'forged', text('quote', reply('peer-b', 'm1', 'peer-a never said this')));
  await receive(app, 'peer-b', 'cross', text('quote', reply('peer-a', 'm1', '<img src=x onerror=alert(1)>')), 8);
  assert.equal(quoteOf(rowFor(app, incomingId('peer-b', 'forged'))).disabled, 'true');
  app.run('selectChat(8)');
  const cross = rowFor(app, incomingId('peer-b', 'cross', 8));
  assert.deepEqual(quoteOf(cross), { name: 'Alex', text: '<img src=x onerror=alert(1)>',
    note: 'Quoted by sender · original not on this device', disabled: 'true' });
  assert.equal(cross.replyQuote.replyText.children.length, 0, 'excerpt stays text');
  // Malformed replies are retained unacknowledged and never displayed.
  app.run('selectChat(7)');
  const theirs = () => rows(app).filter(row => row.messageEntry.kind === 'theirs').length;
  const before = theirs();
  for (const [id, bad] of [['nested', { ...reply('peer-a', 'm1', 'x'), reply: reply('peer-a', 'm1', 'y') }],
    ['long', reply('peer-a', 'm1', 'x'.repeat(201))], ['bidi', reply('peer-a', 'm1', 'a\u202Eb')]]) {
    await receive(app, 'peer-b', id, text('bad', bad));
  }
  assert.equal(theirs(), before);
  const acked = new Set(app.run('acked'));
  for (const id of ['nested', 'long', 'bidi']) assert.equal(acked.has(id), false, id);
  assert.ok(rows(app).some(row => /Message retained for retry/.test(row.messageContent.textContent)));
});

test('duplicates, group participants and reloads keep one reply that resolves from history', async () => {
  const app = replyClient();
  await receive(app, 'peer-b', 'r1', text('me too', reply('peer-a', 'm1', 'pizza?')));
  await receive(app, 'peer-b', 'r1', text('me too', reply('peer-a', 'm1', 'pizza?'))); // Redelivered.
  await receive(app, 'peer-a', 'm1', text('pizza?'));
  await app.run(`startReply(7, ${entry(app, incomingId('peer-b', 'r1'))})`);
  await send(app, 'same');
  assert.equal(rows(app).filter(row => row.messageEntry.id === incomingId('peer-b', 'r1')).length, 1);
  const records = app.run('JSON.stringify(persisted)');
  const restored = replyClient();
  await restored.run(`(async () => { messagesByChat.clear();
    for (const [chatId, item] of ${records}.reverse()) await appendMessage(chatId, item, false, false);
    renderMessages(); })()`);
  assert.deepEqual(quoteOf(rowFor(restored, incomingId('peer-b', 'r1'))), { name: 'Alex', text: 'pizza?', note: null, disabled: 'false' });
  const own = rows(restored).find(row => row.messageEntry.kind === 'mine');
  assert.deepEqual(quoteOf(own), { name: '<b>Alex</b>', text: 'me too', note: null, disabled: 'false' });
});

test('a failed handoff keeps the text and reply; drafts are per chat and can be cancelled', async () => {
  const app = replyClient();
  await receive(app, 'peer-a', 'm1', text('question'));
  await app.run(`startReply(7, ${entry(app, incomingId('peer-a', 'm1'))})`);
  app.run('globalThis.failQueue = true;');
  await send(app, 'answer');
  assert.match(app.nodes.get('#composer-error').textContent, /outbox is full/);
  assert.equal(app.nodes.get('#message-input').value, 'answer');
  assert.equal(app.nodes.get('#reply-preview').hidden, false);
  assert.equal(app.run('replyDrafts.get(7).target'), 'm1');
  // Switching chats hides this chat's reply and restores it on return.
  app.run('selectChat(8)');
  assert.equal(app.nodes.get('#reply-preview').hidden, true);
  app.run('selectChat(7)');
  assert.equal(app.nodes.get('#reply-preview').hidden, false);
  // Closed conversations hide the preview while keeping nothing sendable.
  app.run(`chats[0].closed_at = '2026-01-01T00:00:00Z'; selectChat(7);`);
  assert.equal(app.nodes.get('#reply-preview').hidden, true);
  app.run(`chats[0].closed_at = null; selectChat(7);`);
  // Escape cancels unless another control already handled it; the button cancels too.
  const input = app.nodes.get('#message-input');
  input.emit('keydown', { key: 'Escape', defaultPrevented: true, preventDefault() {} });
  assert.equal(app.run('replyDrafts.has(7)'), true);
  input.emit('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(app.run('replyDrafts.has(7)'), false);
  assert.equal(app.nodes.get('#reply-preview').hidden, true);
  await app.run(`startReply(7, ${entry(app, incomingId('peer-a', 'm1'))})`);
  const tap = { preventDefault() { tap.prevented = true; } };
  app.nodes.get('#reply-cancel').emit('mousedown', tap);
  app.nodes.get('#reply-cancel').emit('click', {});
  assert.equal(tap.prevented, true);
  assert.equal(app.run('replyDrafts.has(7)'), false);
  app.run('globalThis.failQueue = false;');
  await send(app, 'answer');
  assert.equal(plain(app.run('queued'))[0].payload.reply, undefined);
});

test('the quote jumps to and highlights the original without opening details; touch uses the bar', async () => {
  const app = replyClient();
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-1', payload: { v: 1, type: 'text', text: 'mine' },
    createdAt: 1000, envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'opaque' }] })`);
  await receive(app, 'peer-a', 'r1', text('replying', reply('me', 'own-1', 'mine')));
  await app.run(`startReply(7, ${entry(app, incomingId('peer-a', 'r1'))})`);
  await send(app, 'back at you');
  const original = rowFor(app, 'outgoing:own-1');
  const scrolled = [];
  original.scrollIntoView = options => scrolled.push(options);
  const own = rows(app).find(row => row.messageEntry.kind === 'mine' && row.messageEntry.reply);
  assert.deepEqual(quoteOf(own), { name: 'Alex', text: 'replying', note: null, disabled: 'false' });
  // A sent message's quote is a button: it never opens message details.
  const shown = app.run('globalThis.detailsShown = 0; showMessageDetails = () => detailsShown++; 0');
  own.emit('click', { target: own.replyQuote });
  assert.equal(app.run('detailsShown'), shown);
  rowFor(app, incomingId('peer-a', 'r1')).replyQuote.emit('click', { stopPropagation() {} });
  assert.deepEqual(plain(scrolled), [{ block: 'center', behavior: 'smooth' }]);
  assert.equal(original.messageBubble.attributes.get('reply-highlight'), true);
  const timer = app.timers.at(-1);
  assert.equal(timer.delay, 1600);
  timer();
  assert.equal(original.messageBubble.attributes.get('reply-highlight'), false);
  // The reaction bar offers Reply for touch screens, where the hover button is hidden.
  const row = rowFor(app, incomingId('peer-a', 'r1'));
  row.reactionTrigger.emit('click', { detail: 1, stopPropagation() {} });
  const replyButton = app.run('reactionPicker.node').children.find(node => node.textContent === 'Reply');
  replyButton.emit('click', { stopPropagation() {} });
  assert.equal(app.run('reactionPicker.host'), null);
  assert.equal(app.run('replyDrafts.get(7).target'), 'r1');
  // Closing the chat (applied through selectChat, as on refresh) hides actions and the pending reply.
  app.run(`chats[0].closed_at = '2026-01-01T00:00:00Z'; selectChat(7);`);
  assert.equal(row.replyAction.disabled, true);
  await app.run(`startReply(7, ${entry(app, incomingId('peer-a', 'r1'))})`);
  assert.equal(app.nodes.get('#reply-preview').hidden, true);
});

test('excerpts are short, single-line, control-free and never split characters', () => {
  const app = replyClient();
  app.run('value => { Intl.Segmenter = value; }')(Intl.Segmenter);
  const excerpt = value => app.run('value => replyExcerpt(value)')(value);
  assert.equal(excerpt(' a\n\tb\u202E c\u0000 '), 'a b c');
  assert.equal(excerpt('\n \u2066 '), null);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const long = excerpt(family.repeat(150));
  assert.ok(long.endsWith('…'));
  // Whole family emoji only, within the 200-unit bound.
  const kept = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(long.slice(0, -1))];
  assert.ok(kept.length > 0 && kept.every(part => part.segment === family));
  assert.ok(long.length <= 200);
  assert.doesNotThrow(() => protocol.textPayload('x', null, reply('a', 'b', long)));
  const words = excerpt('word '.repeat(80));
  assert.equal(words, `${'word '.repeat(20).trimEnd()}…`);
  assert.doesNotThrow(() => protocol.textPayload('x', null, reply('a', 'b', excerpt('é'.repeat(500)))));
});
