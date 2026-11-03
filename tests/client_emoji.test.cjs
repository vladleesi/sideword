const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { client } = require('./client_dom.cjs');

const source = fs.readFileSync('app/static/client-emoji.js', 'utf8');
const catalogText = fs.readFileSync('app/static/emoji-catalog.json', 'utf8');
const RGI = /^\p{RGI_Emoji}$/v;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function emojiModule(intl = Intl) {
  const context = vm.createContext({ TextEncoder, Intl: intl });
  vm.runInContext(source, context);
  return context.SidewordEmoji;
}
const emoji = emojiModule();

test('every catalog entry is one standard emoji grapheme with a name, in default form', () => {
  const groups = emoji.parseCatalog(JSON.parse(catalogText));
  assert.deepEqual(Array.from(groups, group => group.id),
    ['smileys', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags']);
  const seen = new Set();
  for (const group of groups) {
    assert.ok(group.items.length > 50, group.id);
    for (const item of group.items) {
      assert.ok(RGI.test(item.emoji), item.emoji);
      assert.equal([...graphemes.segment(item.emoji)].length, 1, item.emoji);
      assert.equal(emoji.largeEmojiCount(item.emoji), 1, item.emoji);
      assert.doesNotMatch(item.emoji, /\p{Emoji_Modifier}/u, 'the picker offers default skin tones only');
      assert.match(item.name, /^[\p{Ll}\p{N} ,.'’()&*#-]+$/u, item.emoji);
      assert.ok(!seen.has(item.emoji), `duplicate ${item.emoji}`);
      seen.add(item.emoji);
    }
  }
  // ZWJ sequences, keycaps, country and subdivision flags are all present.
  for (const sample of ['🧑‍💻', '❤️‍🔥', '🏳️‍🌈', '1️⃣', '🇺🇦', '🇯🇵', '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}']) assert.ok(seen.has(sample), sample);
  // The file contains no invisible tag or bidirectional control characters.
  assert.doesNotMatch(catalogText, /[\u{E0000}-\u{E007F}\u202A-\u202E\u2066-\u2069]/u);
});

test('catalog parsing rejects malformed data and drops entries that are not single emoji', () => {
  for (const invalid of [null, {}, [['x']], [['Bad id', 'L', 'I', '']], [['ok', 'L', 'I', 5]]]) {
    assert.throws(() => emoji.parseCatalog(invalid), /Invalid emoji catalog/);
  }
  const [group] = emoji.parseCatalog([['ok', 'Label', '😀',
    '😀 grinning:smile|<img src=x> markup|ab two letters|😀😀 two emoji|👍 thumbs up|🙂 ']]);
  assert.deepEqual(Array.from(group.items, item => item.emoji), ['😀', '👍']);
  assert.equal(group.items[0].terms, ' grinning smile');
});

test('search requires every term and ranks word-start matches first', () => {
  const groups = emoji.parseCatalog(JSON.parse(catalogText));
  const found = query => Array.from(emoji.searchEmoji(groups, query), item => item.emoji);
  assert.deepEqual(found('thumbs').slice(0, 2), ['👍', '👎']);
  assert.ok(found('lol').includes('😂'));
  assert.equal(found('germany')[0], '🇩🇪');
  assert.equal(found('flag ua')[0], '🇺🇦');
  assert.ok(found('heart fire').includes('❤️‍🔥'));
  assert.deepEqual(found('   '), []);
  assert.deepEqual(found('zzzz-not-an-emoji'), []);
  assert.ok(found('a').length <= 120);
  assert.ok(found(`${'x'.repeat(10000)}`).length === 0);
});

test('one to three emoji alone are large, including skin tones, flags, keycaps and ZWJ sequences', () => {
  const count = emoji.largeEmojiCount;
  for (const [text, expected] of [
    ['😀', 1], ['👍🏽', 1], ['🇺🇦', 1], ['👨‍👩‍👧‍👦', 1], ['🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', 1], ['1️⃣', 1], ['❤️', 1], ['🏳️‍🌈', 1],
    ['🧑🏽‍💻', 1], ['👩🏻‍❤️‍💋‍👨🏿', 1], ['😀😀', 2], [' 😀 🇯🇵\n🎉 ', 3],
  ]) assert.equal(count(text), expected, text);
  for (const text of ['😀😀😀😀', 'hi 😀', '😀!', '©', '1', '#', '❤', '❤︎', '', '   ', '😀́', 'abc',
    '🇺', '‍', '😀'.repeat(100), `😀${' '.repeat(200)}`, null, undefined, 7]) {
    assert.equal(count(text), 0, JSON.stringify(text));
  }
});

for (const [label, intl] of [['Intl.Segmenter', Intl], ['surrogate fallback', {}]]) {
  test(`insertion keeps the draft, replaces only the selection and never splits graphemes (${label})`, () => {
    const helpers = emojiModule(intl);
    const insert = (draft, start, end, value, limits) => {
      const result = helpers.insertIntoDraft(draft, start, end, value, limits);
      return result && { draft: result.draft, caret: result.caret };
    };
    assert.deepEqual(insert('hello world', 5, 5, '👋'), { draft: 'hello👋 world', caret: 7 });
    assert.deepEqual(insert('hello world', 6, 11, '🌍'), { draft: 'hello 🌍', caret: 8 });
    assert.deepEqual(insert('hello world', 11, 6, '🌍'), { draft: 'hello 🌍', caret: 8 });
    assert.deepEqual(insert('', 0, 0, '🇺🇦'), { draft: '🇺🇦', caret: 4 });
    assert.deepEqual(insert('abc', undefined, undefined, '😀'), { draft: 'abc😀', caret: 5 });
    assert.deepEqual(insert('abc', 99, -4, '😀'), { draft: '😀', caret: 2 });
    // A caret between the surrogates of 😀 moves before it; a selection end inside moves after it.
    assert.deepEqual(insert('a😀b', 2, 2, '👍'), { draft: 'a👍😀b', caret: 3 });
    assert.deepEqual(insert('a😀b', 0, 2, '👍'), { draft: '👍b', caret: 2 });
    for (const result of [insert('a😀b', 2, 2, '👍'), insert('x🇺🇦y', 3, 3, '🎉')]) {
      assert.doesNotMatch(result.draft, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    if (intl === Intl) {
      // Inside a ZWJ family or a flag, the insertion moves to the cluster boundary.
      const family = '👨‍👩‍👧';
      assert.deepEqual(insert(`${family}!`, 3, 3, '😀'), { draft: `😀${family}!`, caret: 2 });
      assert.deepEqual(insert('🇺🇦', 2, 2, '😀'), { draft: '😀🇺🇦', caret: 2 });
    }
  });
}

test('insertion stops at the UTF-8 and code-unit limits instead of truncating an emoji', () => {
  const limits = { maxLength: 16000, maxBytes: 16000 };
  const full = 'a'.repeat(15996);
  assert.equal(emoji.insertIntoDraft(full, 15996, 15996, '😀', limits).draft.length, 15998);
  assert.equal(new TextEncoder().encode(emoji.insertIntoDraft(full, 0, 0, '😀', limits).draft).length, 16000);
  assert.equal(emoji.insertIntoDraft(`${full}a`, 0, 0, '😀', limits), null);
  // A multi-byte draft can hit the byte limit before the character limit.
  assert.equal(emoji.insertIntoDraft('é'.repeat(7999), 0, 0, '😀', limits), null);
  assert.equal(emoji.insertIntoDraft('x'.repeat(10), 0, 0, '🧑‍💻', { maxLength: 14 }), null);
  // Replacing a selection frees its space first.
  assert.equal(emoji.insertIntoDraft(`${full}aaaa`, 0, 4, '😀', limits).draft.length, 15998);
});

test('recent emoji are validated, deduplicated, bounded and removable', () => {
  const storage = new Map();
  const store = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key) };
  let recent = [];
  for (const value of ['😀', '👍', '😀', '🇺🇦']) recent = emoji.rememberRecent(recent, value, store);
  assert.deepEqual(Array.from(emoji.readRecent(store)), ['🇺🇦', '😀', '👍']);
  for (let index = 0; index < 40; index++) recent = emoji.rememberRecent(recent, String.fromCodePoint(0x1F600 + index), store);
  assert.equal(emoji.readRecent(store).length, emoji.MAX_RECENT);
  for (const stored of ['not json', '{"a":1}', JSON.stringify(['<b>x</b>', '😀', 7, '😀', 'text', '😀😀']),
    JSON.stringify(Array(2000).fill('😀'))]) {
    storage.set('sideword-client-recent-emoji', stored);
    assert.ok(emoji.readRecent(store).every(value => value === '😀'), stored.slice(0, 20));
    assert.ok(emoji.readRecent(store).length <= 1);
  }
  emoji.forgetRecent(store);
  assert.equal(storage.size, 0);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); } };
  assert.deepEqual(Array.from(emoji.readRecent(blocked)), []);
  assert.deepEqual(Array.from(emoji.rememberRecent([], '😀', blocked)), ['😀']);
  emoji.forgetRecent(blocked);
});

// A small DOM for the picker: focus, bubbling events, attributes and textarea selection.
function pickerHarness({ fetchFails = 0, storage = new Map() } = {}) {
  const doc = { activeElement: null };
  class Element {
    constructor(tag) {
      Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentElement: null, listeners: {},
        attributes: {}, hidden: false, className: '', text: '', tabIndex: 0, offsetTop: 0, clientWidth: 400,
        offsetWidth: 40, scrollTop: 0, disabled: false });
    }
    get textContent() { return this.children.length ? this.children.map(child => child.textContent).join('') : this.text; }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    get firstChild() { return this.children[0] || null; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    dispatchEvent(event) { (this.dispatched ||= []).push(event.type); return true; }
    emit(type, init = {}) {
      const event = { type, target: this, defaultPrevented: false, detail: 1, ...init,
        preventDefault() { event.defaultPrevented = true; } };
      for (let node = this; node; node = node.parentElement) for (const handler of node.listeners[type] || []) handler(event);
      return event;
    }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    matches(selector) {
      if (selector === 'button') return this.tagName === 'BUTTON';
      const [, className, tabIndex] = selector.match(/^\.([\w-]+)(?:\[tabindex='(\d)'\])?$/) || [];
      return Boolean(className) && this.className.split(' ').includes(className)
        && (tabIndex === undefined || this.tabIndex === Number(tabIndex));
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { doc.activeElement = this; }
  }
  doc.createElement = tag => new Element(tag);
  const input = Object.assign(new Element('textarea'), { value: '', selectionStart: 0, selectionEnd: 0, maxLength: 16000,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    } });
  const toggle = new Element('button');
  const panel = new Element('div');
  const search = Object.assign(new Element('input'), { value: '' });
  const categories = new Element('div');
  const grid = new Element('div');
  const status = new Element('p');
  panel.append(search, categories, grid, status);
  const context = vm.createContext({ TextEncoder, Intl, document: doc,
    Event: class { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key) } });
  vm.runInContext(source, context);
  const fetches = [];
  let failures = fetchFails;
  const fetcher = async (url, options) => {
    fetches.push({ url, options });
    if (failures-- > 0) throw new Error('offline');
    return { ok: true, json: async () => JSON.parse(catalogText) };
  };
  const events = { limit: 0, inserted: [] };
  const picker = context.SidewordEmoji.createPicker({ toggle, panel, input, search, categories, grid, status,
    maxBytes: 16000, fetcher, onLimit: () => events.limit++, onInsert: value => events.inserted.push(value) });
  panel.hidden = true;
  const options = () => grid.querySelectorAll('.emoji-option').filter(node => !node.parentElement.parentElement.hidden);
  const option = value => options().find(node => node.textContent === value);
  return { doc, input, toggle, panel, search, categories, grid, status, picker, fetches, events, storage, options, option,
    context };
}

test('touch or mouse opening keeps the composer focused and inserts at the caret without closing', async () => {
  const ui = pickerHarness();
  ui.input.focus();
  Object.assign(ui.input, { value: 'see you', selectionStart: 3, selectionEnd: 3 });
  // Tapping the toggle or an option must not move focus out of the textarea (keyboard stays open).
  assert.equal(ui.toggle.emit('mousedown').defaultPrevented, true);
  ui.toggle.emit('click', { detail: 1 });
  await new Promise(setImmediate);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.doc.activeElement, ui.input);
  assert.equal(ui.fetches.length, 1);
  assert.equal(ui.fetches[0].url, '/static/emoji-catalog.json?v=1');
  assert.equal(ui.fetches[0].options.credentials, 'omit');
  assert.equal(ui.status.textContent, '');
  assert.equal(ui.categories.children.length, 9);
  assert.equal(ui.categories.children[0].hidden, true, 'no recent emoji yet');
  const wave = ui.option('👋');
  assert.equal(wave.getAttribute('aria-label'), 'waving hand sign');
  assert.equal(wave.emit('mousedown').defaultPrevented, true);
  wave.emit('click');
  assert.equal(ui.input.value, 'see👋 you');
  assert.equal(ui.input.selectionStart, 5);
  assert.deepEqual(ui.input.dispatched, ['input']);
  ui.option('🇺🇦').emit('click');
  assert.equal(ui.input.value, 'see👋🇺🇦 you');
  assert.equal(ui.panel.hidden, false, 'the picker stays open for more emoji');
  assert.equal(ui.doc.activeElement, ui.input);
  assert.deepEqual(ui.events.inserted, ['👋', '🇺🇦']);
  assert.deepEqual(JSON.parse(ui.storage.get('sideword-client-recent-emoji')), ['🇺🇦', '👋']);
  // Recents appear on the next open, not under the pointer while picking.
  ui.toggle.emit('click', { detail: 1 });
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.doc.activeElement, ui.input);
  await ui.picker.open(false);
  assert.equal(ui.fetches.length, 1, 'the catalog is fetched once');
  assert.equal(ui.categories.children[0].hidden, false);
  assert.deepEqual(ui.grid.children[0].children[1].children.map(node => node.textContent), ['🇺🇦', '👋']);
  // Mouse use outside the composer keeps native focus behavior.
  ui.doc.activeElement = null;
  assert.equal(ui.option('😀').emit('mousedown').defaultPrevented, false);
});

test('picker inserts into a selection, rejects over-limit emoji and leaves the draft intact', async () => {
  const ui = pickerHarness();
  await ui.picker.open(false);
  Object.assign(ui.input, { value: 'I like cats', selectionStart: 7, selectionEnd: 11 });
  ui.option('🐈').emit('click');
  assert.equal(ui.input.value, 'I like 🐈');
  const draft = 'x'.repeat(15998);
  Object.assign(ui.input, { value: draft, selectionStart: 15998, selectionEnd: 15998 });
  ui.option('😀').emit('click');
  assert.equal(ui.input.value, draft);
  assert.equal(ui.events.limit, 1);
  assert.deepEqual(ui.events.inserted, ['🐈']);
  ui.input.value = 'x'.repeat(15996);
  ui.option('😀').emit('click');
  assert.equal(ui.input.value.length, 15998);
});

test('keyboard opening, search, arrow navigation, Enter and Escape work without submitting the form', async () => {
  const ui = pickerHarness();
  ui.toggle.focus();
  ui.toggle.emit('click', { detail: 0 });
  await new Promise(setImmediate);
  assert.equal(ui.doc.activeElement, ui.search);
  // Exactly one option is tabbable.
  assert.equal(ui.grid.querySelectorAll(".emoji-option[tabindex='0']").length, 1);
  ui.search.value = 'thumbs';
  ui.search.emit('input');
  assert.equal(ui.status.textContent, '2 emoji found');
  assert.deepEqual(ui.options().map(node => node.textContent), ['👍', '👎']);
  const down = ui.search.emit('keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(ui.doc.activeElement.textContent, '👍');
  ui.doc.activeElement.emit('keydown', { key: 'ArrowRight' });
  assert.equal(ui.doc.activeElement.textContent, '👎');
  assert.equal(ui.grid.querySelectorAll(".emoji-option[tabindex='0']").length, 1);
  ui.doc.activeElement.emit('keydown', { key: 'ArrowUp' });
  assert.equal(ui.doc.activeElement, ui.search);
  const enter = ui.search.emit('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true, 'Enter in search must not submit the message form');
  assert.equal(ui.input.value, '👍');
  // IME composition and an empty query never insert.
  ui.search.emit('keydown', { key: 'Enter', isComposing: true });
  assert.equal(ui.input.value, '👍');
  ui.search.value = 'zzzz-none';
  ui.search.emit('input');
  assert.equal(ui.status.textContent, 'No emoji found');
  assert.equal(ui.search.emit('keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.equal(ui.input.value, '👍');
  // Escape clears the query first, then closes and returns focus to the composer.
  ui.search.emit('keydown', { key: 'Escape' });
  assert.equal(ui.search.value, '');
  assert.equal(ui.panel.hidden, false);
  assert.ok(ui.options().length > 1000);
  ui.search.emit('keydown', { key: 'Escape' });
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.doc.activeElement, ui.input);
  // Escape in the composer closes an open picker.
  await ui.picker.open(false);
  assert.equal(ui.input.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(ui.panel.hidden, true);
});

test('category buttons jump to their section and clear an active search', async () => {
  const ui = pickerHarness();
  await ui.picker.open(false);
  const flags = ui.grid.children.find(node => node.attributes['aria-labelledby'] === 'emoji-section-flags');
  flags.offsetTop = 1234;
  ui.search.value = 'cat';
  ui.search.emit('input');
  const button = ui.categories.children.find(node => node.getAttribute('aria-label') === 'Flags');
  assert.equal(button.textContent, '🏳️');
  assert.equal(button.emit('mousedown').defaultPrevented, false);
  button.emit('click');
  assert.equal(ui.search.value, '');
  assert.equal(ui.grid.scrollTop, 1234);
  assert.equal(flags.children[1].children[0].tabIndex, 0);
});

test('a failed catalog load is reported and retried; disabling the composer closes the picker', async () => {
  const ui = pickerHarness({ fetchFails: 1 });
  await ui.picker.open(false);
  assert.match(ui.status.textContent, /could not be loaded/);
  assert.equal(ui.options().length, 0);
  ui.picker.close();
  await ui.picker.open(false);
  assert.equal(ui.fetches.length, 2);
  assert.equal(ui.status.textContent, '');
  assert.ok(ui.options().length > 1000);
  ui.search.focus();
  ui.picker.setEnabled(false);
  assert.equal(ui.toggle.disabled, true);
  assert.equal(ui.panel.hidden, true);
  ui.picker.setEnabled(true);
  assert.equal(ui.toggle.disabled, false);
});

test('stored recents are validated before rendering', async () => {
  const storage = new Map([['sideword-client-recent-emoji', JSON.stringify(['<img src=x>', '👍🏽', '😀', 'text'])]]);
  const ui = pickerHarness({ storage });
  await ui.picker.open(false);
  const recent = ui.grid.children[0].children[1].children;
  assert.deepEqual(recent.map(node => node.textContent), ['👍🏽', '😀']);
  assert.deepEqual(recent.map(node => node.getAttribute('aria-label')), ['Emoji', 'grinning face']);
});

function render(app, entries) {
  app.run(`persistHistoryEntry = async () => {};
    messagesByChat.set(7, ${JSON.stringify(entries)}.map(entry => ({ createdAt: 1000, ...entry })));
    renderMessages();`);
  return app.nodes.get('#message-list').children;
}

test('emoji-only messages render large through text nodes; mixed text, links and files stay normal', () => {
  const app = client();
  const rows = render(app, [
    { id: 'a', kind: 'theirs', senderPublicId: 'peer-a', text: '🎉' },
    { id: 'b', kind: 'mine', text: '👍🏽 🇺🇦 👨‍👩‍👧' },
    { id: 'c', kind: 'theirs', senderPublicId: 'peer-a', text: 'nice 🎉' },
    { id: 'd', kind: 'theirs', senderPublicId: 'peer-a', text: '😀😀😀😀' },
    { id: 'e', kind: 'theirs', senderPublicId: 'peer-a', text: 'https://example.com/🎉' },
    { id: 'f', kind: 'theirs', senderPublicId: 'peer-a', text: '🎉',
      attachment: { type: 'attachment-ref', name: 'a.txt', mime: 'text/plain', size: 1 } },
    { id: 'g', kind: 'system', text: '🎉' },
    { id: 'h', kind: 'theirs', senderPublicId: 'peer-a', text: '<img src=x onerror=alert(1)>🎉' },
  ]);
  const large = rows.map(row => [Boolean(row.messageBubble.attributes.get('emoji-only')),
    row.messageBubble.dataset.emojiCount]);
  assert.deepEqual(large, [[true, '1'], [true, '3'], [false, undefined], [false, undefined], [false, undefined],
    [false, undefined], [false, undefined], [false, undefined]]);
  assert.equal(rows[1].messageContent.textContent, '👍🏽 🇺🇦 👨‍👩‍👧');
  assert.equal(rows[7].messageContent.textContent, '<img src=x onerror=alert(1)>🎉');
  assert.ok(rows[7].messageContent.children.every(node => node.tagName === '#text'));
  // An edit to the same row recalculates the state.
  app.run(`messagesByChat.get(7)[0].text = 'party 🎉'; renderMessages();`);
  assert.equal(rows[0].messageBubble.attributes.get('emoji-only'), false);
});

test('the emoji control follows composer availability and picked emoji send through the text payload', async () => {
  const app = client();
  assert.equal(app.nodes.get('#emoji-button').disabled, false);
  app.run(`chats[0].closed_at = '2026-01-01T00:00:00Z'; selectChat(7);`);
  assert.equal(app.nodes.get('#emoji-button').disabled, true);
  app.run(`chats[0].closed_at = null; selectChat(7);`);
  assert.equal(app.nodes.get('#emoji-button').disabled, false);
  // Over the limit: an inline composer error; a later successful pick clears it.
  app.run(`elements.messageInput.value = 'x'.repeat(15998); elements.messageInput.maxLength = 16000;`);
  assert.equal(app.run(`emojiPicker.choose({ textContent: '😀' })`), false);
  assert.equal(app.nodes.get('#composer-error').hidden, false);
  assert.match(app.nodes.get('#composer-error').textContent, /16,000-byte limit/);
  app.run(`elements.messageInput.value = 'hi ';`);
  assert.equal(app.run(`emojiPicker.choose({ textContent: '👋' })`), true);
  assert.equal(app.nodes.get('#composer-error').hidden, true);
  assert.equal(app.nodes.get('#message-input').value, 'hi 👋');
  app.run(`globalThis.queued = [];
    queueEncryptedMessage = async (chat, recipients, messageId, payload, { onQueued }) => {
      queued.push(JSON.parse(SidewordProtocol.encodePayload(payload))); onQueued(); };
    flushOutbox = async () => {}; renderOutbox = async () => {}; assertTrustedPeer = async () => {};`);
  await app.nodes.get('#message-form').emit('submit', { preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(app.run('queued'))), [{ v: 1, type: 'text', text: 'hi 👋' }]);
  assert.equal(app.nodes.get('#message-input').value, '');
});

test('emoji text survives encryption and payload validation at the exact UTF-8 limit', async () => {
  const context = vm.createContext({ TextEncoder, TextDecoder, DOMException, crypto: webcrypto, btoa, atob });
  vm.runInContext(fs.readFileSync('app/static/client-protocol.js', 'utf8'), context);
  const protocol = vm.runInContext('SidewordProtocol', context);
  const identity = async publicId => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    return { publicId, privateKey: pair.privateKey, public_id: publicId, public_key: protocol.bytesToBase64(raw) };
  };
  const alice = await identity('alice'), bob = await identity('bob');
  for (const text of ['👨‍👩‍👧‍👦🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}🇺🇦 1️⃣ ❤️‍🔥 👍🏿 mixed ✓', '😀'.repeat(4000)]) {
    const plaintext = protocol.encodePayload(protocol.textPayload(text));
    const ciphertext = await protocol.encryptForRecipient(alice, plaintext, 7, 'emoji-message', bob);
    const decrypted = await protocol.decryptMessage(bob,
      { chat_id: 7, client_message_id: 'emoji-message', sender_public_id: 'alice', ciphertext }, alice);
    assert.equal(protocol.decodePayload(decrypted).text, text);
  }
  assert.equal(protocol.MAX_TEXT_BYTES, 16000);
  assert.throws(() => protocol.textPayload(`${'😀'.repeat(4000)}a`));
});

test('closing eases the panel shut before hiding it, reopening cancels that and reduced motion skips it', async () => {
  const ui = pickerHarness();
  const animations = [];
  ui.panel.offsetHeight = 256;
  ui.panel.animate = (frames, timing) => {
    const animation = { frames, timing, cancelled: false, cancel() { animation.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  await ui.picker.open(false);
  ui.search.focus();
  ui.search.value = 'cat';
  ui.picker.close();
  // Still visible while it eases shut, but already reported closed with focus back in the composer.
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.picker.isOpen(), false);
  assert.equal(ui.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.doc.activeElement, ui.input);
  assert.deepEqual(JSON.parse(JSON.stringify(animations[0].frames)),
    [{ height: '256px', opacity: 1 }, { height: '0px', opacity: 0 }]);
  assert.equal(animations[0].timing.duration, 140);
  ui.picker.close(); // A second close while closing does nothing.
  assert.equal(animations.length, 1);
  animations[0].onfinish();
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.search.value, '');
  // Reopening mid-close cancels the animation; the panel never disappears.
  await ui.picker.open(false);
  ui.picker.close();
  const closing = animations[1];
  await ui.picker.open(false);
  assert.equal(closing.cancelled, true);
  assert.equal(closing.onfinish, null);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.picker.isOpen(), true);
  // With reduced motion the panel hides at once.
  ui.context.matchMedia = query => ({ matches: query.includes('reduce') });
  ui.picker.close();
  assert.equal(ui.panel.hidden, true);
  assert.equal(animations.length, 2);
});
