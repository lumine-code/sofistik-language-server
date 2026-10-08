"use strict";

const { isMathFunction } = require("./lexer");

const OPERATORS = /^[+*/^=<>!&|:-]+$/;

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
  return { generators, pending: group };
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
  if (!primary.length && !invalid.length)
    issues.push({
      ...generators[0],
      code: "inline-generator-increment",
      message: "Exactly one inline generator in a record must have a third increment argument.",
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

module.exports = { scanInlineGenerators, inlineGeneratorIssues };
