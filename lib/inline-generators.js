"use strict";

const { isMathFunction } = require("./lexer");

const OPERATORS = /^[+*/^=<>!&|:-]+$/;
const VALUE_MARKERS = /^(?:-|--|\+\+|={1,2})$/;

function canOpen(record, tokens, index, assignment) {
  const token = tokens[index];
  if (token.mode !== "code" || token.depth !== 0 || (!assignment && token.role !== "value"))
    return false;
  if (token.candidates?.length && token.candidates.every(({ slot }) => slot.kind === "placeholder"))
    return false;
  if (!["command", "record"].includes(record.kind) && !assignment) return false;
  const previous = tokens[index - 1];
  if (!previous || ["command", "param"].includes(previous.role)) return true;
  if (previous.type === "variable") return previous.end < token.start;
  // A separated marker consumes its own item (for example BEAM NO - NA
  // (...)). It does not turn the following item's generator into arithmetic.
  if (
    previous.role === "value" &&
    previous.param &&
    token.param &&
    previous.param !== token.param &&
    VALUE_MARKERS.test(previous.value)
  )
    return previous.end < token.start;
  if (previous.type === "equals") return false;
  if (previous.value === ")") return previous.end < token.start;
  if (previous.type === "word")
    return (
      previous.end < token.start &&
      !/[+*/^=<>!&|:-]$/.test(previous.value) &&
      !isMathFunction(previous.value)
    );
  return true;
}

const isGenerator = (group) => group && group.count >= 2 && !group.operator && !group.partOperator;

function generatorSpan(group, closed) {
  return { start: group.start, end: group.end, count: group.count, closed };
}

/** Keep only generator spans and an unfinished scanner across physical $$ lines. */
function scanInlineGenerators(record, tokens, offset, pending, inheritedAssignment = false) {
  const generators = [];
  const assignment =
    inheritedAssignment || (record.kind === "variable" && /^(LET|STO)$/i.test(tokens[0]?.value));
  let group = pending ? { ...pending } : null;
  for (const [index, token] of tokens.entries()) {
    if (!group) {
      if (token.value !== "(" || !canOpen(record, tokens, index, assignment)) continue;
      group = {
        start: offset + token.start,
        end: offset + token.end,
        count: 0,
        partOperator: false,
        operator: false,
      };
      continue;
    }
    if (token.value === ")" && token.depth === 0) {
      group.end = offset + token.end;
      if (isGenerator(group)) generators.push(generatorSpan(group, true));
      group = null;
      continue;
    }
    // Nested calls and array indices belong to their containing expression.
    // Units attach to the preceding value even when separated by whitespace.
    const newPart =
      !group.count ||
      (token.depth === 1 &&
        token.value !== ")" &&
        token.type !== "unit" &&
        offset + token.start > group.end);
    if (newPart) {
      group.operator ||= group.partOperator;
      group.partOperator = true;
      group.count++;
    }
    // CADINP also permits underscores between literal generator elements.
    // A variable or quoted string may contain underscores in its own name/value.
    const parts =
      token.depth === 1 && token.type === "word" && /^[-+\d.][\d.EeDd+_-]*$/.test(token.value)
        ? token.value.split(/_+/)
        : [token.value];
    for (const [partIndex, part] of parts.entries()) {
      if (partIndex) {
        group.operator ||= group.partOperator;
        group.partOperator = true;
        group.count++;
      }
      group.partOperator &&= OPERATORS.test(part);
    }
    group.end = offset + token.end;
  }
  const listSyntax = tokens.some(
    (token) =>
      token.depth === 0 &&
      (token.type === "comma" || token.type === "equals" || token.value.includes("_")),
  );
  const positions = listSyntax
    ? Object.fromEntries(
        tokens
          .filter(
            (token) =>
              token.role === "value" && token.param && Number.isInteger(token.activeParameter),
          )
          .map((token) => [token.param, token.activeParameter]),
      )
    : {};
  return { generators, pending: group, positions };
}

function isValueList(expression) {
  let depth = 0;
  let quote = null;
  let unit = false;
  let topLevel = "";
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (quote) {
      if (character === quote && expression[index + 1] === quote) index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (unit) {
      if (character === "]") unit = false;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[") unit = true;
    else if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (!depth) {
      if (character === ",") return true;
      topLevel += character;
    }
  }
  // Underscores delimit numeric lists, but are also ordinary characters in
  // variable names. Do not turn #my_array or an enum label into a list.
  return /(?:^|[^\w#])[-+]?\d[\d.EeDd+-]*(?:_+[-+]?\d[\d.EeDd+-]*)+(?=$|[^\w])/.test(topLevel);
}

/** CADINP 1.2.3/1.2.12: lists drive generation and repeat with their item. */
function trackGenerationLists(record, previous) {
  if (record.kind === "variable") {
    if (/^(LET|STO)$/.test(record.name) && isValueList(record.rhs))
      record.inlineGenerationList = true;
    return previous;
  }
  if (!["command", "record"].includes(record.kind))
    return ["program", "end"].includes(record.kind) ? null : previous;
  if (record.header) return previous?.command === record.command ? previous : null;
  const inherited = previous?.command === record.command ? previous.lists : new Map();
  const lists = new Map();
  for (const [parameter, expression] of Object.entries(record.paramExpressions)) {
    const position = record.inlineGenerationPositions?.[parameter];
    if (expression.trim() === "==" && Number.isInteger(position))
      for (const [name, listPosition] of inherited)
        if (Number.isInteger(listPosition) && listPosition >= position)
          lists.set(name, listPosition);
    if (
      isValueList(expression) ||
      (/^(?:={1,2}|\+\+|--)$/.test(expression.trim()) && inherited.has(parameter))
    )
      lists.set(parameter, position ?? inherited.get(parameter));
  }
  if (lists.size) record.inlineGenerationList = true;
  return { command: record.command, lists };
}

function inlineGeneratorIssues(record) {
  const generators = [...(record.inlineGenerators || [])];
  if (isGenerator(record.inlineGeneratorPending))
    generators.push(generatorSpan(record.inlineGeneratorPending, false));
  if (!generators.length) return [];
  const issues = generators
    .filter((generator) => !generator.closed)
    .map((generator) => ({
      ...generator,
      code: "unclosed-inline-generator",
      message: "Inline generator requires a closing ')'.",
    }));
  const invalid = generators.filter((generator) => generator.count > 3);
  for (const generator of invalid)
    issues.push({
      ...generator,
      code: "inline-generator-increment",
      message:
        "Inline generator requires two arguments, or three for the generator with an increment.",
    });
  const primary = generators.filter((generator) => generator.count === 3);
  if (!primary.length && !invalid.length && !record.inlineGenerationList)
    issues.push({
      ...generators[0],
      code: "inline-generator-increment",
      message:
        "Exactly one primary inline generator (start end increment) or a list of values is required.",
    });
  else
    for (const generator of primary.slice(1))
      issues.push({
        ...generator,
        code: "inline-generator-increment",
        message: "Only one inline generator in a record may have a third increment argument.",
      });
  return issues;
}

module.exports = { scanInlineGenerators, trackGenerationLists, inlineGeneratorIssues };
