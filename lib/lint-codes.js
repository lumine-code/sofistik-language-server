"use strict";

const ruleCatalogue = require("./err-rules.json");

// Public diagnostic codes are permanent. Allocate explicitly; never derive
// them from ordering or SOFiSTiK's module-local calculation message numbers.
const CODES = Object.freeze({
  "expansion-limit": "G001",
  "macro-depth": "G002",
  "unclosed-substitution": "G003",
  "undefined-macro": "G004",
  "recursive-macro": "G005",
  "block-substitution": "G006",
  "unsupported-condition": "G007",
  "unmatched-conditional": "G008",
  "unclosed-definition": "G009",
  "invalid-macro-name": "G010",
  "include-depth": "G011",
  "missing-include": "G012",
  "unsupported-directive": "G013",
  "unclosed-conditional": "G014",
  "variable-before-declaration": "G101",
  "array-index-not-declared": "G102",
  "unknown-module": "G301",
  "unsupported-project-version": "G302",
  "input-size-limit": "G303",
  "orphan-enddef": "G304",
  "orphan-control": "G305",
  "unterminated-string": "G306",
  "invalid-control-nesting": "G307",
  "missing-control-condition": "G308",
  "unclosed-control": "G309",
  "invalid-number": "G310",
  "load-without-load-case": "SL001",
  "ltd-without-task": "SL002",
  "ltd-mod-without-source": "SL003",
  "ltd-mod-without-target": "SL004",
  "ltdg-without-task": "SL005",
  "tributary-record-without-area": "SL006",
  "vertex-without-polygon": "AQ001",
  "combination-record-without-combination": "MX001",
  ...Object.fromEntries(ruleCatalogue.rules.map((rule) => [rule.id, rule.code])),
});

function codeFor(rule) {
  const code = CODES[rule];
  if (code === undefined) throw new Error(`Unregistered SOFiSTiK linter rule: ${rule}`);
  return code;
}

function ignoredCodes(value) {
  const text = String(value ?? "").trim();
  if (/^(?:all|\*)$/i.test(text)) return null;
  return new Set(
    text
      .toUpperCase()
      .split(/[\s,]+/)
      .filter((part) => /^[A-Z]+\d*$/.test(part)),
  );
}

const matchesIgnore = (selected, code) =>
  selected === null ||
  [...selected].some((selector) =>
    /\d/.test(selector) ? code.startsWith(selector) : code.match(/^[A-Z]+/)?.[0] === selector,
  );

function commentIndex(text, doubledLiterals = true) {
  let quote;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        if (text[index + 1] === quote) index++;
        else quote = null;
      }
    } else if (character === "'" || character === '"') {
      const close =
        doubledLiterals && text[index + 1] === character && text[index + 2] !== character
          ? text.indexOf(character + character, index + 2)
          : -1;
      if (close >= 0) index = close + 1;
      else quote = character;
    } else if (
      (character === "!" && text[index + 1] !== "=") ||
      (character === "$" && text[index + 1] !== "(")
    )
      return index;
  }
  return text.length;
}

const comment = (text) => text.slice(commentIndex(text) + 1);

function filterDiagnostics(diagnostics, { uri, sources = new Map(), ignore } = {}) {
  const global = ignoredCodes(ignore);
  const pragmas = new Map();
  const isSuppressed = (location, code) => {
    if (!location) return false;
    const text = sources.get(location.uri);
    if (text === undefined) return false;
    if (!pragmas.has(location.uri)) {
      const entries = [];
      for (const [line, content] of text.split(/\r?\n/).entries()) {
        if (!/\bnoqa\b/i.test(content)) continue;
        const match = comment(content).match(/\bnoqa\b(.*)$/i);
        if (!match) continue;
        const tail = match[1].trim();
        entries.push({ line, selected: tail.startsWith(":") ? ignoredCodes(tail.slice(1)) : null });
      }
      pragmas.set(location.uri, entries);
    }
    const entries = pragmas.get(location.uri);
    const { start, end } = location.range;
    const last = end.line - (end.line > start.line && end.character === 0 ? 1 : 0);
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].line < start.line) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < entries.length && entries[index].line <= last; index++)
      if (matchesIgnore(entries[index].selected, code)) return true;
    return false;
  };
  return diagnostics.flatMap((diagnostic) => {
    const rule = diagnostic.code;
    const code = codeFor(rule);
    if (matchesIgnore(global, code)) return [];
    const locations = [
      ...(diagnostic.data?.recordOrigins || [diagnostic.data?.recordOrigin]),
      ...(diagnostic.data?.focusOrigins || [diagnostic.data?.focusOrigin]),
      diagnostic.data?.programAnchor,
      diagnostic.data?.invocation,
      diagnostic.data?.blockInvocation,
      ...(!diagnostic.data?.focusOrigins
        ? [{ uri: diagnostic.uri || uri, range: diagnostic.range }]
        : []),
    ];
    if (locations.some((location) => isSuppressed(location, code))) return [];
    return [{ ...diagnostic, code, data: { ...diagnostic.data, rule } }];
  });
}

module.exports = {
  CODES,
  codeFor,
  ignoredCodes,
  filterDiagnostics,
  comment,
  commentIndex,
  matchesIgnore,
};
