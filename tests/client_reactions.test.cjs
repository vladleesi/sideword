const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { client } = require('./client_dom.cjs');

const THUMBS = '\u{1F44D}', HEART = '❤️', JOY = '\u{1F602}', THINK = '\u{1F914}', CRY = '\u{1F622}';

function protocolModule() {
  const context = vm.createContext({ TextEncoder, TextDecoder, DOMException, crypto: webcrypto, btoa, atob });
  vm.runInContext(fs.readFileSync('app/static/client-protocol.js', 'utf8'), context);
  return vm.runInContext('SidewordProtocol', context);
}
const protocol = protocolModule();
const plain = value => JSON.parse(JSON.stringify(value));
const reaction = (targetAuthor, target, emoji, rev) => ({ v: 1, type: 'reaction', target_author: targetAuthor, target, emoji, rev });

test('reaction payloads accept exactly five emoji, removal and positive safe revisions', () => {
  assert.deepEqual([...protocol.REACTION_EMOJI], [THUMBS, HEART, JOY, THINK, CRY]);
  for (const emoji of [...protocol.REACTION_EMOJI, null]) {
    assert.deepEqual(plain(protocol.decodePayload(JSON.stringify(reaction('ab12cd34ef56', 'm-1_x', emoji, 1)))),
      reaction('ab12cd34ef56', 'm-1_x', emoji, 1));
  }
  assert.equal(protocol.reactionPayload('peer', 'm', null, Number.MAX_SAFE_INTEGER).rev, Number.MAX_SAFE_INTEGER);
  const invalid = [
    { emoji: '❤' }, { emoji: `${THUMBS}\u{1F3FD}` }, { emoji: '\u{1F525}' }, { emoji: '' }, { emoji: 1 },
    { emoji: undefined }, { rev: 0 }, { rev: -1 }, { rev: 1.5 }, { rev: '1' }, { rev: 2 ** 53 }, { rev: null },
    { target_author: '' }, { target_author: 'a:b' }, { target_author: 'x'.repeat(65) }, { target_author: 7 },
    { target: '' }, { target: '../m' }, { target: 'm\u0000' }, { target: 'x'.repeat(65) }, { target: ['m'] },
    { v: 2 }, { type: 'Reaction' },
  ];
  for (const change of invalid) {
    const payload = { ...reaction('peer', 'm', THUMBS, 1), ...change };
    assert.throws(() => protocol.validatePayload(payload), /Invalid or unsupported/, JSON.stringify(change));
  }
  // No caller-supplied reactor, chat or extra metadata: the reactor is the authenticated sender.
  for (const extra of [{ reactor: 'peer-b' }, { chat_id: 8 }, { remove: true }]) {
    assert.throws(() => protocol.validatePayload({ ...reaction('peer', 'm', THUMBS, 1), ...extra }), /Invalid/);
  }
  const { rev, ...missing } = reaction('peer', 'm', THUMBS, 1);
  assert.throws(() => protocol.validatePayload(missing), /Invalid/);
  assert.throws(() => protocol.decodePayload('{"v":1,"type":"reactions"}'), /Invalid or unsupported/);
});

test('reaction contents and targets exist only inside the authenticated per-recipient envelope', async () => {
  const identity = async publicId => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    return { publicId, privateKey: pair.privateKey, public_id: publicId, public_key: protocol.bytesToBase64(raw) };
  };
  const alice = await identity('alice'), bob = await identity('bob'), mallory = await identity('mallory');
  const plaintext = protocol.encodePayload(protocol.reactionPayload('bob', 'target-message', HEART, 3));
  const ciphertext = await protocol.encryptForRecipient(alice, plaintext, 7, 'reaction-op', bob);
  const wire = Buffer.from(ciphertext, 'base64').toString('utf8');
  for (const secret of ['target-message', 'reaction', '"bob"', HEART, 'rev']) assert.ok(!wire.includes(secret), secret);
  const message = { chat_id: 7, client_message_id: 'reaction-op', sender_public_id: 'alice', ciphertext };
  assert.deepEqual(plain(protocol.decodePayload(await protocol.decryptMessage(bob, message, alice))),
    reaction('bob', 'target-message', HEART, 3));
  // Moving it to another chat or claiming another sender fails authentication.
  await assert.rejects(protocol.decryptMessage(bob, { ...message, chat_id: 8 }, alice));
  await assert.rejects(protocol.decryptMessage(bob, { ...message, sender_public_id: 'mallory' }, mallory));
});

let deliveryCounter = 0;
function reactionClient() {
  const app = client();
  app.run(`globalThis.persisted = []; globalThis.acked = []; globalThis.queued = [];
    chats.push({ id: 8, title: 'other', chat_type: 'group', participants: chats[0].participants });
    persistHistoryEntry = async (chatId, entry) => {
      if (globalThis.failPersist) throw new ClientError('storage unavailable');
      persisted.push([chatId, JSON.parse(JSON.stringify(entry))]);
    };
    queueDelivery = message => { acked.push(message.client_message_id); };
    decryptMessage = async message => JSON.stringify(message.testPayload);
    assertTrustedPeer = async () => {};
    flushOutbox = async () => { if (globalThis.failFlush) throw new ClientError('Chat request failed (HTTP 503).'); };
    renderOutbox = async () => {};
    queueEncryptedMessage = async (chat, recipients, messageId, payload) => {
      queued.push({ chat: chat.id, recipients: recipients.map(peer => peer.public_id), messageId, payload });
      await storeOutgoing({ chatId: chat.id, messageId, payload, createdAt: Date.now(),
        envelopes: recipients.map(peer => ({ recipient_public_id: peer.public_id, ciphertext: 'opaque' })) });
    };`);
  return app;
}

async function receive(app, sender, clientMessageId, payload, chatId = 7) {
  app.context = app.context || {};
  const message = { chat_id: chatId, sender_public_id: sender, client_message_id: clientMessageId,
    delivery_id: (++deliveryCounter).toString(16).padStart(32, '0'), created_at: '2026-11-01T00:00:00Z',
    testPayload: payload };
  app.run('value => { globalThis.incomingMessage = value; }')(message);
  await app.run('processMessages([incomingMessage])');
}
const text = body => ({ v: 1, type: 'text', text: body });
const rowFor = (app, id) => app.nodes.get('#message-list').children.find(row => row.messageEntry.id === id);
const incomingId = (sender, id, chatId = 7) => `incoming:${JSON.stringify([chatId, sender, id])}`;
const chips = row => row.reactionRow.hidden ? [] : row.reactionRow.children.map(chip => ({
  text: chip.textContent, pressed: chip.attributes.get('aria-pressed'), label: chip.attributes.get('aria-label'),
  unsent: chip.className.includes('reaction-unsent') }));
const summary = row => chips(row).map(chip => `${chip.text}${chip.pressed === 'true' ? '*' : ''}`);
// ACK requests may repeat for one delivery; what matters is which deliveries are acknowledged.
const acked = app => [...new Set(app.run('acked'))];
const persistedReactions = app => app.run('persisted.filter(([, entry]) => entry.kind === "reaction").length');

test('group reactions are grouped per emoji with one active reaction per participant', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('lunch?'));
  await receive(app, 'peer-a', 'r1', reaction('peer-a', 'm1', THUMBS, 1));
  await receive(app, 'peer-b', 'r2', reaction('peer-a', 'm1', THUMBS, 1));
  await receive(app, 'peer-b', 'r3', reaction('peer-a', 'm1', JOY, 2)); // Replaces peer-b's 👍.
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  assert.deepEqual(summary(row), [`${THUMBS}1`, `${JOY}1`]);
  assert.match(chips(row)[0].label, /^👍 1: Alex$/u);
  assert.match(chips(row)[1].label, /^😂 1: <b>Alex<\/b>$/u, 'names stay text');
  // Reaction messages never enter the visible timeline.
  assert.equal(app.nodes.get('#message-list').children.length, 1);
  assert.deepEqual(acked(app), ['m1', 'r1', 'r2', 'r3']);
  assert.equal(row.messageBubble.attributes.get('has-reactions'), true);
});

test('own toggles queue encrypted set, remove and replace operations with increasing revisions', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  await app.run(`toggleReaction(7, messagesByChat.get(7)[0], "${THUMBS}")`);
  assert.deepEqual(summary(row), [`${THUMBS}1*`]);
  assert.equal(chips(row)[0].label, `${THUMBS} 1: You`);
  await app.run(`toggleReaction(7, messagesByChat.get(7)[0], "${THUMBS}")`); // Same emoji removes it.
  assert.deepEqual(summary(row), []);
  assert.equal(row.reactionRow.hidden, true);
  // Rapid taps are serialized: each takes the next revision.
  await app.run(`Promise.all([toggleReaction(7, messagesByChat.get(7)[0], "${HEART}"),
    toggleReaction(7, messagesByChat.get(7)[0], "${CRY}")])`);
  assert.deepEqual(summary(row), [`${CRY}1*`]);
  const queued = JSON.parse(JSON.stringify(app.run('queued')));
  assert.deepEqual(queued.map(item => [item.payload.emoji, item.payload.rev]),
    [[THUMBS, 1], [null, 2], [HEART, 3], [CRY, 4]]);
  for (const item of queued) {
    assert.equal(item.chat, 7);
    assert.deepEqual(item.recipients, ['peer-a', 'peer-b']);
    assert.deepEqual(Object.keys(item.payload), ['v', 'type', 'target_author', 'target', 'emoji', 'rev']);
    assert.equal(item.payload.target_author, 'peer-a');
    assert.equal(item.payload.target, 'm1');
  }
  assert.equal(new Set(queued.map(item => item.messageId)).size, 4);
});

test('stale, duplicate and reordered operations cannot restore a removed reaction', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  await receive(app, 'peer-b', 'r3', reaction('peer-a', 'm1', null, 3)); // Removal arrives first.
  await receive(app, 'peer-b', 'r2', reaction('peer-a', 'm1', HEART, 2));
  await receive(app, 'peer-b', 'r1', reaction('peer-a', 'm1', THUMBS, 1));
  assert.deepEqual(summary(row), []);
  await receive(app, 'peer-b', 'r4', reaction('peer-a', 'm1', JOY, 4));
  await receive(app, 'peer-b', 'r4-retry', reaction('peer-a', 'm1', JOY, 4)); // Retried under a new ID.
  await receive(app, 'peer-b', 'r4', reaction('peer-a', 'm1', JOY, 4)); // Redelivered.
  assert.deepEqual(summary(row), [`${JOY}1`]);
  // Only state-advancing operations are stored; every delivery is still acknowledged.
  assert.equal(persistedReactions(app), 2);
  assert.deepEqual(acked(app), ['m1', 'r3', 'r2', 'r1', 'r4', 'r4-retry']);
});

test('conflicting equal revisions resolve the same way in any arrival order', async () => {
  const states = [];
  for (const order of [[HEART, THINK], [THINK, HEART]]) {
    const app = reactionClient();
    await receive(app, 'peer-a', 'm1', text('hello'));
    for (const [index, emoji] of order.entries()) await receive(app, 'peer-b', `c${index}`, reaction('peer-a', 'm1', emoji, 5));
    states.push(summary(rowFor(app, incomingId('peer-a', 'm1'))));
  }
  assert.deepEqual(states[0], states[1]);
  assert.equal(states[0].length, 1);
});

test('reactions to missing targets wait for the message and stay scoped to their chat and author', async () => {
  const app = reactionClient();
  await receive(app, 'peer-b', 'early', reaction('peer-a', 'later', HEART, 1));
  // The same target in another chat, and the same message ID claimed for another author.
  await receive(app, 'peer-b', 'cross', reaction('peer-a', 'later', THUMBS, 9), 8);
  await receive(app, 'peer-b', 'wrong-author', reaction('peer-b', 'later', CRY, 9));
  await receive(app, 'peer-a', 'later', text('arrives late'));
  assert.deepEqual(summary(rowFor(app, incomingId('peer-a', 'later'))), [`${HEART}1`]);
  assert.equal(app.run(`reactionsByChat.get(8).has(${JSON.stringify(incomingId('peer-a', 'later', 8))})`), true);
});

test('reactions to my own messages render and survive a reload from encrypted history', async () => {
  const app = reactionClient();
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-1', payload: { v: 1, type: 'text', text: 'mine' },
    createdAt: 1000, envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'opaque' }] })`);
  await receive(app, 'peer-a', 'r1', reaction('me', 'own-1', JOY, 1));
  await receive(app, 'peer-b', 'r2', reaction('me', 'own-1', JOY, 1));
  await receive(app, 'peer-a', 'm2', text('theirs'));
  await app.run(`toggleReaction(7, messagesByChat.get(7).find(entry => entry.id === 'outgoing:own-1'), "${JOY}")`);
  await receive(app, 'peer-b', 'r3', reaction('peer-a', 'm2', THINK, 1));
  // Equal revision, but 👍 loses the deterministic tie-break against 😂: not stored.
  await receive(app, 'peer-a', 'r0', reaction('me', 'own-1', THUMBS, 1));
  const own = summary(rowFor(app, 'outgoing:own-1'));
  assert.deepEqual(own, [`${JOY}3*`]);
  const records = app.run('JSON.stringify(persisted)');
  // A fresh client restores the same aggregate state from history records in reverse order.
  const restored = reactionClient();
  await restored.run(`(async () => { messagesByChat.clear();
    for (const [chatId, entry] of ${records}.reverse()) await appendMessage(chatId, entry, false, false);
    renderMessages(); })()`);
  assert.deepEqual(summary(rowFor(restored, 'outgoing:own-1')), own);
  assert.deepEqual(summary(rowFor(restored, incomingId('peer-a', 'm2'))), [`${THINK}1`]);
  // The restored own revision continues the sequence.
  await restored.run(`toggleReaction(7, messagesByChat.get(7).find(entry => entry.id === 'outgoing:own-1'), "${JOY}")`);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.run('queued[0].payload'))), reaction('me', 'own-1', null, 2));
  assert.deepEqual(summary(rowFor(restored, 'outgoing:own-1')), [`${JOY}2`]);
});

test('malicious or unsupported reactions are retained unacknowledged and change nothing', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  for (const [id, payload] of [
    ['spoof', { ...reaction('peer-a', 'm1', THUMBS, 1), reactor: 'peer-b' }],
    ['emoji', reaction('peer-a', 'm1', '\u{1F525}', 1)],
    ['rev', reaction('peer-a', 'm1', THUMBS, 0)],
    ['target', reaction('peer-a', '<img src=x>', THUMBS, 1)],
  ]) await receive(app, 'peer-b', id, payload);
  assert.deepEqual(summary(row), []);
  assert.deepEqual(acked(app), ['m1']);
  assert.equal(persistedReactions(app), 0);
  assert.ok(app.nodes.get('#message-list').children.some(node => /Message retained for retry/.test(node.messageContent.textContent)));
  // Persist before ACK: a storage failure keeps the reaction queued and unapplied.
  app.run('globalThis.failPersist = true;');
  await receive(app, 'peer-b', 'unsaved', reaction('peer-a', 'm1', THUMBS, 1));
  assert.deepEqual(summary(row), []);
  assert.equal(app.run('acked.includes("unsaved")'), false);
  app.run('globalThis.failPersist = false; failedMessageRetries.clear();');
  await receive(app, 'peer-b', 'unsaved', reaction('peer-a', 'm1', THUMBS, 1));
  assert.deepEqual(summary(row), [`${THUMBS}1`]);
  assert.equal(app.run('acked.includes("unsaved")'), true);
});

test('a reaction that fails to send stays visible as unsent and appears in pending sends', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  app.run('globalThis.failFlush = true;');
  await app.run(`toggleReaction(7, messagesByChat.get(7)[0], "${HEART}")`);
  assert.match(app.nodes.get('#error-message').textContent, /HTTP 503/);
  const messageId = app.run('queued[0].messageId');
  await app.run(`appendMessage(7, { id: 'send_failed:${messageId}', kind: 'send_failed', clientMessageId: '${messageId}' })`);
  const [chip] = chips(rowFor(app, incomingId('peer-a', 'm1')));
  assert.equal(chip.unsent, true);
  assert.match(chip.label, /not sent yet/);
  assert.match(fs.readFileSync('app/static/client.js', 'utf8'), /payload\.type === "reaction" \? "Reaction"/);
});

test('picker and chips work by keyboard and touch without opening message details', async () => {
  const app = reactionClient();
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-1', payload: { v: 1, type: 'text', text: 'mine' },
    createdAt: 1000, envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'opaque' }] })`);
  const row = rowFor(app, 'outgoing:own-1');
  const trigger = row.reactionTrigger;
  assert.equal(trigger.attributes.get('aria-label'), 'Add reaction');
  assert.equal(trigger.disabled, false);
  // Tapping while typing keeps the composer (and mobile keyboard) focused.
  app.nodes.get('#message-input').focus();
  const tap = { preventDefault() { tap.defaultPrevented = true; } };
  trigger.emit('mousedown', tap);
  assert.equal(tap.defaultPrevented, true);
  const event = { detail: 0, stopPropagation() {} };
  trigger.emit('click', event);
  const picker = app.run('reactionPicker');
  assert.equal(picker.host, row);
  // A floating bar outside the bubble: opening it never resizes the message.
  assert.equal(picker.node.parent, app.nodes.get('#conversation'));
  assert.equal(picker.node.hidden, false);
  assert.ok(!row.messageBubble.children.includes(picker.node));
  assert.equal(row.messageBubble.attributes.get('has-reactions'), undefined);
  assert.equal(trigger.attributes.get('aria-expanded'), 'true');
  assert.deepEqual([...picker.buttons].map(button => button.textContent), [THUMBS, HEART, JOY, THINK, CRY]);
  assert.equal(app.document.activeElement, picker.buttons[0]);
  picker.node.emit('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(app.document.activeElement, picker.buttons[4]);
  picker.node.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(picker.host, null);
  assert.equal(picker.node.hidden, true);
  assert.equal(app.document.activeElement, trigger);
  assert.equal(trigger.attributes.get('aria-expanded'), 'false');
  trigger.emit('click', event);
  picker.buttons[1].emit('click', event);
  await app.run('reactionQueue');
  assert.deepEqual(summary(row), [`${HEART}1*`]);
  // Chips toggle the reaction; buttons inside a sent message never open its details.
  const chip = row.reactionRow.children[0];
  const shown = app.run('globalThis.detailsShown = 0; showMessageDetails = () => detailsShown++; 0');
  row.emit('click', { target: chip });
  assert.equal(app.run('detailsShown'), shown);
  chip.emit('click', event);
  await app.run('reactionQueue');
  assert.deepEqual(summary(row), []);
  // Outside taps and chat switches close the picker.
  trigger.emit('click', { detail: 1, stopPropagation() {} });
  app.documentEvents.get('pointerdown')({ target: app.nodes.get('#message-input') });
  assert.equal(app.run('reactionPicker.host'), null);
  trigger.emit('click', { detail: 1, stopPropagation() {} });
  app.run('selectChat(8)');
  assert.equal(app.run('reactionPicker.host'), null);
});

test('reactions are disabled where sending is blocked and labels stay bounded in large groups', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  const participants = Array.from({ length: 14 }, (_, index) => ({ public_id: `p${index}`, display_name: `P${index}` }));
  app.run(`value => { chats[0].participants.push(...value); }`)(participants);
  for (const [index] of participants.entries()) await receive(app, `p${index}`, `x${index}`, reaction('peer-a', 'm1', THUMBS, 1));
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  assert.match(chips(row)[0].label, /^👍 14: P0, P1, .*P9 and 4 more$/u);
  app.run(`chats[0].closed_at = '2026-01-01T00:00:00Z'; renderMessages();`);
  assert.equal(row.reactionTrigger.disabled, true);
  assert.equal(row.reactionRow.children[0].disabled, true);
  await app.run(`toggleReaction(7, messagesByChat.get(7)[0], "${THUMBS}")`);
  assert.equal(app.run('queued.length'), 0);
});

test('the picker sits beside the message, falls back above it when narrow and follows scrolling', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-1', payload: { v: 1, type: 'text', text: 'mine' },
    createdAt: 1000, envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'opaque' }] })`);
  const list = app.nodes.get('#message-list');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  list.rect = rect(0, 0, 800, 600);
  const theirs = rowFor(app, incomingId('peer-a', 'm1'));
  const mine = rowFor(app, 'outgoing:own-1');
  theirs.reactionTrigger.rect = rect(300, 200, 30, 30);
  mine.reactionTrigger.rect = rect(500, 300, 30, 30);
  const open = row => row.reactionTrigger.emit('click', { detail: 1, stopPropagation() {} });
  open(theirs);
  const picker = app.run('reactionPicker');
  Object.assign(picker.node, { offsetWidth: 200, offsetHeight: 44 });
  app.run('positionReactionPicker()');
  // Received: to the right of the trigger, vertically centred on it.
  assert.deepEqual([picker.node.style.left, picker.node.style.top], ['336px', '193px']);
  open(mine);
  // Sent: to the left of its trigger, growing away from the bubble.
  assert.deepEqual([picker.node.style.left, picker.node.style.top], ['294px', '293px']);
  assert.equal(picker.node.attributes.get('from-mine'), true);
  // Too narrow beside it (phones): above the trigger, kept inside the list.
  list.rect = rect(0, 0, 360, 600);
  mine.reactionTrigger.rect = rect(120, 300, 30, 30);
  app.run('positionReactionPicker()');
  assert.deepEqual([picker.node.style.left, picker.node.style.top], ['6px', '250px']);
  // Scrolling repositions it and closes it once the message leaves the list.
  mine.reactionTrigger.rect = rect(120, 900, 30, 30);
  list.emit('scroll');
  assert.equal(picker.host, null);
  // Tab leaves through the trigger, keeping reading order.
  open(theirs);
  picker.node.emit('keydown', { key: 'Tab' });
  assert.equal(picker.host, null);
  assert.equal(app.document.activeElement, theirs.reactionTrigger);
});

test('chip updates happen in place and only layout changes animate', async () => {
  const app = reactionClient();
  await receive(app, 'peer-a', 'm1', text('hello'));
  const row = rowFor(app, incomingId('peer-a', 'm1'));
  const animations = [];
  row.messageBubble.animate = (frames, timing) => animations.push(['bubble', timing.duration]);
  row.messageBubble.getAnimations = () => [];
  row.messageBubble.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 });
  app.run('window.matchMedia = () => ({ matches: false });');
  await receive(app, 'peer-a', 'r1', reaction('peer-a', 'm1', THUMBS, 1));
  const chip = row.reactionRow.children[0];
  assert.equal(animations.length, 0, 'unchanged size: nothing to ease');
  // A count change reuses the chip and keeps keyboard focus on it, without animating.
  chip.focus();
  await receive(app, 'peer-b', 'r2', reaction('peer-a', 'm1', THUMBS, 1));
  assert.equal(row.reactionRow.children[0], chip);
  assert.equal(chip.textContent, `${THUMBS}2`);
  assert.equal(app.document.activeElement, chip);
  assert.equal(animations.length, 0);
  // A new chip that changes the bubble size eases the bubble and grows the chip in.
  const grown = [];
  const createElement = app.document.createElement;
  app.document.createElement = tag => {
    const node = createElement(tag);
    node.animate = (frames, timing) => grown.push([frames[0].opacity, timing.duration]);
    return node;
  };
  // Geometry follows the chips actually in the bubble.
  row.messageBubble.getBoundingClientRect = () => {
    const height = 40 + 10 * row.reactionRow.children.length;
    return { left: 0, top: 0, right: 100, bottom: height, width: 100, height };
  };
  await receive(app, 'peer-b', 'r3', reaction('peer-a', 'm1', HEART, 2));
  app.document.createElement = createElement;
  assert.deepEqual(animations, [['bubble', 160]]);
  assert.deepEqual(grown, [[0, 160]]);
  assert.equal(row.reactionRow.children[0], chip, 'existing chips are kept');
  // Removing the focused chip keeps focus on the message's reaction control.
  chip.focus();
  await receive(app, 'peer-a', 'r4', reaction('peer-a', 'm1', null, 2));
  await receive(app, 'peer-b', 'r5', reaction('peer-a', 'm1', HEART, 3));
  assert.deepEqual(summary(row), [`${HEART}1`]);
  assert.equal(app.document.activeElement, row.reactionTrigger);
  // With reduced motion nothing animates.
  app.run('window.matchMedia = () => ({ matches: true });');
  animations.length = 0;
  await receive(app, 'peer-a', 'r6', reaction('peer-a', 'm1', CRY, 3));
  assert.equal(animations.length, 0);
});
