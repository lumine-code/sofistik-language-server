"use strict";

// These commands are processed by the driver rather than by CADINP records.
// SYS has conditional (*), enabled (+), disabled (-) and unprefixed forms.
function rootCommand(text) {
  if (/^\s*[+*-]?SYS(?=\s|[;!]|$)/i.test(text)) return "sys";
  if (/^\s*[+$-]?APPLY(?=\s|[;!]|$)/i.test(text)) return "apply";
  return null;
}

function applyArgumentEnd(text, start) {
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "'" || character === '"') {
      const doubled =
        text[index + 1] === character && text[index + 2] !== character
          ? text.indexOf(character + character, index + 2)
          : -1;
      if (doubled >= 0) {
        index = doubled + 1;
        continue;
      }
      const opening = index;
      for (index++; index < text.length; index++) {
        if (text[index] !== character) continue;
        if (text[index + 1] === character) index++;
        else break;
      }
      if (index >= text.length) return { end: text.length, unclosedQuote: opening };
    } else if (text.startsWith("$(", index)) {
      const close = text.indexOf(")", index + 2);
      if (close < 0) return { end: text.length };
      index = close;
    } else if (
      character === "$" ||
      character === "!" ||
      character === ";" ||
      text.startsWith("//", index)
    )
      return { end: index };
  }
  return { end: text.length };
}

module.exports = { rootCommand, applyArgumentEnd };
