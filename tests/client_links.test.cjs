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
  assert.deepEqual(found('https://example.com/‮gpj.exe https://example.org​/x'),
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

// Waits for queued previews, API stubs and local image work to settle.
async function flush() {
  for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
}

function previewClient({ available = true, mode = 'on', reply, wide = false } = {}) {
  const app = linkClient();
  const png = fs.readFileSync('tests/fixtures/media/valid.png');
  app.run(`globalThis.created = []; globalThis.revoked = []; globalThis.reduced = []; globalThis.persisted = 0;
    globalThis.stored = new Map(); window.localStorage = {
      getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    persistHistoryEntry = async () => { persisted++; };
    globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options.type; } };
    globalThis.URL = class extends URL {
      static createObjectURL(blob) { created.push(blob); return 'blob:local-' + created.length; }
      static revokeObjectURL(url) { revoked.push(url); } };
    globalThis.SidewordMedia = { ...SidewordMedia,
      inspect: ${wide} ? () => ({ mime: 'image/png', width: 1200, height: 630 }) : SidewordMedia.inspect,
      reduceImage: async (...args) => {
        reduced.push(args.slice(2).filter(value => typeof value !== 'function'));
        return args[3]() ? new Uint8Array([255, 216, 255]) : null; } };
    linkPreviewMode = ${JSON.stringify(mode)}; setLinkPreviewsAvailable(${available});`);
  const response = reply || {
    title: '<img src=x onerror=alert(1)>', description: 'About <b>this</b>', site_name: 'Example Docs',
    url: null, final_host: 'www.example.org',
    image: { mime: 'image/png', width: 2, height: 2, data: png.toString('base64') } };
  app.run('value => { globalThis.previewReply = value; }')(response);
  app.run(`api = async (path, options) => {
    apiCalls.push([path, options?.method, options?.body]);
    const reply = typeof previewReply === 'function' ? await previewReply(options) : previewReply;
    if (reply instanceof Error) throw reply;
    return JSON.parse(JSON.stringify(reply)); };`);
  return app;
}

function renderLink(app, text = 'see https://example.com/a', id = 'x', kind = 'theirs') {
  app.run(`messagesByChat.set(7, [...(messagesByChat.get(7) || []), {id: ${JSON.stringify(id)}, kind: ${JSON.stringify(kind)},
    senderPublicId: 'peer-a', text: ${JSON.stringify(text)}, createdAt: ${Date.now()}}]); renderMessages();`);
  return app.nodes.get('#message-list').children.find(row => row.messageEntry.id === id);
}
const calls = app => JSON.parse(JSON.stringify(app.run('apiCalls')));

test('previews are off by default: no requests, cards or placeholders under links', async () => {
  const app = previewClient({ mode: undefined });
  app.run('linkPreviewMode = readLinkPreviewMode()');
  assert.equal(app.run('linkPreviewMode'), 'off');
  const row = renderLink(app);
  await flush();
  assert.equal(row.linkCard, undefined);
  assert.deepEqual(row.messageBubble.children, [row.messageContent]);
  assert.equal(calls(app).length, 0);
});

test('suspicious links show an inline warning without a card', async () => {
  const app = previewClient({ mode: 'off' });
  const row = renderLink(app, 'login at https://pаypal.com/login now');
  assert.equal(row.linkWarning.textContent, 'Check xn--pypal-4ve.com: Mixes writing systems');
  assert.equal(row.messageBubble.attributes.get('has-link-extras'), true);
  assert.equal(row.linkCard, undefined);
  assert.equal(anchorsOf(row.messageContent)[0].attributes.get('aria-describedby'),
    'external-link-note suspicious-link-note');
});

test('when on, previews load automatically into a compact card with safe text', async () => {
  const app = previewClient();
  const row = renderLink(app);
  assert.equal(row.linkCard, undefined); // Nothing renders until the preview arrives.
  await flush();
  assert.deepEqual(calls(app), [['/api/v1/link-previews', 'POST', '{"url":"https://example.com/a"}']]);
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
  assert.equal(thumbnail.alt, '');
  assert.equal(app.run('created[0].type'), 'image/jpeg');
  assert.deepEqual(JSON.parse(JSON.stringify(app.run('reduced'))), [[24576, 160]]);
  assert.equal(row.messageBubble.attributes.get('has-link-extras'), true);
  // Nothing is added to encrypted history or the message entry.
  assert.equal(app.run('persisted'), 0);
  assert.deepEqual(Object.keys(app.run('messagesByChat.get(7)[0]')).sort(),
    ['createdAt', 'id', 'kind', 'senderPublicId', 'text']);
  // The same address elsewhere reuses the in-memory result.
  const again = renderLink(app, 'again https://example.com/a', 'y');
  await flush();
  assert.equal(again.linkCard.children[0].children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(calls(app).length, 1);
});

test('wide images become a banner and titles that repeat the description are shortened', async () => {
  const app = previewClient({ wide: true, reply: { title: 'GitHub - owner/repo: A lightweight backend for chats',
    description: 'A lightweight backend for chats. - owner/repo', site_name: 'GitHub', final_host: 'github.com',
    image: { mime: 'image/png', data: fs.readFileSync('tests/fixtures/media/valid.png').toString('base64') } } });
  const row = renderLink(app, 'https://github.com/owner/repo');
  await flush();
  const [banner, body] = row.linkCard.children;
  assert.equal(banner.className, 'link-card-banner');
  assert.deepEqual(JSON.parse(JSON.stringify(app.run('reduced'))), [[98304, 640]]);
  assert.deepEqual(body.children[0].children.map(node => [node.className, node.textContent]), [
    ['link-card-source', 'github.com'], ['link-card-title', 'GitHub - owner/repo'],
    ['link-card-description', 'A lightweight backend for chats. - owner/repo']]);
});

test('a title that starts with the description is shown once', async () => {
  const app = previewClient({ reply: { title: 'Same words here and more', description: 'Same words here' } });
  const row = renderLink(app);
  await flush();
  assert.deepEqual(row.linkCard.children[0].children[0].children.map(node => node.className),
    ['link-card-source', 'link-card-title']);
});

test('only previewable HTTPS links on supporting servers are requested', async () => {
  const unavailable = previewClient({ available: false });
  renderLink(unavailable);
  await flush();
  assert.equal(calls(unavailable).length, 0);
  assert.equal(unavailable.nodes.get('#link-previews-unavailable').hidden, false);
  const app = previewClient();
  for (const [id, text] of [['h', 'http://example.com/'], ['c', 'https://user@example.com/'],
    ['p', 'https://example.com:8443/']]) renderLink(app, text, id);
  app.run(`messagesByChat.set(7, [...messagesByChat.get(7), {id: 'f', kind: 'theirs', senderPublicId: 'peer-a',
    text: 'https://example.com/file', createdAt: 5, attachment: {type: 'attachment-ref', mime: 'application/pdf', size: 1}}]);
    renderMessages();`);
  await flush();
  assert.equal(calls(app).length, 0);
});

test('failures render nothing, are remembered, and rate limits retry later', async () => {
  const app = previewClient();
  app.run('previewReply = new ClientError("Chat request failed (HTTP 502). Unavailable")');
  const row = renderLink(app);
  await flush();
  assert.equal(row.linkCard, undefined);
  assert.deepEqual(row.messageBubble.children, [row.messageContent]);
  renderLink(app, 'again https://example.com/a', 'y');
  await flush();
  assert.equal(calls(app).length, 1);
  const limited = previewClient();
  limited.run(`globalThis.attempts = 0; previewReply = () => ++attempts === 1
    ? new ClientError("Chat request failed (HTTP 429). Slow down") : { title: 'Later' };`);
  const later = renderLink(limited);
  await flush();
  assert.equal(later.linkCard, undefined);
  const retry = limited.timers.findLast(timer => timer.delay === 10000);
  retry();
  await flush();
  assert.equal(later.linkCard.children[0].children[0].children[1].textContent, 'Later');
});

test('loading is parallel but bounded, newest first, with one request per address', async () => {
  const app = previewClient();
  app.run(`globalThis.release = []; previewReply = options => new Promise(resolve =>
    release.push(() => resolve({ title: JSON.parse(options.body).url })));`);
  app.run(`messagesByChat.set(7, [1, 2, 3, 4, 5].map(index => ({id: 'm' + index, kind: 'theirs',
    senderPublicId: 'peer-a', text: 'https://e' + index + '.example/', createdAt: index}))); renderMessages();`);
  await flush();
  assert.deepEqual(calls(app).map(call => JSON.parse(call[2]).url),
    ['https://e5.example/', 'https://e4.example/', 'https://e3.example/']);
  const duplicate = renderLink(app, 'same https://e5.example/', 'dup');
  app.run('release.splice(0).forEach(resolve => resolve())');
  await flush();
  assert.equal(duplicate.linkCard.children[0].children[0].children[1].textContent, 'https://e5.example/');
  assert.equal(calls(app).length, 5);
  app.run('release.splice(0).forEach(resolve => resolve())');
  await flush();
  const rows = app.nodes.get('#message-list').children;
  assert.ok(rows.every(row => row.linkCard));
  assert.equal(calls(app).length, 5);
});

test('turning previews off removes cards, revokes images and ignores late responses', async () => {
  const app = previewClient();
  const row = renderLink(app);
  await flush();
  assert.ok(row.linkCard);
  app.nodes.get('#link-previews-off').checked = true;
  app.nodes.get('#link-previews-off').emit('change');
  assert.equal(app.run('stored.get(LINK_PREVIEW_KEY)'), 'off');
  assert.equal(row.linkCard, null);
  assert.deepEqual([...app.run('revoked')], ['blob:local-1']);
  assert.equal(app.run('linkPreviewResults.size'), 0);
  app.run(`globalThis.release = []; previewReply = () => new Promise(resolve => release.push(resolve));`);
  app.run('applyLinkPreviewMode("on", true)');
  await flush();
  app.run('applyLinkPreviewMode("off")');
  app.run('release.forEach(resolve => resolve({ title: "Late" }))');
  await flush();
  assert.equal(row.linkCard, null);
  app.run('stored.set(LINK_PREVIEW_KEY, "on")');
  app.windowEvents.get('storage')({ key: 'sideword-client-link-previews' });
  assert.equal(app.nodes.get('#link-previews-on').checked, true);
});

test('page hide releases images and page show restores cached previews', async () => {
  const app = previewClient();
  const row = renderLink(app);
  await flush();
  app.windowEvents.get('pagehide')();
  assert.equal(row.linkCard, null);
  assert.deepEqual([...app.run('revoked')], ['blob:local-1']);
  app.windowEvents.get('pageshow')({ persisted: false });
  assert.equal(row.linkCard.children[0].children[1].src, 'blob:local-2');
  assert.equal(calls(app).length, 1);
});

test('own messages keep status and details; cards and links never open details', async () => {
  const app = previewClient();
  app.run('globalThis.detailsOpened = 0; showMessageDetails = () => { detailsOpened++; };');
  const row = renderLink(app, 'read https://example.com/a', 'x', 'mine');
  await flush();
  assert.equal(row.messageBubble.children.at(-1), row.messageFooter);
  row.emit('click', { target: anchorsOf(row.messageContent)[0] });
  row.emit('click', { target: row.linkCard.children[0].children[0].children[1] });
  assert.equal(app.run('detailsOpened'), 0);
  row.emit('click', { target: row.messageContent });
  assert.equal(app.run('detailsOpened'), 1);
  app.run(`messagesByChat.get(7)[0].text = 'edited https://example.org/b'; renderMessages();`);
  await flush();
  assert.equal(anchorsOf(row.messageContent)[0].href, 'https://example.org/b');
  assert.equal(row.linkCard.href, 'https://example.org/b');
  assert.equal(row.messageBubble.children.filter(child => child.className?.includes('link-card')).length, 1);
  assert.equal(row.messageBubble.children.at(-1), row.messageFooter);
});

test('plain, system and attachment messages keep their existing rendering', () => {
  const app = linkClient();
  app.run(`messagesByChat.set(7, [
    {id: 'a', kind: 'theirs', senderPublicId: 'peer-a', text: 'plain  text\\n  kept', createdAt: 1000},
    {id: 'b', kind: 'system', text: 'Notice https://example.com', createdAt: 2000},
    {id: 'c', kind: 'theirs', senderPublicId: 'peer-a', text: 'caption https://example.com', createdAt: 3000,
      attachment: {type: 'attachment-ref', mime: 'application/pdf', size: 10, text: 'caption https://example.com'}},
    {id: 'd', kind: 'theirs', senderPublicId: 'peer-a', text: '', createdAt: 4000},
  ]); renderMessages();`);
  const [plain, system, attachment, empty] = app.nodes.get('#message-list').children;
  assert.equal(plain.messageContent.text, 'plain  text\n  kept');
  assert.equal(plain.messageContent.children.length, 0);
  assert.equal(plain.linkCard, undefined);
  assert.equal(system.messageContent.text, 'Notice https://example.com');
  assert.equal(anchorsOf(system.messageContent).length, 0);
  assert.equal(anchorsOf(attachment.messageContent).length, 1);
  assert.equal(empty.messageContent.textContent, '');
});
