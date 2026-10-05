"use strict";

// Public diagnostic numbers are permanent. Allocate explicitly; never derive
// them from ordering or SOFiSTiK's module-local calculation message numbers.
const CODES = Object.freeze({
  "expansion-limit": 1001,
  "macro-depth": 1002,
  "unclosed-substitution": 1003,
  "undefined-macro": 1004,
  "recursive-macro": 1005,
  "block-substitution": 1006,
  "unsupported-condition": 1007,
  "unmatched-conditional": 1008,
  "unclosed-definition": 1009,
  "invalid-macro-name": 1010,
  "include-depth": 1011,
  "missing-include": 1012,
  "unsupported-directive": 1013,
  "unclosed-conditional": 1014,
  "variable-before-declaration": 2001,
  "array-index-not-declared": 2002,
  "load-without-load-case": 3001,
  "ltd-without-task": 3002,
  "ltd-mod-without-source": 3003,
  "ltd-mod-without-target": 3004,
  "ltdg-without-task": 3005,
  "tributary-record-without-area": 3006,
  "vertex-without-polygon": 4001,
  "combination-record-without-combination": 5001,
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
      .split(/[\s,]+/)
      .filter((part) => /^\d+$/.test(part))
      .map(Number),
  );
}

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
  const rows = new Map();
  const lineIgnores = (location) => {
    if (!location) return new Set();
    const text = sources.get(location.uri);
    if (text === undefined) return new Set();
    if (!rows.has(location.uri)) rows.set(location.uri, text.split(/\r?\n/));
    const line = rows.get(location.uri)[location.range.start.line] || "";
    const match = comment(line).match(/\bnoqa\b(.*)$/i);
    if (!match) return new Set();
    const tail = match[1].trim();
    return tail.startsWith(":") ? ignoredCodes(tail.slice(1)) : null;
  };
  return diagnostics.flatMap((diagnostic) => {
    const rule = diagnostic.code;
    const code = codeFor(rule);
    if (global === null || global.has(code)) return [];
    const locations = [
      diagnostic.data?.recordOrigin,
      diagnostic.data?.invocation,
      { uri: diagnostic.uri || uri, range: diagnostic.range },
    ];
    if (
      locations.some((location) => {
        const ignored = lineIgnores(location);
        return ignored === null || ignored.has(code);
      })
    )
      return [];
    const item = { ...diagnostic };
    delete item.uri;
    return [{ ...item, code, data: { ...item.data, rule } }];
  });
}

module.exports = { CODES, codeFor, ignoredCodes, filterDiagnostics, comment, commentIndex };
