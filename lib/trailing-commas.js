"use strict";

const { isNumericMathRecord } = require("./invalid-numbers");

/** Track an unfinished value list across physical $$ continuation lines. */
function scanTrailingCommas(record, tokens, offset, pending, inheritedMath = false) {
  const trailingCommas = [];
  if (pending && tokens[0]?.role === "param") trailingCommas.push({ ...pending });
  const math = inheritedMath || isNumericMathRecord(record);
  if (!math && (!["command", "record"].includes(record.kind) || !record.context.confidence))
    return { trailingCommas, pending: null };
  let unfinished = null;
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "comma" || token.mode !== "code" || token.depth !== 0) continue;
    if (
      !math &&
      (token.role !== "value" ||
        !token.candidates?.length ||
        token.candidates.some(({ slot }) => ["comment", "placeholder"].includes(slot.kind)))
    )
      continue;
    const span = { start: offset + token.start, end: offset + token.end };
    const next = tokens[index + 1];
    if (next?.role === "param" || (!next && !record.continued)) trailingCommas.push(span);
    else if (!next) unfinished = span;
  }
  return { trailingCommas, pending: unfinished };
}

module.exports = { scanTrailingCommas };
