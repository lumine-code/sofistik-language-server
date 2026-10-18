"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex } = require("../lib/finder");
const { LintEngine } = require("../lib/lint-engine");

const uri = "file:///project/main.dat";
const target = { version: "2026", language: "en", keywords: provider().forRelease("2026", "en") };
const program = (body, module = "SOFIMSHA") => `+PROG ${module}\n${body}\nEND\n`;
const analyze = (text, engine = new LintEngine()) =>
  engine.analyze({ uri, text, ...target }).diagnostics;
const values = (entry) =>
  entry.tokens.filter((token) => token.role === "value").map(({ value, param }) => [value, param]);

test("official cylindrical dam table repeats preserve columns and FIX enum values", () => {
  const text = program(
    "NODE NO X PHIZ Z FIX\n" +
      "1 43.25 0 0.0 PYYM\n" +
      "(2 5 1) = (6.625 13.25) =\n" +
      "6 = 53 = F\n" +
      "7 43.25 0 7.5 PYYM\n" +
      "(8 11 1) = (6.625 13.25) =\n" +
      "12 = 53 = F",
  );
  const index = createIndex(text, target);
  for (const line of [4, 7]) {
    assert.deepEqual(values(index.lines[line]), [
      [line === 4 ? "6" : "12", "NO"],
      ["=", "X"],
      ["53", "PHIZ"],
      ["=", "Z"],
      ["F", "FIX"],
    ]);
    assert.deepEqual(index.lines[line].occurrences, []);
  }
  assert.deepEqual(analyze(text), []);
});

test("enum values following repeated items retain their semantic classification", () => {
  const text = program("GRP NO FACS VAL\n1 = FULL", "ASE");
  const index = createIndex(text, target);
  assert.deepEqual(
    index.enumTokens().map(({ value, param }) => [value, param]),
    [["FULL", "VAL"]],
  );
  assert.deepEqual(index.occurrences, []);
  assert.deepEqual(analyze(text), []);
});

test("standalone repeats consume first, consecutive and last table columns", () => {
  const text = program("NODE NO X PHIZ Z FIX\n= = 53 = F\n6 = 53 = =");
  const index = createIndex(text, target);
  assert.deepEqual(values(index.lines[2]), [
    ["=", "NO"],
    ["=", "X"],
    ["53", "PHIZ"],
    ["=", "Z"],
    ["F", "FIX"],
  ]);
  assert.deepEqual(values(index.lines[3]), [
    ["6", "NO"],
    ["=", "X"],
    ["53", "PHIZ"],
    ["=", "Z"],
    ["=", "FIX"],
  ]);
  assert.deepEqual(analyze(text), []);
});

test("repeated values keep reordered columns and range checks on the following item", () => {
  const text = program("EIGE TEMP RH\n20 50\n= 110", "AQB");
  const index = createIndex(text, target);
  assert.deepEqual(values(index.lines[3]), [
    ["=", "TEMP"],
    ["110", "RH"],
  ]);
  assert.deepEqual(
    analyze(text).map(({ code }) => code),
    ["aqb-creep-humidity-range"],
  );
});

test("table repeat values survive physical continuations and semicolon records", () => {
  const text = program("NODE NO X PHIZ Z FIX\n6 = $$ continue the same row\n53 = F ; 7 = 0 = F");
  const index = createIndex(text, target);
  assert.deepEqual(values(index.lines[2]), [
    ["6", "NO"],
    ["=", "X"],
  ]);
  assert.deepEqual(values(index.lines[3]), [
    ["53", "PHIZ"],
    ["=", "Z"],
    ["F", "FIX"],
    ["7", "NO"],
    ["=", "X"],
    ["0", "PHIZ"],
    ["=", "Z"],
    ["F", "FIX"],
  ]);
  assert.deepEqual(analyze(text), []);
});

test("repeats do not hide real hash variables or attached bare expressions", () => {
  for (const row of ["6 =missing 53 = F", "=missing = 53 = F", "6 = 53 = #F"]) {
    const text = program(`NODE NO X PHIZ Z FIX\n${row}`);
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, [], row);
    assert.equal(issue.code, "variable-before-declaration", row);
    assert.match(issue.message, row.includes("#F") ? /#F / : /#MISSING /, row);
    assert.deepEqual(
      createIndex(text, target).occurrences.map(({ name }) => name.toUpperCase()),
      [row.includes("#F") ? "F" : "MISSING"],
      row,
    );
  }
  assert.deepEqual(analyze(program("LET#missing 1\nNODE NO X PHIZ Z FIX\n6 =missing 53 = F")), []);
});

test("bare expression references stop at the next positional value", () => {
  const text = program("NODE NO X PHIZ Z FIX\n6 =missing 53 0 F");
  const index = createIndex(text, target);
  assert.deepEqual(
    index.occurrences.map(({ name }) => name),
    ["missing"],
  );
  assert.deepEqual(values(index.lines[2]).slice(-3), [
    ["53", "PHIZ"],
    ["0", "Z"],
    ["F", "FIX"],
  ]);
  assert.equal(analyze(text).length, 1);
});

test("item default assignments retain their syntax beside repeated row values", () => {
  const text = program("NODE NO X=1 PHIZ Z=0 FIX\n6 = 53 = F");
  const index = createIndex(text, target);
  assert.equal(index.lines[1].records[0].tableDefinition, true);
  assert.deepEqual(index.lines[1].endState.tableHeader, ["NO", "X", "PHIZ", "Z", "FIX"]);
  assert.ok(index.lines[1].tokens.every((token) => !token.repeatValue));
  assert.equal(index.lines[2].tokens.at(-1).param, "FIX");
  assert.deepEqual(analyze(text), []);
});

test("incremental repeat and expression edits match fresh positions and findings", () => {
  const text = program("NODE NO X PHIZ Z FIX\n6 = 53 = F");
  const index = createIndex(text, target);
  const engine = new LintEngine();
  assert.deepEqual(analyze(text, engine), []);
  for (const row of ["6 =missing 53 = F", "6 = 53 = F"]) {
    index.applyChanges([
      {
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: index.lines[2].text.length },
        },
        text: row,
      },
    ]);
    const fresh = createIndex(index.text, target);
    assert.deepEqual(index.lines[2].tokens, fresh.lines[2].tokens);
    assert.deepEqual(index.occurrences, fresh.occurrences);
    assert.deepEqual(analyze(index.text, engine), analyze(index.text));
    assert.equal(analyze(index.text).length, row.includes("missing") ? 1 : 0);
  }
});
