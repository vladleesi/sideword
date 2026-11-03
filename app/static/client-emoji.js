"use strict";

// Emoji helpers and the composer's emoji picker. Emoji stay ordinary Unicode text inside the
// encrypted `text` payload. Apart from fetching its own static catalog, this file makes no
// network requests; it renders only through DOM properties and stores nothing but this
// device's recently used emoji.
(() => {
  // Same-origin static file, fetched on first picker open so page startup does not pay for it.
  // Category entries: [id, label, tab icon, "emoji name[:extra keywords]|..."], curated from
  // the Unicode RGI emoji set in default (untoned) form.
  const CATALOG_URL = "/static/emoji-catalog.json?v=1";
  const RECENT_KEY = "sideword-client-recent-emoji";
  const MAX_RECENT = 24;
  const MAX_STORED_RECENT_LENGTH = 2048;
  const MAX_RESULTS = 120;
  const MAX_QUERY_LENGTH = 40;
  // The longest RGI sequences (tag flags, kiss/couple ZWJ sequences) stay well below this.
  const MAX_EMOJI_LENGTH = 32;
  // Messages of one to three emoji are shown larger; longer text never qualifies.
  const MAX_LARGE_EMOJI = 3;
  const MAX_LARGE_TEXT_LENGTH = 128;
  // One displayed emoji: a tag-sequence flag, keycap, country flag, or a (ZWJ sequence of)
  // pictographs shown as emoji by default, with VS16 or with a skin tone. Text-style symbols
  // such as "©" or "1" without VS16 and unpaired regional indicators stay ordinary text.
  const PICTOGRAPH = String.raw`(?!\p{Regional_Indicator})(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}|\p{Emoji_Presentation}\uFE0F?|\p{Extended_Pictographic}\uFE0F)`;
  const SEQUENCE = String.raw`(?:\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|${PICTOGRAPH}(?:\u200D(?:${PICTOGRAPH}|\p{Extended_Pictographic}))*)`;
  const EMOJI = new RegExp(`^${SEQUENCE}$`, "u");
  const EMOJI_RUN = new RegExp(SEQUENCE, "gu");
  const encoder = new TextEncoder();
  const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

  function isEmoji(candidate) {
    return typeof candidate === "string" && candidate.length <= MAX_EMOJI_LENGTH && EMOJI.test(candidate);
  }

  // Returns 1–3 when the text consists only of that many emoji (whitespace allowed), else 0.
  function largeEmojiCount(messageText) {
    if (typeof messageText !== "string" || messageText.length > MAX_LARGE_TEXT_LENGTH) return 0;
    const compact = messageText.replace(/\s+/gu, "");
    const matches = compact ? compact.match(EMOJI_RUN) || [] : [];
    if (!matches.length || matches.length > MAX_LARGE_EMOJI || matches.join("") !== compact) return 0;
    return matches.length;
  }

  // Moves an offset inside a grapheme cluster (between surrogates or within a ZWJ sequence)
  // to the cluster's start or end, so an insertion never splits an existing character.
  function graphemeBoundary(draft, offset, towardEnd) {
    if (offset <= 0 || offset >= draft.length) return offset;
    if (segmenter) {
      const cluster = segmenter.segment(draft).containing(offset);
      if (!cluster || cluster.index === offset) return offset;
      return towardEnd ? cluster.index + cluster.segment.length : cluster.index;
    }
    const code = draft.charCodeAt(offset);
    const previous = draft.charCodeAt(offset - 1);
    const splitsPair = code >= 0xDC00 && code <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF;
    return splitsPair ? offset + (towardEnd ? 1 : -1) : offset;
  }

  // Replaces the selection (or inserts at the caret) with a whole emoji. Returns null instead of
  // a truncated draft when the result would exceed either limit.
  function insertIntoDraft(draft, selectionStart, selectionEnd, emoji, { maxLength = Infinity, maxBytes = Infinity } = {}) {
    const clamp = offset => Number.isInteger(offset) ? Math.min(Math.max(offset, 0), draft.length) : draft.length;
    let start = clamp(selectionStart);
    let end = Number.isInteger(selectionEnd) ? clamp(selectionEnd) : start;
    if (start > end) [start, end] = [end, start];
    // A caret stays a caret: it moves before the cluster it is in. A selection widens to whole clusters.
    const collapsed = start === end;
    start = graphemeBoundary(draft, start, false);
    end = collapsed ? start : graphemeBoundary(draft, end, true);
    const nextDraft = draft.slice(0, start) + emoji + draft.slice(end);
    if (nextDraft.length > maxLength || encoder.encode(nextDraft).length > maxBytes) return null;
    return { draft: nextDraft, start, end, caret: start + emoji.length };
  }

  // Validates the catalog's shape; entries that are not single emoji are dropped.
  function parseCatalog(groups) {
    if (!Array.isArray(groups)) throw new TypeError("Invalid emoji catalog.");
    return groups.map(group => {
      if (!Array.isArray(group) || group.length !== 4 || !group.every(part => typeof part === "string")
          || !/^[a-z]{1,20}$/.test(group[0])) throw new TypeError("Invalid emoji catalog.");
      const [id, label, icon, packed] = group;
      const items = packed.split("|").map(entry => {
        const space = entry.indexOf(" ");
        const [name, keywords = ""] = entry.slice(space + 1).split(":");
        return { emoji: entry.slice(0, space), name, terms: ` ${name} ${keywords}` };
      }).filter(item => item.name && isEmoji(item.emoji));
      return { id, label, icon, items };
    });
  }

  let catalog = null;
  let catalogRequest = null;
  // One request at a time; a failed load is retried on the next open.
  function loadCatalog(fetcher = globalThis.fetch) {
    if (catalog) return Promise.resolve(catalog);
    catalogRequest ||= Promise.resolve()
      .then(() => fetcher(CATALOG_URL, { credentials: "omit" }))
      .then(response => {
        if (!response.ok) throw new Error("The emoji list could not be loaded.");
        return response.json();
      })
      .then(groups => (catalog = parseCatalog(groups)))
      .finally(() => { catalogRequest = null; });
    return catalogRequest;
  }

  // Every search term must occur in the name or keywords; word-start matches rank first.
  function searchEmoji(groups, query, limit = MAX_RESULTS) {
    const terms = String(query).toLowerCase().slice(0, MAX_QUERY_LENGTH).split(/\s+/u).filter(Boolean);
    if (!terms.length) return [];
    const wordMatches = [], otherMatches = [];
    for (const group of groups) {
      for (const item of group.items) {
        if (!terms.every(term => item.terms.includes(term))) continue;
        (terms.every(term => item.terms.includes(` ${term}`)) ? wordMatches : otherMatches).push(item);
      }
    }
    return [...wordMatches, ...otherMatches].slice(0, limit);
  }

  function localStore() {
    try { return globalThis.localStorage || null; } catch { return null; }
  }

  function readRecent(storage = localStore()) {
    try {
      const stored = storage?.getItem(RECENT_KEY);
      if (!stored || stored.length > MAX_STORED_RECENT_LENGTH) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? [...new Set(parsed.filter(isEmoji))].slice(0, MAX_RECENT) : [];
    } catch { return []; }
  }

  function rememberRecent(recent, emoji, storage = localStore()) {
    const updated = [emoji, ...recent.filter(item => item !== emoji)].slice(0, MAX_RECENT);
    try { storage?.setItem(RECENT_KEY, JSON.stringify(updated)); } catch { /* Recents stay in memory. */ }
    return updated;
  }

  function forgetRecent(storage = localStore()) {
    try { storage?.removeItem(RECENT_KEY); } catch { /* Nothing stored. */ }
  }

  // Wires the static picker markup to the composer. The grid is built after the first open.
  function createPicker({ toggle, panel, input, search, categories, grid, status, maxBytes, onInsert, onLimit,
    fetcher = globalThis.fetch }) {
    let recent = readRecent();
    let recentChanged = true;
    let groups = null;
    let recentSection = null;
    let resultsSection = null;
    const sections = [];

    function section(id, label) {
      const node = document.createElement("div");
      node.className = "emoji-section";
      node.setAttribute("role", "group");
      node.setAttribute("aria-labelledby", `emoji-section-${id}`);
      const title = document.createElement("p");
      title.className = "emoji-section-title";
      title.id = `emoji-section-${id}`;
      title.textContent = label;
      const list = document.createElement("div");
      list.className = "emoji-options";
      node.append(title, list);
      grid.append(node);
      return { node, list };
    }

    function option(item) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-option";
      button.tabIndex = -1;
      button.textContent = item.emoji;
      button.title = item.name;
      button.setAttribute("aria-label", item.name);
      return button;
    }

    function categoryButton(label, icon, target) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-category";
      button.textContent = icon;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => {
        if (search.value) { search.value = ""; showResults(); }
        grid.scrollTop = target.node.offsetTop;
        focusOption(target.list.firstChild, false);
      });
      return button;
    }

    function build(loadedGroups) {
      groups = loadedGroups;
      grid.replaceChildren();
      recentSection = section("recent", "Recently used");
      resultsSection = section("results", "Search results");
      resultsSection.node.hidden = true;
      recentSection.button = categoryButton("Recently used", "\u{1F552}", recentSection);
      categories.replaceChildren(recentSection.button);
      recentSection.names = new Map();
      for (const group of groups) {
        const target = section(group.id, group.label);
        target.list.append(...group.items.map(option));
        for (const item of group.items) recentSection.names.set(item.emoji, item);
        sections.push(target);
        categories.append(categoryButton(group.label, group.icon, target));
      }
      recentChanged = true;
    }

    function renderRecent() {
      if (!recentChanged || !recentSection) return;
      recentChanged = false;
      const items = recent.map(emoji => recentSection.names.get(emoji) || { emoji, name: "Emoji" });
      recentSection.list.replaceChildren(...items.map(option));
      recentSection.node.hidden = !items.length || Boolean(search.value.trim());
      recentSection.button.hidden = !items.length;
    }

    function visibleOptions() {
      if (!groups) return [];
      const visible = [recentSection, resultsSection, ...sections].filter(target => !target.node.hidden);
      return visible.flatMap(target => [...target.list.children]);
    }

    // Roving focus: one option is in the tab order; arrow keys move between options.
    function focusOption(button, moveFocus = true) {
      if (!button) return;
      for (const candidate of grid.querySelectorAll(".emoji-option[tabindex='0']")) candidate.tabIndex = -1;
      button.tabIndex = 0;
      if (moveFocus) { button.focus({ preventScroll: true }); button.scrollIntoView?.({ block: "nearest" }); }
    }

    function showResults() {
      if (!groups) return;
      const query = search.value.trim();
      const searching = Boolean(query);
      for (const target of sections) target.node.hidden = searching;
      recentSection.node.hidden = searching || !recent.length;
      resultsSection.node.hidden = !searching;
      const results = searching ? searchEmoji(groups, query) : [];
      resultsSection.list.replaceChildren(...results.map(option));
      status.textContent = searching ? (results.length ? `${results.length} emoji found` : "No emoji found") : "";
      grid.scrollTop = 0;
      focusOption(visibleOptions()[0], false);
    }

    function open(moveFocus) {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      if (moveFocus) search.focus({ preventScroll: true });
      if (groups) { renderRecent(); return Promise.resolve(); }
      status.textContent = "Loading emoji…";
      return loadCatalog(fetcher).then(loadedGroups => {
        if (!groups) build(loadedGroups);
        renderRecent();
        showResults();
        if (!search.value.trim()) status.textContent = "";
      }, () => {
        status.textContent = "Emoji could not be loaded. Close and reopen the picker to try again.";
      });
    }

    function close(restoreFocus = false) {
      if (panel.hidden) return;
      const focusInside = panel.contains(document.activeElement);
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (search.value) { search.value = ""; showResults(); }
      if ((restoreFocus || focusInside) && !input.disabled) input.focus({ preventScroll: true });
    }

    function choose(button) {
      const emoji = button.textContent;
      if (!isEmoji(emoji)) return false;
      const maxLength = input.maxLength > 0 ? input.maxLength : Infinity;
      const result = insertIntoDraft(input.value, input.selectionStart, input.selectionEnd, emoji, { maxLength, maxBytes });
      if (!result) { onLimit?.(); return false; }
      if (typeof input.setRangeText === "function") input.setRangeText(emoji, result.start, result.end, "end");
      else { input.value = result.draft; input.selectionStart = input.selectionEnd = result.caret; }
      recent = rememberRecent(recent, emoji);
      recentChanged = true;
      if (typeof Event === "function") input.dispatchEvent(new Event("input", { bubbles: true }));
      onInsert?.(emoji);
      return true;
    }

    // Keep focus (and the on-screen keyboard) in the field being typed in while tapping buttons.
    function keepTypingFocus(event) {
      const active = document.activeElement;
      if ((active === input || active === search) && event.target?.closest?.("button")) event.preventDefault();
    }

    // Keyboard activation (click detail 0) moves focus into the picker; taps and clicks do not.
    toggle.addEventListener("click", event => {
      if (panel.hidden) void open(event.detail === 0);
      else close(event.detail === 0);
    });
    toggle.addEventListener("mousedown", keepTypingFocus);
    panel.addEventListener("mousedown", keepTypingFocus);
    grid.addEventListener("click", event => {
      const button = event.target?.closest?.(".emoji-option");
      if (button) { focusOption(button, false); choose(button); }
    });
    grid.addEventListener("keydown", event => {
      const button = event.target?.closest?.(".emoji-option");
      if (!button) return;
      const options = visibleOptions();
      const index = options.indexOf(button);
      const columns = Math.max(1, Math.round((button.parentElement?.clientWidth || 1) / (button.offsetWidth || 1)));
      const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + columns,
        ArrowUp: index - columns, Home: 0, End: options.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      if (event.key === "ArrowUp" && moves.ArrowUp < 0) search.focus({ preventScroll: true });
      else focusOption(options[Math.min(Math.max(moves[event.key], 0), options.length - 1)]);
    });
    search.addEventListener("input", showResults);
    search.addEventListener("keydown", event => {
      if (event.isComposing) return;
      const first = visibleOptions()[0];
      // Enter must never submit the message form from the search field.
      if (event.key === "Enter") { event.preventDefault(); if (first && search.value.trim()) choose(first); }
      else if (event.key === "ArrowDown" && first) { event.preventDefault(); focusOption(first); }
    });
    panel.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (event.target === search && search.value) { search.value = ""; showResults(); }
      else close(true);
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); close(); }
    });

    return {
      open, close, choose,
      isOpen: () => !panel.hidden,
      setEnabled(enabled) { toggle.disabled = !enabled; if (!enabled) close(); },
    };
  }

  globalThis.SidewordEmoji = Object.freeze({
    isEmoji, largeEmojiCount, insertIntoDraft, parseCatalog, loadCatalog, searchEmoji, readRecent,
    rememberRecent, forgetRecent, createPicker, CATALOG_URL, MAX_RECENT,
  });
})();
