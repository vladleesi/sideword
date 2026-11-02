"use strict";

// Local link detection and display policy for decrypted text. It performs no network access,
// storage or payload changes; callers render the results with DOM properties only.
(() => {
  // Longer address-like runs stay plain text; text payloads are already capped at 16000 bytes.
  const MAX_URL_LENGTH = 4096;
  const MAX_LINKS = 100;
  const SCHEME = /https?:\/\//giu;
  // Whitespace, controls, invisible format characters (bidi overrides, zero-width marks) and
  // full-width sentence punctuation end a URL.
  const STOP = /[\s\p{Cc}\p{Cf}<>"`。，、！？：；「」『』【】（）《》〈〉]/u;
  const WORD_BEFORE = /[\p{L}\p{N}_]$/u;
  const TRAILING = new Set([...".,:;!?'\"*_~…。，、！？：；»”’›」』】〉》"]);
  const CLOSING = { ")": "(", "]": "[", "}": "{" };
  const IDEOGRAPHIC_DOTS = /[．｡]/gu;
  // Non-Latin letters commonly used to imitate lowercase Latin hostnames.
  const LATIN_LOOKALIKES = new Set([..."аеорсухѕіјԁӏһԛԝүοινρακօսհո"]);
  const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u,
    /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u];

  function trimTrailing(candidate) {
    const counts = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
    for (const character of candidate) if (character in counts) counts[character]++;
    let end = candidate.length;
    while (end > 0) {
      const character = candidate[end - 1];
      if (TRAILING.has(character)) { end--; continue; }
      const opening = CLOSING[character];
      if (opening && counts[character] > counts[opening]) { counts[character]--; end--; continue; }
      break;
    }
    return candidate.slice(0, end);
  }

  // The typed host keeps Unicode readable; it is used only when it parses to the same host.
  function typedHost(candidate, asciiHost) {
    const authority = candidate.slice(candidate.indexOf("//") + 2).split(/[/?#\\]/u, 1)[0];
    let host = authority.slice(authority.lastIndexOf("@") + 1);
    host = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/u, "");
    host = host.replace(IDEOGRAPHIC_DOTS, ".").toLowerCase();
    if (host.includes("%")) return asciiHost;
    try { return new URL(`https://${host}`).hostname === asciiHost ? host : asciiHost; }
    catch { return asciiHost; }
  }

  function hostWarnings(url, displayHost) {
    const warnings = [];
    if (url.username || url.password) warnings.push("Text before @ is not the site");
    if (!url.hostname.split(".").some(label => label.startsWith("xn--"))) return warnings;
    for (const label of displayHost.split(".")) {
      if (/^[\x00-\x7f]*$/u.test(label)) continue;
      const scripts = CONFUSABLE_SCRIPTS.filter(script => script.test(label)).length;
      const letters = [...label].filter(character => /\p{L}/u.test(character));
      if (scripts > 1) { warnings.push("Mixes writing systems"); break; }
      if (letters.every(character => /[a-z]/u.test(character) || LATIN_LOOKALIKES.has(character))) {
        warnings.push("Uses letters that look Latin");
        break;
      }
    }
    return warnings;
  }

  function supportedHost(hostname) {
    return hostname === "localhost" || hostname.startsWith("[")
      || (hostname.includes(".") && /[\p{L}\p{N}]/u.test(hostname.replaceAll(".", "")));
  }

  function link(start, candidate) {
    let url;
    try { url = new URL(candidate); } catch { return null; }
    if (!["http:", "https:"].includes(url.protocol) || !supportedHost(url.hostname)) return null;
    const displayHost = typedHost(candidate, url.hostname);
    return Object.freeze({
      start, end: start + candidate.length, text: candidate, href: url.href,
      protocol: url.protocol, host: url.hostname, displayHost, port: url.port,
      internationalized: displayHost !== url.hostname,
      credentials: Boolean(url.username || url.password),
      warnings: Object.freeze(hostWarnings(url, displayHost)),
    });
  }

  // Returns frozen, non-overlapping HTTP(S) links in text order.
  function findLinks(text) {
    const links = [];
    if (typeof text !== "string") return links;
    SCHEME.lastIndex = 0;
    let match;
    while (links.length < MAX_LINKS && (match = SCHEME.exec(text))) {
      const start = match.index;
      let stop = SCHEME.lastIndex;
      while (stop < text.length) {
        const character = String.fromCodePoint(text.codePointAt(stop));
        if (STOP.test(character)) break;
        stop += character.length;
      }
      SCHEME.lastIndex = stop;
      if (WORD_BEFORE.test(text.slice(Math.max(0, start - 2), start))) continue;
      const candidate = trimTrailing(text.slice(start, stop));
      if (candidate.length > MAX_URL_LENGTH) continue;
      const found = link(start, candidate);
      if (found) links.push(found);
    }
    return links;
  }

  globalThis.SidewordLinks = Object.freeze({ findLinks, MAX_URL_LENGTH, MAX_LINKS });
})();
