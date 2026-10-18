"use strict";

/** A named item must be separated from a preceding list by whitespace. */
function scanTrailingCommas(record, tokens, offset) {
  const trailingCommas = [];
  if (!["command", "record"].includes(record.kind) || !record.context.confidence)
    return { trailingCommas };
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "comma" || token.mode !== "code" || token.depth !== 0) continue;
    if (
      token.role !== "value" ||
      !token.candidates?.length ||
      token.candidates.some(({ slot }) => ["comment", "placeholder"].includes(slot.kind))
    )
      continue;
    const next = tokens[index + 1];
    if (
      next?.role === "param" &&
      !next.partialParam &&
      !next.ambiguous &&
      next.depth === 0 &&
      next.start === token.end
    )
      trailingCommas.push({ start: offset + token.start, end: offset + token.end });
  }
  return { trailingCommas };
}

module.exports = { scanTrailingCommas };
