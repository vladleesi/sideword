const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { client } = require('./client_dom.cjs');

// Decoded previews are wrapped in an accessible open button.
const imageOf = preview => {
  const node = preview.children.at(-1);
  return node?.tagName === 'button' ? node.children[0] : node;
};
const hasImage = preview => preview.children.some(node => node.tagName === 'img'
  || node.children?.some(child => child.tagName === 'img'));

async function previewClient(mode = 'auto') {
  const app = client();
  app.run(`imagePreviewMode = ${JSON.stringify(mode)}`);
  const p = app.run('SidewordProtocol');
  const fixture = p.filePayload('image.png', 'image/png', fs.readFileSync('tests/fixtures/media/valid.png'));
  app.run('value => { globalThis.fixture = value; }')(fixture);
  app.run(`
    globalThis.created = 0; globalThis.revoked = [];
    globalThis.setTimeout = window.setTimeout;
    globalThis.clearTimeout = window.clearTimeout;
    globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options.type; } };
    globalThis.URL = {createObjectURL() { return 'blob:synthetic-' + (++created); },
      revokeObjectURL(url) { revoked.push(url); }};
    persistHistoryEntry = async () => {};
  `);
  const create = app.document.createElement;
  app.document.createElement = tag => {
    const node = create(tag);
    if (tag === 'img') {
      node.naturalWidth = node.naturalHeight = 2;
      node.decode = async () => {};
      node.removeAttribute = name => { if (name === 'src') node.src = ''; };
    }
    return node;
  };
  await app.run('appendMessage(7, {id:"image", kind:"theirs", attachment:fixture}, false)');
  const card = app.nodes.get('#message-list').children[0].messageBubble;
  const preview = card.children.find(node => node.className?.split(' ').includes('media-preview'));
  return {...app, preview};
}

async function flushPreviews(app) {
  app.run('scheduleVisiblePreviews()');
  for (const timer of app.timers.filter(timer => timer.delay === 0)) timer();
  await new Promise(resolve => setImmediate(resolve));
}

test('visible images preview automatically without a preview button and release off-screen URLs', async () => {
  const app=await previewClient();
  assert.equal(app.preview.children.some(node=>node.tagName==='button'),false);
  await flushPreviews(app);
  assert.equal(app.run('created'),1);
  const node=app.nodes.get('#message-list').children[0];
  node.rect={top:1000,bottom:1100,left:0,right:100,width:100,height:100};
  await flushPreviews(app);
  assert.equal(app.run('revoked.length'),1);
  assert.equal(hasImage(app.preview),false);
  assert.match(app.preview.className,/media-frame/);
  node.rect={top:0,bottom:100,left:0,right:100,width:100,height:100};
  await flushPreviews(app);
  await flushPreviews(app);
  assert.equal(app.run('created'),2);
});

test('small scroll reversals retain the decoded image instead of blinking through a loader', async () => {
  const app=await previewClient();
  await flushPreviews(app);
  const image=imageOf(app.preview);
  const node=app.nodes.get('#message-list').children[0];
  for(let i=0;i<4;i++) {
    node.rect={top:101,bottom:201,left:0,right:100,width:100,height:100};
    await flushPreviews(app);
    node.rect={top:0,bottom:100,left:0,right:100,width:100,height:100};
    await flushPreviews(app);
  }
  assert.equal(imageOf(app.preview),image);
  assert.equal(app.run('created'),1);
  assert.equal(app.run('revoked.length'),0);
  assert.equal(app.preview.children[0].textContent,'');
});

test('restored image history reserves stable frames before any lazy decoding starts', async () => {
  const app=await previewClient();
  await app.run(`(async()=>{
    for(let i=0;i<8;i++) await appendMessage(7,{id:'restored-image-'+i,kind:'theirs',attachment:fixture},false);
  })()`);
  const frames=app.nodes.get('#message-list').children.map(node=>node.attachmentUi.preview);
  assert.equal(app.run('created'),0);
  for(const frame of frames) assert.match(frame.className,/media-frame/);
  await flushPreviews(app);
  assert.equal(app.run('created'),3);
  app.run('mediaPreviews.clear()');
  for(const frame of frames) assert.match(frame.className,/media-frame/);
});

test('nearby retention never prevents a newly visible image from getting a bounded slot', async () => {
  const app=await previewClient();
  await app.run(`(async()=>{
    for(let i=1;i<3;i++) await appendMessage(7,{id:'image-'+i,kind:'theirs',attachment:fixture},false);
  })()`);
  await flushPreviews(app);
  assert.equal(app.run('created'),3);
  for(const node of app.nodes.get('#message-list').children) {
    node.rect={top:101,bottom:201,left:0,right:100,width:100,height:100};
  }
  await app.run("appendMessage(7,{id:'new-visible',kind:'theirs',attachment:fixture},false)");
  await flushPreviews(app);
  const latest=app.nodes.get('#message-list').children.at(-1);
  assert.equal(imageOf(latest.attachmentUi.preview).tagName,'img');
  assert.equal(app.run('created-revoked.length'),3);
  assert.equal(app.run('created'),4);
});

test('loader remains until native decoding finishes, then the image replaces it', async () => {
  const app=await previewClient();
  const create=app.document.createElement;
  let finish;
  app.document.createElement=tag=>{
    const node=create(tag);
    if(tag==='img') node.decode=()=>new Promise(resolve=>{finish=resolve;});
    return node;
  };
  await flushPreviews(app);
  assert.match(app.preview.children[0].className,/media-loading/);
  assert.equal(hasImage(app.preview),false);
  finish();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.preview.children[0].textContent,'');
  assert.equal(imageOf(app.preview).tagName,'img');
  app.run('mediaPreviews.clear()');
});

test('unsupported files and failed image signatures cannot starve a valid automatic preview', async () => {
  const app=await previewClient();
  await app.run(`(async()=>{
    for(let i=0;i<3;i++) await appendMessage(7,{id:'pdf-'+i,kind:'theirs',
      attachment:SidewordProtocol.filePayload('synthetic.pdf','application/pdf',new Uint8Array())},false);
    for(let i=0;i<3;i++) await appendMessage(7,{id:'forged-'+i,kind:'theirs',
      attachment:SidewordProtocol.filePayload('synthetic.png','image/png',new Uint8Array([1,2]))},false);
  })()`);
  await flushPreviews(app);
  await flushPreviews(app);
  assert.equal(imageOf(app.preview).tagName,'img');
  assert.equal(app.run('created'),1);
  app.run('mediaPreviews.clear()');
});

for (const action of ['chat', 'removal', 'single-removal', 'hidden', 'pagehide', 'session']) {
  test(`rendered previews are reused and released on ${action}`, async () => {
    const app = await previewClient();
    assert.equal(app.run('created'), 0);
    app.run('scheduleVisiblePreviews()');
    for (const timer of app.timers.filter(timer => timer.delay === 0)) timer();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.run('created'), 1);
    assert.equal(imageOf(app.preview).tagName, 'img');
    app.run('renderMessages(); renderMessages();');
    assert.equal(app.run('created'), 1);
    if (action === 'chat') app.run('selectChat(null)');
    if (action === 'removal') app.run('messagesByChat.set(7, []); renderMessages();');
    if (action === 'single-removal') await app.run(`(async () => {
      await appendMessage(7, {id:'retained-text', kind:'theirs', text:'keep this'}, false);
      messagesByChat.set(7, messagesByChat.get(7).filter(entry => entry.id !== 'image'));
      renderMessages();
    })()`);
    if (action === 'hidden') {
      app.document.visibilityState = 'hidden';
      app.documentEvents.get('visibilitychange')();
    }
    if (action === 'pagehide') app.windowEvents.get('pagehide')();
    if (action === 'session') await app.run(`(async () => {
      writeIdentity = async () => { throw new Error('synthetic storage failure'); };
      try { await invalidateSession(); } catch {}
    })()`);
    assert.equal(app.run('revoked.length'), 1);
    assert.equal(hasImage(app.preview), false);
  });
}

test('image delivery persists and ACKs without starting a preview decoder', async () => {
  const app = await previewClient();
  await app.run(`(async () => {
    globalThis.savedImage = false; globalThis.acks = [];
    decryptMessage = async () => SidewordProtocol.encodePayload(SidewordProtocol.fileReference(
      fixture.name,fixture.mime,fixture.size,'incoming-image.media'));
    persistHistoryEntry = async (chat, entry) => {
      if (entry.attachment) savedImage = entry.attachment.type === 'attachment-ref' && entry.attachment.size === fixture.size;
    };
    api = async (path, options) => {
      if (!savedImage || created) throw new Error('Preview must not precede durable ACK');
      acks.push(JSON.parse(options.body));
    };
    await processIncoming({messages:[{chat_id:7, sender_public_id:'peer-a',
      client_message_id:'incoming-image', delivery_id:'a'.repeat(32),
      created_at:'2026-10-29T12:00:00Z'}]});
  })()`);
  assert.equal(app.run('savedImage'), true);
  assert.equal(app.run('created'), 0);
  assert.equal(app.run('acks[0].messages[0].delivery_id'), 'a'.repeat(32));
});

test('SVG bytes disguised as a PNG remain a download without an image URL', async () => {
  const app = await previewClient();
  app.run(`fixture.data = btoa('<svg onload="alert(1)"></svg>');
    fixture.size = atob(fixture.data).length;`);
  app.run('scheduleVisiblePreviews()');
  for (const timer of app.timers.filter(timer => timer.delay === 0)) timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('created'), 0);
  assert.equal(hasImage(app.preview), false);
  assert.equal(app.preview.children[0].textContent, 'Image preview unavailable');
  assert.equal(app.nodes.get('#message-list').children[0].messageBubble.children
    .some(node => node.className === 'button subtle attachment-download'), true);
});

const flushAsync = () => new Promise(resolve => setImmediate(resolve));
const revealButton = preview => preview.children.find(node => node.className?.includes('media-reveal'));

async function openViewer(app) {
  await flushPreviews(app);
  const open = app.preview.children.at(-1);
  assert.equal(open.tagName, 'button');
  open.emit('click', {stopPropagation() {}});
  await flushAsync();
  return open;
}

test('automatic display is the default without a saved preference', async () => {
  const app = await previewClient('reveal');
  assert.equal(app.run('readImagePreviewMode()'), 'auto');
  app.run(`window.localStorage = { getItem: () => null }`);
  assert.equal(app.run('readImagePreviewMode()'), 'auto');
});

test('click-to-reveal hides images: no URL, decoder or receipt until revealed', async () => {
  const app = await previewClient('reveal');
  app.run(`globalThis.calls = []; api = async path => { calls.push(path); return {}; };`);
  await flushPreviews(app);
  const reveal = revealButton(app.preview);
  assert.equal(reveal.textContent, 'Show image');
  assert.equal(app.run('created'), 0);
  assert.doesNotMatch(app.preview.className, /media-frame/);
  reveal.emit('click', {stopPropagation() {}});
  assert.equal(app.document.activeElement, app.preview);
  await flushPreviews(app);
  assert.equal(app.run('created'), 1);
  assert.equal(revealButton(app.preview), undefined);
  assert.equal(imageOf(app.preview).alt, 'Image attachment');
  assert.equal(app.document.activeElement, app.preview.children.at(-1));
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), []);
  app.run('mediaPreviews.clear()');
});

test('reveal mode keeps generic files as downloads and still previews this device\'s own images', async () => {
  const app = await previewClient('reveal');
  await app.run(`(async () => {
    await appendMessage(7, {id:'generic', kind:'theirs', attachment:SidewordProtocol.filePayload('scan', '',
      Uint8Array.from(atob(fixture.data), c => c.charCodeAt(0)))}, false);
    await appendMessage(7, {id:'mine-image', kind:'mine', clientMessageId:'mine-image', attachment:fixture}, false);
  })()`);
  const byId = id => app.nodes.get('#message-list').children.find(node => node.messageEntry.id === id);
  const [incoming, generic, mine] = ['image', 'generic', 'mine-image'].map(byId);
  assert.ok(revealButton(incoming.attachmentUi.preview));
  assert.equal(generic.attachmentUi.preview.children.length, 0);
  await flushPreviews(app);
  assert.equal(app.run('created'), 1);
  assert.equal(imageOf(mine.attachmentUi.preview).tagName, 'img');
  app.run('mediaPreviews.clear()');
});

test('restored history in reveal mode renders compact reveal controls without decoding', async () => {
  const app = await previewClient('reveal');
  await app.run(`(async () => {
    for (let i = 0; i < 20; i++) await appendMessage(7, {id:'restored-' + i, kind:'theirs', attachment:fixture}, false);
  })()`);
  await flushPreviews(app);
  const nodes = app.nodes.get('#message-list').children;
  assert.equal(nodes.length, 21);
  assert.equal(nodes.every(node => revealButton(node.attachmentUi.preview)), true);
  assert.equal(app.run('created'), 0);
});

test('privacy preference persists locally, syncs tabs and hides automatic previews again', async () => {
  const app = await previewClient('reveal');
  app.run(`globalThis.stored = new Map(); window.localStorage = {
    getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };`);
  const auto = app.nodes.get('#image-previews-auto'), reveal = app.nodes.get('#image-previews-reveal');
  auto.checked = true; auto.emit('change');
  assert.equal(app.run('stored.get(IMAGE_PREVIEW_KEY)'), 'auto');
  assert.equal(reveal.checked, false);
  await flushPreviews(app);
  assert.equal(app.run('created'), 1);
  app.run('stored.set(IMAGE_PREVIEW_KEY, "reveal")');
  app.windowEvents.get('storage')({key: 'sideword-client-image-previews'});
  assert.equal(reveal.checked, true);
  assert.equal(app.run('revoked.length'), 1);
  const preview = app.nodes.get('#message-list').children[0].attachmentUi.preview;
  assert.ok(revealButton(preview));
  assert.equal(hasImage(preview), false);
  app.run('stored.set(IMAGE_PREVIEW_KEY, "<script>")');
  app.windowEvents.get('storage')({key: null});
  assert.equal(app.run('imagePreviewMode'), 'auto');
  assert.equal(auto.checked, true);
  app.run('window.localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }');
  assert.equal(app.run('readImagePreviewMode()'), 'auto');
  reveal.checked = true; reveal.emit('change');
  assert.equal(app.run('imagePreviewMode'), 'reveal');
});

test('fullscreen viewer is modal, zooms by buttons and keys, downloads separately and releases on Escape', async () => {
  const app = await previewClient();
  app.run(`globalThis.downloads = []; downloadAttachment = (payload, node) => downloads.push([payload.name, node]);
    globalThis.calls = []; api = async path => { calls.push(path); return {}; };`);
  const trigger = await openViewer(app);
  const dialog = app.nodes.get('#image-viewer'), stage = app.nodes.get('#image-stage');
  assert.equal(dialog.open, true);
  assert.equal(app.document.activeElement, app.nodes.get('#close-image-viewer'));
  assert.equal(app.run('created'), 2); // The viewer owns its own validated URL.
  const image = stage.children.at(-1);
  assert.equal(image.tagName, 'img');
  assert.equal(image.alt, 'Image attachment');
  assert.equal(app.nodes.get('#image-viewer-status').textContent, '');
  assert.equal(app.nodes.get('#image-zoom-out').disabled, true);
  app.nodes.get('#image-zoom-in').emit('click');
  assert.equal(app.run('imageViewer.zoom'), 1.5);
  assert.equal(app.nodes.get('#image-zoom-fit').textContent, '150%');
  const keys = key => dialog.emit('keydown', {key, preventDefault() {}});
  keys('+'); keys('='); assert.equal(app.run('imageViewer.zoom'), 3);
  keys('-'); assert.equal(app.run('imageViewer.zoom'), 2);
  keys('+'); keys('+'); keys('+'); assert.equal(app.run('imageViewer.zoom'), 4);
  assert.equal(app.nodes.get('#image-zoom-in').disabled, true);
  keys('0'); assert.equal(app.run('imageViewer.zoom'), 1);
  stage.emit('dblclick'); assert.equal(app.run('imageViewer.zoom'), 2);
  app.nodes.get('#image-zoom-fit').emit('click'); assert.equal(app.run('imageViewer.zoom'), 1);
  dialog.emit('keydown', {key: '+', ctrlKey: true, preventDefault() { throw new Error('browser zoom must stay native'); }});
  app.nodes.get('#image-download').emit('click');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(downloads.map(item => item[0]))')), ['image.png']);
  assert.equal(app.run('downloads[0][1]'), app.nodes.get('#image-viewer-error'));
  dialog.emit('cancel', {});
  assert.equal(dialog.open, false);
  assert.equal(app.run('revoked.includes("blob:synthetic-2")'), true);
  assert.equal(stage.children.includes(image), false);
  assert.equal(image.src, '');
  assert.equal(app.document.activeElement, trigger);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), []);
  assert.equal(app.run('created - revoked.length'), 1); // Only the inline preview remains.
  app.run('mediaPreviews.clear()');
});

test('viewer blocks read confirmations underneath and closes on chat switch, session loss and pagehide', async () => {
  for (const action of ['chat', 'session', 'pagehide']) {
    const app = await previewClient();
    await openViewer(app);
    const node = app.nodes.get('#message-list').children[0];
    app.run('node => { visibleMessageNodes.add(node); }')(node);
    assert.equal(app.run('node => readableNow(node)')(node), false);
    if (action === 'chat') app.run('selectChat(null)');
    if (action === 'session') app.run('identity.token = null; updateIdentityUi()');
    if (action === 'pagehide') app.windowEvents.get('pagehide')();
    assert.equal(app.nodes.get('#image-viewer').open, false, action);
    assert.equal(app.run('imageViewer.url'), null);
    assert.equal(app.run('revoked.includes("blob:synthetic-2")'), true);
  }
});

test('corrupted or forged images show a viewer error, keep Download and leave no URL', async () => {
  const app = await previewClient();
  await flushPreviews(app);
  app.run(`fixture.data = btoa('<html>not an image</html>'); fixture.size = atob(fixture.data).length;
    globalThis.downloads = []; downloadAttachment = payload => downloads.push(payload.name);`);
  app.preview.children.at(-1).emit('click', {stopPropagation() {}});
  await flushAsync();
  assert.match(app.nodes.get('#image-viewer-status').textContent, /cannot be displayed/);
  assert.equal(app.run('imageViewer.url'), null);
  assert.equal(app.run('created'), 1);
  assert.equal(app.nodes.get('#image-zoom-in').disabled, true);
  app.nodes.get('#image-download').emit('click');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(downloads)')), ['image.png']);
  app.nodes.get('#close-image-viewer').emit('click');
  assert.equal(app.nodes.get('#image-viewer').open, false);
  app.run('mediaPreviews.clear()');
});

test('late viewer decoding after close or a replacement image cannot resurrect or leak URLs', async () => {
  const app = await previewClient();
  await flushPreviews(app);
  const create = app.document.createElement, pending = [];
  app.document.createElement = tag => {
    const node = create(tag);
    if (tag === 'img') node.decode = () => new Promise(resolve => pending.push(resolve));
    return node;
  };
  const open = app.preview.children.at(-1);
  open.emit('click', {stopPropagation() {}});
  open.emit('click', {stopPropagation() {}});
  assert.equal(app.run('revoked.includes("blob:synthetic-2")'), true);
  app.nodes.get('#image-viewer').close();
  for (const resolve of pending) resolve();
  await flushAsync();
  assert.equal(app.nodes.get('#image-stage').children.some(node => node.tagName === 'img'), false);
  assert.equal(app.run('created - revoked.length'), 1);
  app.run('mediaPreviews.clear()');
});

async function composerClient() {
  const app = await previewClient();
  const bytes = fs.readFileSync('tests/fixtures/media/valid.png');
  app.run(`globalThis.order = []; assertTrustedPeer = async peer => { order.push('trust:' + peer.public_id); };`);
  const file = (type = 'image/png', size = bytes.length) => ({ name: 'photo.png', type, size,
    arrayBuffer: async () => { app.run('order.push("read")'); return new Uint8Array(bytes).buffer; } });
  const stage = selected => {
    const input = app.nodes.get('#attachment-input');
    input.files = [selected];
    input.emit('change');
  };
  return {...app, file, stage};
}

test('pre-send image preview checks peers before reading, keeps drafts and uploads nothing', async () => {
  const app = await composerClient();
  app.run(`globalThis.calls = []; api = async path => { calls.push(path); return {}; };`);
  app.nodes.get('#message-input').value = 'caption draft';
  app.stage(app.file());
  assert.equal(app.nodes.get('#attachment-size').textContent, '68 B · Preparing image preview…'.replace('68 B', app.run('fileSize(selectedFile.size)')));
  await flushAsync();
  const tile = app.nodes.get('#attachment-tile');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(order)')), ['trust:peer-a', 'trust:peer-b', 'read']);
  assert.equal(tile.children.at(-1).className, 'attachment-thumb');
  assert.equal(tile.children.at(-1).alt, '');
  assert.equal(tile.attributes.get('has-thumbnail'), true);
  assert.match(app.nodes.get('#attachment-size').textContent, /Image attachment$/);
  assert.equal(app.nodes.get('#message-input').value, 'caption draft');
  assert.equal(app.nodes.get('#send-button').textContent, 'Send file');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), []);
  app.nodes.get('#attachment-cancel').emit('click');
  assert.equal(app.run('created - revoked.length'), 0);
  assert.equal(tile.children.length, 0);
  assert.equal(app.nodes.get('#message-input').value, 'caption draft');
});

test('pre-send preview skips untrusted peers, unsupported files and corrupted images without blocking the file', async () => {
  for (const variant of ['untrusted', 'pdf', 'corrupt']) {
    const app = await composerClient();
    if (variant === 'untrusted') app.run('assertTrustedPeer = async () => { throw new ClientError("changed"); }');
    const selected = variant === 'pdf' ? app.file('application/pdf') : app.file();
    if (variant === 'corrupt') selected.arrayBuffer = async () => new Uint8Array(32).buffer;
    app.stage(selected);
    await flushAsync();
    assert.equal(app.run('order.includes("read")'), false, variant);
    assert.equal(app.run('created'), 0, variant);
    assert.equal(app.run('selectedFile'), selected, variant);
    assert.match(app.nodes.get('#attachment-size').textContent,
      variant === 'pdf' ? /File attachment$/ : /Image preview unavailable$/, variant);
  }
});

test('rapid cancellation, replacement and chat switching discard stale pre-send previews', async () => {
  for (const action of ['cancel', 'replace', 'chat', 'decode-chat']) {
    const app = await composerClient();
    let release;
    const first = app.file();
    if (action !== 'decode-chat') first.arrayBuffer = () => new Promise(resolve => {
      release = () => resolve(new Uint8Array(fs.readFileSync('tests/fixtures/media/valid.png')).buffer);
    });
    else {
      const create = app.document.createElement;
      app.document.createElement = tag => {
        const node = create(tag);
        if (tag === 'img') node.decode = () => new Promise(resolve => { release = resolve; });
        return node;
      };
    }
    app.stage(first);
    await flushAsync();
    if (action === 'cancel') app.nodes.get('#attachment-cancel').emit('click');
    if (action === 'replace') app.stage(app.file('text/plain'));
    if (action === 'chat' || action === 'decode-chat') app.run('selectChat(null)');
    release();
    await flushAsync();
    assert.equal(app.nodes.get('#attachment-tile').children.length, 0, action);
    assert.equal(app.run('created - revoked.length'), 0, action);
  }
});

test('sending a previewed image clears its URL and preserves the existing durable send path', async () => {
  const app = await composerClient();
  app.stage(app.file());
  await flushAsync();
  assert.equal(app.run('created'), 1);
  app.run(`identity.retryWindowSeconds = 3600;
    encryptForRecipient = async () => 'c'.repeat(32);
    deviceLock = async (_, action) => action();
    readHistoryRecords = async () => [];
    globalThis.persisted = [];
    persistOutbox = async record => { persisted.push(record); };
    storeOutgoing = async () => {}; flushOutbox = async () => {}; renderOutbox = async () => {};`);
  app.nodes.get('#message-input').value = '';
  await app.nodes.get('#message-form').emit('submit', {preventDefault() {}});
  assert.equal(app.run('persisted.length'), 1);
  assert.equal(app.run('persisted[0].media.mime'), 'image/png');
  assert.equal(app.run('persisted[0].payload.type'), 'attachment-ref');
  assert.equal(app.run('selectedFile'), null);
  assert.equal(app.run('created - revoked.length'), 0);
});

function reducingClient(app) {
  const jpeg = fs.readFileSync('tests/fixtures/media/valid.jpg');
  const png = Buffer.alloc(3 * 1024 * 1024);
  // Header-only large PNG, like a browser clipboard copy of a decoded photo.
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(3000, 16); png.writeUInt32BE(2000, 20);
  app.run(`globalThis.File = class {
      constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; this.size = parts[0].length; }
      async arrayBuffer() { return new Uint8Array(this.parts[0]).buffer; } };
    globalThis.bitmaps = { decoded: 0, closed: 0 };
    globalThis.createImageBitmap = async () => { bitmaps.decoded++; order.push('decode');
      return { width: 3000, height: 2000, close() { bitmaps.closed++; } }; };`);
  const create = app.document.createElement;
  const encoders = [];
  app.document.createElement = tag => {
    if (tag !== 'canvas') return create(tag);
    return { getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob(resolve, type) {
      const deliver = () => resolve({ type, size: jpeg.length, arrayBuffer: async () => new Uint8Array(jpeg).buffer });
      if (app.holdEncoding) encoders.push(deliver); else deliver();
    } };
  };
  const pasted = (size = png.length) => ({ name: 'image.png', type: 'image/png', size,
    arrayBuffer: async () => { app.run('order.push("read")'); return new Uint8Array(png).buffer; } });
  const paste = file => app.nodes.get('#conversation').emit('paste', {
    clipboardData: { files: [file], types: ['Files'] }, preventDefault() {} });
  return { pasted, paste, encoders };
}

test('copying a chat image and pasting it back reduces the oversized PNG to a sendable JPEG before Send', async () => {
  const app = await composerClient();
  const { pasted, paste } = reducingClient(app);
  app.nodes.get('#message-input').value = 'draft stays';
  paste(pasted());
  assert.equal(app.nodes.get('#composer-error').hidden, true);
  assert.equal(app.nodes.get('#send-button').disabled, true);
  assert.equal(app.nodes.get('#send-button').textContent, 'Reducing…');
  assert.equal(app.nodes.get('#attachment-size').textContent, '3.0 MiB · Reducing image for sending…');
  app.run(`globalThis.sent = 0; persistOutbox = async () => { sent++; };`);
  await app.nodes.get('#message-form').emit('submit', {preventDefault() {}});
  assert.equal(app.run('sent'), 0);
  await flushAsync(); await flushAsync();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(order)')), ['trust:peer-a', 'trust:peer-b', 'read', 'decode']);
  assert.equal(app.run('selectedFile.name'), 'image.jpg');
  assert.equal(app.run('selectedFile.type'), 'image/jpeg');
  assert.ok(app.run('selectedFile.size <= sendableFileBytes(7)'));
  assert.equal(app.nodes.get('#attachment-label').textContent, 'image.jpg');
  assert.match(app.nodes.get('#attachment-size').textContent, /· Optimized from 3\.0 MiB$/);
  assert.equal(app.nodes.get('#attachment-tile').children.at(-1).className, 'attachment-thumb');
  assert.equal(app.nodes.get('#send-button').disabled, false);
  assert.equal(app.nodes.get('#send-button').textContent, 'Send file');
  assert.equal(app.nodes.get('#message-input').value, 'draft stays');
  assert.equal(app.run('bitmaps.closed'), 1);
});

test('image reduction is cancelled by removal, replacement or chat switching without swapping files', async () => {
  for (const action of ['cancel', 'replace', 'chat']) {
    const app = await composerClient();
    const { pasted, paste, encoders } = reducingClient(app);
    app.holdEncoding = true;
    paste(pasted());
    await flushAsync(); await flushAsync();
    assert.equal(encoders.length, 1, action);
    if (action === 'cancel') app.nodes.get('#attachment-cancel').emit('click');
    if (action === 'replace') paste({ name: 'notes.txt', type: 'text/plain', size: 10 });
    if (action === 'chat') app.run('selectChat(null)');
    encoders.forEach(deliver => deliver());
    await flushAsync(); await flushAsync();
    assert.equal(app.run('composerPreview.optimizing'), false, action);
    assert.equal(app.run('selectedFile?.name ?? null'), action === 'replace' ? 'notes.txt' : null, action);
    assert.equal(app.run('created - revoked.length'), 0, action);
    assert.equal(app.run('bitmaps.closed'), 1, action);
  }
});

test('failed reduction or changed peer keys remove the oversized image with an inline error and never read it', async () => {
  for (const variant of ['undecodable', 'untrusted']) {
    const app = await composerClient();
    const { pasted, paste } = reducingClient(app);
    if (variant === 'undecodable') app.run('createImageBitmap = async () => { throw new Error("synthetic"); }');
    else app.run('assertTrustedPeer = async () => { throw new ClientError("A participant\'s encryption key changed."); }');
    paste(pasted());
    await flushAsync(); await flushAsync();
    assert.equal(app.run('selectedFile'), null, variant);
    assert.equal(app.nodes.get('#attachment-preview').hidden, true, variant);
    assert.equal(app.nodes.get('#composer-error').hidden, false, variant);
    assert.match(app.nodes.get('#composer-error').textContent,
      variant === 'untrusted' ? /key changed/ : /could not be reduced/, variant);
    assert.equal(app.run('order.includes("read")'), variant === 'undecodable', variant);
    assert.equal(app.nodes.get('#send-button').textContent, 'Send', variant);
  }
});

test('images over 20 MiB and other files over 1 MiB are rejected before reading', async () => {
  const app = await composerClient();
  const { pasted, paste } = reducingClient(app);
  paste(pasted(20 * 1024 * 1024 + 1));
  assert.match(app.nodes.get('#composer-error').textContent, /20 MiB/);
  paste({ name: 'big.pdf', type: 'application/pdf', size: 1048577 });
  assert.match(app.nodes.get('#composer-error').textContent, /1 MiB/);
  await flushAsync();
  assert.equal(app.run('order.includes("read")'), false);
  assert.equal(app.run('selectedFile'), null);
});

test('large groups reduce images that fit 1 MiB but exceed the encrypted group request budget', async () => {
  const app = await composerClient();
  const { paste } = reducingClient(app);
  app.run(`for (let i = 0; i < 6; i++) chats[0].participants.push({ public_id: 'extra-' + i, display_name: 'Peer' });
    selectChat(7);`);
  assert.ok(app.run('sendableFileBytes(7) < SidewordProtocol.MAX_FILE_BYTES'));
  const jpeg = fs.readFileSync('tests/fixtures/media/valid.jpg');
  paste({ name: 'photo.jpg', type: 'image/jpeg', size: 1_000_000, arrayBuffer: async () => {
    app.run('order.push("read")');
    const bytes = Buffer.alloc(1_000_000); jpeg.copy(bytes); return new Uint8Array(bytes).buffer; } });
  assert.equal(app.run('composerPreview.optimizing'), true);
  await flushAsync(); await flushAsync();
  assert.equal(app.run('selectedFile.name'), 'photo.jpg');
  assert.ok(app.run('selectedFile.size <= sendableFileBytes(7)'));
});
