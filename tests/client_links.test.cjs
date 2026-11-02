const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { client } = require('./client_dom.cjs');

const source = fs.readFileSync('app/static/client-links.js', 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const links = context.SidewordLinks;
const found = text => Array.from(links.findLinks(text), link => link.text);

test('detects multiple HTTP(S) links and keeps surrounding punctuation outside them', () => {
  const text = 'See https://example.com/a_(b)), (http://example.org/x?y=1#z). Then "https://a.example/path", end!';
  assert.deepEqual(found(text),
    ['https://example.com/a_(b)', 'http://example.org/x?y=1#z', 'https://a.example/path']);
  for (const link of links.findLinks(text)) assert.equal(text.slice(link.start, link.end), link.text);
  assert.deepEqual(found('<https://example.com/a> [https://example.com/b] https://example.com/c…'),
    ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  assert.deepEqual(found('列表：https://example.com/页面。下一句'), ['https://example.com/页面']);
  assert.equal(links.findLinks('HTTPS://EXAMPLE.COM:8443/Path')[0].href, 'https://example.com:8443/Path');
});

test('rejects dangerous schemes, schemeless text and links glued to words', () => {
  for (const text of ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', 'data:text/html,<script>x</script>',
    'file:///etc/passwd', 'blob:null/uuid', 'vbscript:msgbox(1)', 'javascript://example.com/%0aalert(1)',
    'https:example.com', 'example.com', 'www.example.com', 'foohttps://example.com', 'ftp://example.com']) {
    assert.deepEqual(found(text), [], text);
  }
  // An HTTP(S) URL after another scheme is linked only as itself; the outer scheme is never the target.
  const embedded = links.findLinks('javascript:https://example.com data:,https://example.org blob:https://example.net/id');
  assert.deepEqual(Array.from(embedded, link => link.href),
    ['https://example.com/', 'https://example.org/', 'https://example.net/id']);
});

test('ignores malformed hosts and non-string values', () => {
  for (const text of ['https://', 'https://.', 'https://..', 'http://[bad', 'https://exa mple.com',
    'https://single-label', 'https:// example.com', 'https://%zz.com', '\u0000https://\u0000']) {
    assert.deepEqual(found(text), [], JSON.stringify(text));
  }
  for (const value of [null, undefined, 7, {}]) assert.equal(links.findLinks(value).length, 0);
  assert.deepEqual(found('http://localhost:8000/client https://[::1]:8443/ http://192.0.2.1/'),
    ['http://localhost:8000/client', 'https://[::1]:8443/', 'http://192.0.2.1/']);
});

test('shows Unicode hosts for inspection and flags lookalike or deceptive hosts', () => {
  const [idn] = links.findLinks('https://пример.рф/путь');
  assert.equal(idn.displayHost, 'пример.рф');
  assert.equal(idn.host, 'xn--e1afmkfd.xn--p1ai');
  assert.equal(idn.internationalized, true);
  assert.deepEqual([...idn.warnings], []);
  assert.deepEqual([...links.findLinks('https://bücher.example')[0].warnings], []);
  assert.deepEqual([...links.findLinks('https://pаypal.com')[0].warnings], ['Mixes writing systems']);
  assert.deepEqual([...links.findLinks('https://аррӏе.com')[0].warnings], ['Uses letters that look Latin']);
  const credentials = links.findLinks('https://bank.example@attacker.example/login')[0];
  assert.equal(credentials.host, 'attacker.example');
  assert.deepEqual([...credentials.warnings], ['Text before @ is not the site']);
  // Bidi overrides and zero-width characters end a link instead of hiding part of it.
  assert.deepEqual(found('https://example.com/\u202Egpj.exe https://example.org\u200B/x'),
    ['https://example.com/', 'https://example.org']);
  // A host that does not parse back to the same ASCII form is shown in ASCII.
  assert.equal(links.findLinks('https://%65xample.com/')[0].displayHost, 'example.com');
});

test('bounds very long URLs, link counts and display text', () => {
  const prefix = 'https://example.com/';
  const exact = prefix + 'a'.repeat(links.MAX_URL_LENGTH - prefix.length);
  assert.deepEqual(found(exact), [exact]);
  assert.deepEqual(found(exact + 'a'), []);
  const many = Array.from({ length: 150 }, (_, index) => `https://e${index}.example`).join(' ');
  assert.equal(links.findLinks(many).length, links.MAX_LINKS);
  const started = performance.now();
  for (const text of ['https://'.repeat(2000), `https://example.com/${'('.repeat(15000)}`,
    `https://example.com/${')'.repeat(15000)}`, `${'.'.repeat(15000)}https://example.com`]) {
    links.findLinks(text);
  }
  assert.ok(performance.now() - started < 1000);
});

test('link detection performs no network or storage access', () => {
  assert.doesNotMatch(source, /fetch|XMLHttpRequest|WebSocket|sendBeacon|new Image|localStorage|indexedDB|innerHTML/);
  const clientSource = fs.readFileSync('app/static/client.js', 'utf8');
  assert.doesNotMatch(clientSource, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

function linkClient() {
  const app = client();
  app.run(`persistHistoryEntry = async () => {}; globalThis.apiCalls = [];
    api = async path => { apiCalls.push(path); return {}; };`);
  return app;
}
const anchorsOf = node => node.children.filter(child => child.tagName === 'a');

test('renders links as DOM anchors without interpreting HTML in message text', () => {
  const app = linkClient();
  const text = '<img src=x onerror=alert(1)> https://example.com/<script>alert(1)</script> and javascript:alert(1)';
  app.run(`messagesByChat.set(7, [{id: 'x', kind: 'theirs', senderPublicId: 'peer-a', text: ${JSON.stringify(text)},
    createdAt: 1000}]); renderMessages();`);
  const row = app.nodes.get('#message-list').children[0];
  assert.equal(row.messageContent.textContent, text);
  const [anchor] = anchorsOf(row.messageContent);
  assert.equal(anchorsOf(row.messageContent).length, 1);
  assert.equal(anchor.textContent, 'https://example.com/');
  assert.equal(anchor.href, 'https://example.com/');
  assert.equal(anchor.attributes.get('target'), '_blank');
  assert.equal(anchor.attributes.get('rel'), 'noopener noreferrer nofollow');
  assert.equal(anchor.attributes.get('referrerpolicy'), 'no-referrer');
  assert.equal(anchor.attributes.get('aria-describedby'), 'external-link-note');
  assert.match(anchor.title, /Opens in a new tab: https:\/\/example\.com\//);
  assert.equal(row.messageContent.children[0].tagName, '#text');
  assert.equal(row.messageContent.children[0].text, '<img src=x onerror=alert(1)> ');
  assert.equal(app.run('apiCalls.length'), 0);
});

// Sender-made previews: drafts fetch through the server; rendering uses only the message.
async function flush() {
  for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
}

const JPEG = fs.readFileSync('tests/fixtures/media/valid.jpg');
const PNG = fs.readFileSync('tests/fixtures/media/valid.png');

function previewClient({ available = true, mode = 'on', reply, wide = false } = {}) {
  const app = linkClient();
  app.run(`globalThis.created = []; globalThis.revoked = []; globalThis.reduced = []; globalThis.persisted = 0;
    globalThis.stored = new Map(); window.localStorage = {
      getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    persistHistoryEntry = async () => { persisted++; };
    globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options.type; } };
    globalThis.URL = class extends URL {
      static createObjectURL(blob) { created.push(blob); return 'blob:local-' + created.length; }
      static revokeObjectURL(url) { revoked.push(url); } };
    globalThis.SidewordMedia = { ...SidewordMedia,
      inspect: ${wide} ? () => ({ mime: 'image/jpeg', width: 1200, height: 630 }) : SidewordMedia.inspect,
      reduceImage: async (...args) => {
        reduced.push(args.slice(2).filter(value => typeof value !== 'function'));
        return args[3]() ? new Uint8Array(jpegBytes) : null; } };
    linkPreviewMode = ${JSON.stringify(mode)}; setLinkPreviewsAvailable(${available});`.replace('jpegBytes',
    JSON.stringify([...JPEG])));
  const response = reply || { title: '<img src=x onerror=alert(1)>', description: 'About <b>this</b>',
    site_name: 'Example Docs', url: null, final_host: 'www.example.org',
    image: { mime: 'image/png', width: 2, height: 2, data: PNG.toString('base64') } };
  app.run('value => { globalThis.previewReply = value; }')(response);
  app.run(`api = async (path, options) => {
    apiCalls.push([path, options?.method, options?.body]);
    const reply = typeof previewReply === 'function' ? await previewReply(options) : previewReply;
    if (reply instanceof Error) throw reply;
    return JSON.parse(JSON.stringify(reply)); };`);
  return app;
}

const calls = app => JSON.parse(JSON.stringify(app.run('apiCalls')));
const senderPreview = (overrides = {}) => ({ url: 'https://example.com/a', title: '<img src=x onerror=alert(1)>',
  description: 'About <b>this</b>', site_name: 'Example Docs', final_host: 'www.example.org',
  image: { mime: 'image/jpeg', data: JPEG.toString('base64') }, ...overrides });

function renderLink(app, text = 'see https://example.com/a', id = 'x', kind = 'theirs', preview = undefined) {
  app.run('value => { globalThis.nextEntry = value; }')({ id, kind, senderPublicId: 'peer-a', text,
    createdAt: Date.now(), ...(preview ? { preview } : {}) });
  app.run(`messagesByChat.set(7, [...(messagesByChat.get(7) || []), nextEntry]); renderMessages();`);
  return app.nodes.get('#message-list').children.find(row => row.messageEntry.id === id);
}

function typeDraft(app, value, inputType = 'insertText') {
  const input = app.nodes.get('#message-input');
  input.value = value;
  input.emit('input', { inputType });
}

test('received previews render from the message with no network request, even without server support', () => {
  const app = previewClient({ available: false });
  const row = renderLink(app, 'see https://example.com/a', 'x', 'theirs', senderPreview());
  assert.equal(calls(app).length, 0);
  const card = row.linkCard;
  assert.equal(card.tagName, 'a');
  assert.equal(card.href, 'https://example.com/a');
  assert.equal(card.attributes.get('rel'), 'noopener noreferrer nofollow');
  assert.equal(card.tabIndex, -1);
  const [body] = card.children;
  const [text, thumbnail] = body.children;
  assert.deepEqual(text.children.map(node => [node.className, node.textContent]), [
    ['link-card-source', 'example.com → www.example.org · Example Docs'],
    ['link-card-title', '<img src=x onerror=alert(1)>'], ['link-card-description', 'About <b>this</b>']]);
  assert.equal(thumbnail.className, 'link-card-thumbnail');
  assert.equal(thumbnail.src, 'blob:local-1');
  assert.equal(app.run('created[0].type'), 'image/jpeg');
});

test('a preview must describe the first previewable link, and unusable images are dropped', () => {
  const app = previewClient();
  const other = renderLink(app, 'see https://example.com/a', 'o', 'theirs', senderPreview({ url: 'https://evil.example/' }));
  assert.equal(other.linkCard, undefined);
  const http = renderLink(app, 'see http://example.com/a', 'h', 'theirs', senderPreview({ url: 'http://example.com/a' }));
  assert.equal(http.linkCard, undefined);
  const broken = renderLink(app, 'https://example.com/a', 'b', 'theirs',
    senderPreview({ image: { mime: 'image/jpeg', data: Buffer.from('not a jpeg').toString('base64') } }));
  assert.equal(broken.linkCard.children[0].children.length, 1); // Text only, no image.
  assert.equal(app.run('created.length'), 0);
  const plain = renderLink(app, 'see https://example.com/a', 'p');
  assert.equal(plain.linkCard, undefined);
  assert.deepEqual(plain.messageBubble.children, [plain.messageContent]);
});

test('wide preview images become a banner', () => {
  const app = previewClient({ wide: true });
  const row = renderLink(app, 'https://example.com/a', 'w', 'theirs', senderPreview());
  const [banner, body] = row.linkCard.children;
  assert.equal(banner.className, 'link-card-banner');
  assert.equal(body.children.length, 1);
});

test('previews are on by default; an explicit off is kept and hides cards', () => {
  const fresh = previewClient({ mode: undefined });
  assert.equal(fresh.run('readLinkPreviewMode()'), 'on');
  fresh.run('stored.set(LINK_PREVIEW_KEY, "off")');
  assert.equal(fresh.run('readLinkPreviewMode()'), 'off');
  fresh.run('window.localStorage = { getItem() { throw new Error("denied"); } }');
  assert.equal(fresh.run('readLinkPreviewMode()'), 'on');
  const off = previewClient({ mode: 'off' });
  const hidden = renderLink(off, 'https://example.com/a', 'x', 'theirs', senderPreview());
  assert.equal(hidden.linkCard, undefined);
  const app = previewClient();
  const row = renderLink(app, 'https://example.com/a', 'x', 'theirs', senderPreview());
  app.nodes.get('#link-previews-off').checked = true;
  app.nodes.get('#link-previews-off').emit('change');
  assert.equal(app.run('stored.get(LINK_PREVIEW_KEY)'), 'off');
  assert.equal(row.linkCard, null);
  assert.deepEqual([...app.run('revoked')], ['blob:local-1']);
  app.run('applyLinkPreviewMode("on")');
  assert.ok(row.linkCard);
  app.run('stored.set(LINK_PREVIEW_KEY, "off")');
  app.windowEvents.get('storage')({ key: 'sideword-client-link-previews' });
  assert.equal(row.linkCard, null);
});

test('a completed draft URL is prefetched once, and deleting it cancels the request and drops the result', async () => {
  const app = previewClient();
  typeDraft(app, 'see https://example.com/a');
  await flush();
  assert.equal(calls(app).length, 0); // Still possibly being typed.
  app.timers.findLast(timer => timer.delay === 700)();
  await flush();
  assert.deepEqual(calls(app), [['/api/v1/link-previews', 'POST', '{"url":"https://example.com/a"}']]);
  typeDraft(app, 'see https://example.com/a and more');
  await flush();
  assert.equal(calls(app).length, 1);
  typeDraft(app, 'see nothing');
  assert.equal(app.run('linkPreviewResults.size'), 0);
  app.run(`globalThis.aborted = 0; previewReply = options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }); });`);
  typeDraft(app, 'https://example.com/slow', 'insertFromPaste');
  await flush();
  typeDraft(app, 'changed my mind');
  await flush();
  assert.equal(app.run('aborted'), 1);
  assert.equal(app.run('linkPreviewPending.size'), 0);
  const off = previewClient({ mode: 'off' });
  typeDraft(off, 'https://example.com/a ', 'insertFromPaste');
  await flush();
  assert.equal(calls(off).length, 0);
});

test('sending puts the ready preview into the encrypted payload; large groups omit the image', async () => {
  const app = previewClient();
  typeDraft(app, 'see https://example.com/a ', 'insertFromPaste');
  await flush();
  const preview = app.run('sendLinkPreview("see https://example.com/a", 1)');
  assert.deepEqual(Object.keys(preview).sort(), ['description', 'final_host', 'image', 'site_name', 'title', 'url']);
  assert.equal(preview.url, 'https://example.com/a');
  assert.equal(preview.image.mime, 'image/jpeg');
  assert.deepEqual(JSON.parse(JSON.stringify(app.run('reduced'))), [[24576, 160]]);
  const payload = app.run('value => SidewordProtocol.textPayload("see https://example.com/a", value)')(preview);
  assert.equal(payload.preview.title, '<img src=x onerror=alert(1)>');
  const entry = app.run('value => payloadEntry(value)')(payload);
  assert.equal(entry.preview.url, 'https://example.com/a');
  // A realistic 60 KB thumbnail fits a few copies but not the 100-recipient maximum.
  app.run('linkPreviewResults.get("https://example.com/a").image.bytes = new Uint8Array(60000).fill(1)');
  assert.ok(app.run('sendLinkPreview("see https://example.com/a", 3)').image);
  const group = app.run('sendLinkPreview("see https://example.com/a", 100)');
  assert.equal(group.image, null);
  assert.equal(group.title, '<img src=x onerror=alert(1)>');
  assert.equal(app.run('sendLinkPreview("no links here", 1)'), null);
});

test('send never waits for a preview and never starts a request', async () => {
  const app = previewClient();
  app.run(`previewReply = () => new Promise(() => {});`);
  // Nothing loaded yet: the message goes out at once without a preview or a new request.
  assert.equal(app.run('sendLinkPreview("https://example.com/new", 1)'), null);
  await flush();
  assert.equal(calls(app).length, 0);
  // A draft request still in flight is not awaited either.
  typeDraft(app, 'https://example.com/slow ', 'insertFromPaste');
  await flush();
  assert.equal(calls(app).length, 1);
  const payload = app.run('textPayloadWithPreview("https://example.com/slow", 1)');
  assert.deepEqual(Object.keys(payload), ['v', 'type', 'text']);
});

test('draft rate limits retry later', async () => {
  const app = previewClient();
  app.run(`globalThis.attempts = 0; previewReply = () => ++attempts === 1
    ? new ClientError("Chat request failed (HTTP 429). Slow down") : { title: 'Later' };`);
  typeDraft(app, 'https://example.com/a ', 'insertFromPaste');
  await flush();
  assert.equal(app.run('linkPreviewResults.size'), 0);
  app.timers.findLast(timer => timer.delay === 10000)();
  await flush();
  assert.equal(app.run('linkPreviewResults.get("https://example.com/a").title'), 'Later');
});

test('own messages keep status and details; cards and links never open details', () => {
  const app = previewClient();
  app.run('globalThis.detailsOpened = 0; showMessageDetails = () => { detailsOpened++; };');
  const row = renderLink(app, 'read https://example.com/a', 'x', 'mine', senderPreview());
  assert.equal(row.messageBubble.children.at(-1), row.messageFooter);
  row.emit('click', { target: anchorsOf(row.messageContent)[0] });
  row.emit('click', { target: row.linkCard.children[0].children[0].children[1] });
  assert.equal(app.run('detailsOpened'), 0);
  row.emit('click', { target: row.messageContent });
  assert.equal(app.run('detailsOpened'), 1);
  assert.equal(row.messageBubble.attributes.get('has-link-extras'), true);
  assert.equal(calls(app).length, 0);
});

test('page hide releases preview images and page show restores them without requests', () => {
  const app = previewClient();
  const row = renderLink(app, 'https://example.com/a', 'x', 'theirs', senderPreview());
  app.windowEvents.get('pagehide')();
  assert.equal(row.linkCard, null);
  assert.deepEqual([...app.run('revoked')], ['blob:local-1']);
  app.windowEvents.get('pageshow')({ persisted: false });
  assert.equal(row.linkCard.children[0].children[1].src, 'blob:local-2');
  assert.equal(calls(app).length, 0);
});

test('stored history loads with one render instead of one per message', async () => {
  const app = previewClient({ mode: 'off' });
  await app.run(`(async () => {
    identity.storageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    globalThis.database = new Map();
    readHistoryRecords = async prefix => [...database]
      .filter(([key]) => key.startsWith(prefix || HISTORY_PREFIX + identity.publicId + ':'))
      .map(([key, value]) => ({ key, value }));
    messagesByChat.set(7, []); loadedHistoryKeys.clear(); renderMessages();
    for (let index = 0; index < 5; index++) {
      const key = historyKey(7, 'h' + index);
      database.set(key, await sealLocalRecord(key, { id: 'h' + index, kind: 'theirs', senderPublicId: 'peer-a',
        text: 'stored ' + index, createdAt: 1000 + index }));
    }
    globalThis.renders = 0;
    const original = renderMessages;
    renderMessages = (...args) => { renders++; return original(...args); };
    await loadStoredHistory();
  })()`);
  assert.equal(app.run('renders'), 1);
  assert.deepEqual(app.nodes.get('#message-list').children.map(row => row.messageContent.textContent),
    ['stored 0', 'stored 1', 'stored 2', 'stored 3', 'stored 4']);
});

test('text payload previews are strictly validated', () => {
  const app = linkClient();
  const valid = senderPreview();
  const check = preview => {
    try { app.run('value => SidewordProtocol.textPayload("https://example.com/a", value)')(preview); return true; }
    catch { return false; }
  };
  assert.equal(check(valid), true);
  assert.equal(check({ ...valid, image: null }), true);
  for (const [name, preview] of [
    ['extra key', { ...valid, extra: 1 }],
    ['missing key', (({ title, ...rest }) => rest)(valid)],
    ['http url', { ...valid, url: 'http://example.com/a' }],
    ['unnormalized url', { ...valid, url: 'https://EXAMPLE.com/a' }],
    ['credentials', { ...valid, url: 'https://user@example.com/a' }],
    ['script url', { ...valid, url: 'javascript:alert(1)' }],
    ['control characters', { ...valid, title: 'a\u0007b' }],
    ['long title', { ...valid, title: 'x'.repeat(201) }],
    ['bad host', { ...valid, final_host: 'evil.com/<x>' }],
    ['empty', { ...valid, title: null, description: null, image: null }],
    ['png image', { ...valid, image: { mime: 'image/jpeg', data: PNG.toString('base64') } }],
    ['svg mime', { ...valid, image: { mime: 'image/svg+xml', data: JPEG.toString('base64') } }],
    ['image extra key', { ...valid, image: { mime: 'image/jpeg', data: JPEG.toString('base64'), url: 'x' } }],
    ['oversized image', { ...valid, image: { mime: 'image/jpeg',
      data: Buffer.concat([JPEG, Buffer.alloc(100 * 1024)]).toString('base64') } }],
  ]) assert.equal(check(preview), false, name);
  // Attachments carry no previews, and plain text payloads are unchanged.
  assert.throws(() => app.run('SidewordProtocol.validatePayload')({ v: 1, type: 'attachment-ref', text: '', name: 'a',
    mime: 'text/plain', size: 1, media_id: 'x.media', preview: valid }));
  assert.deepEqual(Object.keys(app.run('SidewordProtocol.textPayload("hello")')), ['v', 'type', 'text']);
});

test('an unusable preview never blocks sending', async () => {
  const app = previewClient({ reply: { title: 'bad\u0007title' } });
  typeDraft(app, 'https://example.com/a ', 'insertFromPaste');
  await flush();
  const payload = app.run('textPayloadWithPreview("https://example.com/a", 1)');
  assert.deepEqual(Object.keys(payload), ['v', 'type', 'text']);
  const good = previewClient();
  typeDraft(good, 'https://example.com/a ', 'insertFromPaste');
  await flush();
  assert.equal(good.run('textPayloadWithPreview("https://example.com/a", 1)').preview.url, 'https://example.com/a');
});

// Late previews: the sender's follow-up message attaches a preview to its own earlier message.
let deliveryCounter = 0;
async function receive(app, sender, clientMessageId, payload) {
  const message = { chat_id: 7, sender_public_id: sender, client_message_id: clientMessageId,
    delivery_id: (++deliveryCounter).toString(16).padStart(32, '0'), created_at: '2026-11-01T00:00:00Z',
    testPayload: payload };
  app.run('value => { globalThis.incomingMessage = value; }')(message);
  await app.run(`(async () => {
    decryptMessage = async message => JSON.stringify(message.testPayload);
    queueDelivery = () => {};
    await processMessages([incomingMessage]);
  })()`);
}
const rowFor = (app, sender, id) => app.nodes.get('#message-list').children
  .find(row => row.messageEntry.id === `incoming:${JSON.stringify([7, sender, id])}`);
const textMessage = text => ({ v: 1, type: 'text', text });
const followUp = (target, preview = senderPreview()) => ({ v: 1, type: 'link-preview', target, preview });

test('a late preview from the sender appears on both sides without any recipient request', async () => {
  const app = previewClient({ available: false });
  await receive(app, 'peer-a', 'm1', textMessage('see https://example.com/a'));
  const row = rowFor(app, 'peer-a', 'm1');
  assert.equal(row.linkCard, undefined);
  await receive(app, 'peer-a', 'p1', followUp('m1'));
  assert.equal(row.linkCard.children[0].children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(calls(app).length, 0);
  // The follow-up itself is hidden and never shown as a message.
  assert.equal(app.nodes.get('#message-list').children.length, 1);
});

test('only the original sender can attach a preview, once, to its own first link', async () => {
  const app = previewClient();
  await receive(app, 'peer-a', 'm1', textMessage('see https://example.com/a'));
  await receive(app, 'peer-b', 'p1', followUp('m1')); // Another participant: ignored.
  assert.equal(rowFor(app, 'peer-a', 'm1').linkCard, undefined);
  await receive(app, 'peer-a', 'p2', followUp('m1', senderPreview({ url: 'https://evil.example/' })));
  assert.equal(rowFor(app, 'peer-a', 'm1').linkCard, undefined); // Not the message's link.
  await receive(app, 'peer-a', 'm2', textMessage('https://example.com/a'));
  await receive(app, 'peer-a', 'p3', followUp('m2', senderPreview({ title: 'First' })));
  await receive(app, 'peer-a', 'p4', followUp('m2', senderPreview({ title: 'Replacement' })));
  assert.equal(rowFor(app, 'peer-a', 'm2').linkCard.children[0].children[0].children[1].textContent, 'First');
});

test('a follow-up that arrives before its message applies when the message arrives', async () => {
  const app = previewClient();
  await receive(app, 'peer-a', 'p1', followUp('m1'));
  await receive(app, 'peer-a', 'm1', textMessage('see https://example.com/a'));
  assert.ok(rowFor(app, 'peer-a', 'm1').linkCard);
});

test('late previews ease in when visible and appear without animation offscreen', async () => {
  for (const [visible, reduced] of [[true, false], [false, false], [true, true]]) {
    const app = previewClient();
    app.run(`window.matchMedia = query => ({ matches: ${reduced} && query.includes('reduce') });`);
    await receive(app, 'peer-a', 'm1', textMessage('https://example.com/a'));
    const row = rowFor(app, 'peer-a', 'm1');
    const animations = [];
    row.messageBubble.getBoundingClientRect = () => visible
      ? (row.linkCard ? { top: 0, bottom: 180, width: 320, height: 180 } : { top: 0, bottom: 40, width: 140, height: 40 })
      : { top: -500, bottom: -460, width: 140, height: 40 };
    row.messageBubble.animate = frames => { animations.push(frames); return { finished: Promise.resolve() }; };
    const create = app.document.createElement;
    app.document.createElement = tag => {
      const node = create(tag);
      if (tag === 'a') node.animate = frames => { animations.push(frames); return { finished: Promise.resolve() }; };
      return node;
    };
    await receive(app, 'peer-a', 'p1', followUp('m1', senderPreview({ image: null })));
    assert.ok(row.linkCard);
    if (visible && !reduced) {
      assert.equal(animations[0][0].width, '140px');
      assert.equal(animations[0][1].width, '320px');
      assert.equal(animations[1][0].opacity, 0);
    } else assert.equal(animations.length, 0);
  }
});

test('when the preview is not ready at send, it follows in an encrypted message to the same recipients', async () => {
  const app = previewClient();
  app.run(`globalThis.queued = []; globalThis.release = [];
    previewReply = () => new Promise(resolve => release.push(resolve));
    queueEncryptedMessage = async (chat, recipients, messageId, payload) => {
      queued.push({ chat: chat.id, recipients: recipients.map(peer => peer.public_id), payload }); };
    flushOutbox = async () => {}; renderOutbox = async () => {}; assertTrustedPeer = async () => {};`);
  // Sent immediately without a preview; loading continues for this message.
  assert.equal(app.run('sendLinkPreview("see https://example.com/a", 2)'), null);
  app.run(`followUpLinkPreview(7, 'sent-1', 'see https://example.com/a',
    chats[0].participants.filter(peer => peer.public_id !== 'me'))`);
  await flush();
  assert.equal(calls(app).length, 1);
  typeDraft(app, 'a new unrelated draft'); // Editing the draft must not cancel it.
  app.run('release.forEach(resolve => resolve({ title: "Loaded later" }))');
  await flush();
  const [sent] = JSON.parse(JSON.stringify(app.run('queued')));
  assert.equal(sent.chat, 7);
  assert.deepEqual(sent.recipients, ['peer-a', 'peer-b']);
  assert.equal(sent.payload.type, 'link-preview');
  assert.equal(sent.payload.target, 'sent-1');
  assert.equal(sent.payload.preview.title, 'Loaded later');
  // Finished while the message was being encrypted: the follow-up goes out at once.
  app.run(`linkPreviewResults.set('https://example.com/b', { title: 'Ready', description: null, siteName: null,
    finalHost: null, image: null }); followUpLinkPreview(7, 'sent-2', 'https://example.com/b',
    chats[0].participants.filter(peer => peer.public_id !== 'me'))`);
  await flush();
  assert.equal(app.run('queued[1].payload.target'), 'sent-2');
  // Failed previews send nothing.
  app.run(`previewReply = new ClientError('Chat request failed (HTTP 502). Down');
    followUpLinkPreview(7, 'sent-3', 'https://example.com/c', chats[0].participants.filter(peer => peer.public_id !== 'me'))`);
  await flush();
  assert.equal(app.run('queued.length'), 2);
});

test("the sender's own message gets the card when its follow-up is stored", async () => {
  const app = previewClient();
  app.run(`identity.retryWindowSeconds = 86400;`);
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-1', createdAt: Date.now(),
    envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'x' }], payload: SidewordProtocol.textPayload('read https://example.com/a') })`);
  const row = app.nodes.get('#message-list').children.find(node => node.messageEntry.id === 'outgoing:own-1');
  assert.equal(row.linkCard, undefined);
  app.run('value => { globalThis.followUpPayload = value; }')(followUp('own-1'));
  await app.run(`storeOutgoing({ chatId: 7, messageId: 'own-preview-1', createdAt: Date.now(),
    envelopes: [{ recipient_public_id: 'peer-a', ciphertext: 'x' }], payload: SidewordProtocol.validatePayload(followUpPayload) })`);
  assert.ok(row.linkCard);
  assert.equal(app.nodes.get('#message-list').children.length, 1);
});

test('link-preview follow-up payloads are strictly validated', () => {
  const app = linkClient();
  const check = payload => {
    try { app.run('SidewordProtocol.validatePayload')(payload); return true; } catch { return false; }
  };
  assert.equal(check(followUp('0b8e7c1e-2b4f-4f0e-9a51-0a2c1f6f3d10')), true);
  assert.equal(check({ ...followUp('m1'), text: 'extra' }), false);
  assert.equal(check(followUp('../m1')), false);
  assert.equal(check(followUp('x'.repeat(59))), false);
  assert.equal(check(followUp('m1', senderPreview({ url: 'http://example.com/a' }))), false);
  assert.equal(check({ v: 1, type: 'link-preview', target: 'm1' }), false);
});
