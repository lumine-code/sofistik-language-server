"use strict";

const MATH_RECORDS = new Set(["LET", "STO", "IF", "ELSEIF", "LOOP", "ENDLOOP"]);
const OPERATORS = /[+\-*/^&|<>=_:]/;
const DIGIT = /[0-9]/;

function allowsNumeric(slot) {
  if (!slot || ["enum", "comment", "placeholder"].includes(slot.kind)) return false;
  if (Object.hasOwn(slot, "nativePrefix"))
    return slot.nativePrefix === "" || slot.nativePrefix === "'";
  // Older schema objects cannot distinguish names such as GAXV NAME from
  // ordinary numeric keywords. Only proven numerical units are safe there.
  const code = Number(slot.dataTypeCode);
  return (code >= 1000 && code <= 1999) || code === 9999;
}

/** Find repeated mantissa dots; do not evaluate or reject CADINP expressions. */
function malformedAtoms(value) {
  const firstDot = value.indexOf(".");
  if (firstDot < 0 || value.indexOf(".", firstDot + 1) < 0) return [];
  const spans = [];
  let index = 0;
  let afterOperator = true;
  let signStart = null;
  while (index < value.length) {
    const character = value[index];
    if (OPERATORS.test(character)) {
      signStart = afterOperator && (character === "+" || character === "-") ? index : null;
      afterOperator = true;
      index++;
      continue;
    }
    if (!afterOperator || (!DIGIT.test(character) && character !== ".")) {
      // A word may be a name, path, unit suffix or an implicit function call.
      // Do not search for decimal fragments inside that identifier.
      afterOperator = false;
      signStart = null;
      index++;
      continue;
    }
    const start = signStart ?? index;
    let dots = 0;
    let digits = 0;
    while (index < value.length && (DIGIT.test(value[index]) || value[index] === ".")) {
      if (value[index] === ".") dots++;
      else digits++;
      index++;
    }
    const end = index;
    if (dots > 1 && digits > 0) {
      spans.push({ start, end });
      if (spans.length >= 100) return spans;
    }
    // E and D notation is already accepted by the language services. Native
    // CADINP also accepts incomplete E suffixes; their validation is separate.
    if (/[EeDd]/.test(value[index] || "")) {
      index++;
      if (value[index] === "+" || value[index] === "-") index++;
      while (index < value.length && DIGIT.test(value[index])) index++;
    }
    afterOperator = false;
    signStart = null;
  }
  return spans;
}

function isNumericMathRecord(record) {
  const name = record.name || record.tokens[0]?.value.toUpperCase();
  return (
    (MATH_RECORDS.has(name) && ["variable", "control"].includes(record.kind)) || name === "UNIT"
  );
}

function findInvalidNumbers(record, tokens, offset, inheritedMath = false) {
  const ownMath = isNumericMathRecord(record);
  const math = ownMath || inheritedMath;
  if (!math && !["command", "record"].includes(record.kind)) return [];
  const invalid = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "word" || token.mode !== "code") continue;
    if (math) {
      if (index === 0 && ownMath) continue;
    } else if (
      record.context.confidence === false ||
      token.role !== "value" ||
      !token.candidates?.length ||
      !token.candidates.every(({ slot }) => allowsNumeric(slot))
    )
      continue;
    for (const span of malformedAtoms(token.value)) {
      invalid.push({
        start: offset + token.start + span.start,
        end: offset + token.start + span.end,
        text:
          span.end - span.start > 64
            ? token.value.slice(span.start, span.start + 61) + "..."
            : token.value.slice(span.start, span.end),
      });
      if (invalid.length >= 100) return invalid;
    }
  }
  return invalid;
}

module.exports = { findInvalidNumbers, isNumericMathRecord };
