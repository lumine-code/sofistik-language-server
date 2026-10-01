"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createIndex, createNavigationIndex, applyTextChanges } = require("../lib/finder");
const { provider } = require("@lumine-code/sofistik-data");

function constrainedIndex(source) {
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--expose-gc", "-e", source],
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
}

test("unfinished control and macro nesting fits a constrained heap", () => {
  constrainedIndex(String.raw`
    const assert = require("node:assert/strict");
    const { createIndex } = require("./lib/finder");
    const depth = 6000;
    const index = createIndex("+PROG ASE\n" + "IF 1\n".repeat(depth) +
      "#DEFINE nested\n".repeat(depth) + "LET#value 1\n");
    assert.equal(index.lines.at(-2).endState.controls.length, depth);
    assert.equal(index.lines.at(-2).endState.macros.length, depth);
    assert.equal(index.occurrences.at(-1).macro, "NESTED:6000");
    global.gc();
    console.log("ok");
  `);
});

test("navigation indexing does not retain tokens for large closed inputs", () => {
  constrainedIndex(String.raw`
    const assert = require("node:assert/strict");
    const { createNavigationIndex } = require("./lib/finder");
    const index = createNavigationIndex("+PROG ASE\n" +
      "GRP NO 1 VAL FULL\n".repeat(100000) + "LET#value 1\nEND\n");
    assert.equal(index.metrics.scannedLines, 100004);
    assert.equal(index.symbols().at(-1).name, "value");
    assert.equal(index.occurrences.length, 1);
    global.gc();
    console.log("ok");
  `);
});

test("stack snapshots preserve arrays and incremental nesting converges after an edit", () => {
  const target = { keywords: provider().forRelease("2026", "en") };
  const text =
    "+PROG ASE\n#DEFINE outer\nIF 1\nLOOP#i 4\n#DEFINE inner\n" +
    "LET#value #i\n#ENDDEF\nENDLOOP\nENDIF\n#ENDDEF\nHEAD #value\nEND\n";
  const index = createIndex(text, target);
  assert.deepEqual(index.lines[5].startState.macros, ["OUTER:1", "INNER:2"]);
  assert.deepEqual(index.lines[5].startState.controls, ["IF", "LOOP"]);
  assert.deepEqual(index.lines[9].endState.macros, []);
  assert.deepEqual(index.lines[8].endState.controls, []);
  assert.deepEqual(index.lines[4].records[0].before.macros, ["OUTER:1"]);
  const originalSuffix = index.lines[7];
  index.applyChanges(
    [
      {
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 8 } },
        text: "LOOP#j 4",
      },
    ],
    2,
  );
  const fresh = createIndex(index.text, target);
  assert.deepEqual(index.declarations, fresh.declarations);
  assert.deepEqual(index.occurrences, fresh.occurrences);
  assert.deepEqual(index.diagnostics, fresh.diagnostics);
  assert.equal(index.lines[7], originalSuffix);
  assert.ok(index.metrics.scannedLines < 5);
});

test("macro edits preserve nested scopes and rejoin the unchanged suffix", () => {
  const text =
    "#DEFINE outer\n#DEFINE inner\nLET#value 1\n#ENDDEF\nHEAD #value\n#ENDDEF\nHEAD #value\n";
  const index = createIndex(text);
  const originalSuffix = index.lines[6];
  index.applyChanges(
    [
      {
        range: { start: { line: 1, character: 8 }, end: { line: 1, character: 13 } },
        text: "other",
      },
    ],
    2,
  );
  const fresh = createIndex(index.text);
  assert.deepEqual(index.occurrences, fresh.occurrences);
  assert.equal(index.occurrences.find((item) => item.namespace === "variable").macro, "OTHER:2");
  assert.equal(index.lines[6], originalSuffix);
  assert.ok(index.metrics.reusedLines >= 4);
});

test("compact navigation facts and occasional lexical queries match a full index", () => {
  const target = {
    keywords: provider().forRelease("2026", "en"),
    scopePrefix: "fragment.dat",
    module: "SOFIMSHA",
  };
  const text =
    "#DEFINE outer\nLET#size 1\n#INCLUDE 'part.dat'\nNODE NO X Y Z\n1 0 2 0\n" +
    "NODE 2 X #size $$ comment\nY 3\n#ENDDEF\n+PROG ASE\nGRP NO 1 VAL FULL\n" +
    "ENDIF\nHEAD 'unfinished\nEND\n";
  const full = createIndex(text, target);
  const compact = createNavigationIndex(text, target);
  assert.deepEqual(compact.declarations, full.declarations);
  assert.deepEqual(compact.occurrences, full.occurrences);
  assert.deepEqual(compact.includes(), full.includes());
  assert.deepEqual(compact.symbols(), full.symbols());
  assert.deepEqual(compact.diagnostics, full.diagnostics);
  assert.deepEqual(compact.enumTokens(), full.enumTokens());
  assert.deepEqual(compact.records, full.records);
  assert.deepEqual(compact.lines, full.lines);
  for (let line = 0; line < full.lines.length; line++) {
    const position = { line, character: full.lines[line].text.length };
    assert.deepEqual(compact.contextAt(position), full.contextAt(position));
    assert.equal(compact.offsetAt(position), full.offsetAt(position));
    assert.deepEqual(compact.occurrenceAt(position), full.occurrenceAt(position));
    assert.deepEqual(compact.definitionsAt(position), full.definitionsAt(position));
    assert.deepEqual(compact.referencesAt(position), full.referencesAt(position));
  }
  const changes = [
    { range: { start: { line: 1, character: 9 }, end: { line: 1, character: 10 } }, text: "2" },
    { range: { start: { line: 5, character: 9 }, end: { line: 5, character: 14 } }, text: "3" },
  ];
  compact.applyChanges(changes, 4);
  full.applyChanges(changes, 4);
  assert.equal(applyTextChanges(text, changes), full.text);
  assert.equal(compact.documentVersion, full.documentVersion);
  assert.deepEqual(compact.occurrences, full.occurrences);
  assert.deepEqual(compact.declarations, full.declarations);
});
