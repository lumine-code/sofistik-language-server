"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { LintEngine } = require("../lib/lint-engine");
const { createIndex } = require("../lib/finder");

const uri = "file:///corpus-literal-reads.dat";
const analyze = (text, language = "en") =>
  new LintEngine().analyze({ uri, text, language }).diagnostics;

test("bare hashes in explanatory text are captions rather than value reads", () => {
  assert.deepEqual(
    analyze("+PROG TEMPLATE\nTXB Section no. #n\nTXA Label #another\nHEAD Result #caption\nEND\n"),
    [],
  );
  assert.deepEqual(analyze("+PROG HYDRA\nKOPF H = 18 M #missing\nEND\n", "de"), []);
});

test("pure free-text HIST captions retain hashes in English and German", () => {
  assert.deepEqual(analyze("+PROG DYNR\nHIST 1 T 1 TITL #T1\nEND\n"), []);
  assert.deepEqual(analyze("+PROG DYNR\nHIST 1 T 1 BEZ #T1\nEND\n", "de"), []);
});

test("explicit formatted expressions still diagnose missing variables in captions", () => {
  const text = "+PROG TEMPLATE\nTXB Section #n; formatted #(#missing,8.1)\nEND\n";
  const issues = analyze(text);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration"],
  );
  assert.match(issues[0].message, /#MISSING/);
  assert.equal(issues[0].range.start.character, text.split("\n")[1].indexOf("#missing"));
  assert.deepEqual(
    analyze("+PROG DYNR\nHIST 1 T 1 TITL #T1 #(#missing,8.1)\nEND\n").map((issue) => issue.code),
    ["variable-before-declaration"],
  );
});

test("nested formatting checks each value while later bare caption hashes stay literal", () => {
  const issues = analyze("+PROG TEMPLATE\nTXB #(MAX(#first,#second),8.1) then #caption\nEND\n");
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration", "variable-before-declaration"],
  );
  assert.match(issues[0].message, /#FIRST/);
  assert.match(issues[1].message, /#SECOND/);
});

test("formatted caption reads continue across logical $$ records and reset after closing", () => {
  const issues = analyze(
    "+PROG DYNR\nHIST 1 T 1 TITL #($$\nMAX(#first,#second),8.1) $$\n#caption\n" +
      "HIST 1 T 1 TITL #later_caption\nEND\n",
  );
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration", "variable-before-declaration"],
  );
  assert.match(issues[0].message, /#FIRST/);
  assert.match(issues[1].message, /#SECOND/);
  assert.equal(issues[0].range.start.line, 2);
  assert.equal(issues[1].range.start.line, 2);
});

test("unfinished caption formatting cannot cross a completed record", () => {
  const issues = analyze("+PROG DYNR\nHIST 1 T 1 TITL #(\nHIST 1 T 1 TITL #caption\nEND\n");
  assert.deepEqual(issues, []);
});

test("numeric, enum and ordinary literal fields retain genuine variable reads", () => {
  const issues = analyze("+PROG SOFIMSHA\nNODE 1 X #x FIX #F\nEND\n");
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration", "variable-before-declaration"],
  );
  assert.match(issues[0].message, /#X/);
  assert.match(issues[1].message, /#F/);
});

test("PRT may inspect an absent variable but never declares it for a later value read", () => {
  const issues = analyze("+PROG TEMPLATE\nPRT#qs1\nLET#x #qs1\nSTO#qs1 2\nPRT#qs1\nEND\n");
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration"],
  );
  assert.equal(issues[0].range.start.line, 2);
});

test("PRT target inspection does not hide an undeclared index expression", () => {
  const issues = analyze("+PROG TEMPLATE\nPRT#qs1(#index)\nEND\n");
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["variable-before-declaration"],
  );
  assert.match(issues[0].message, /#INDEX/);
});

test("raw navigation retains potential caption occurrences independently of lint reads", () => {
  const text = "+PROG TEMPLATE\nTXB caption #n\nEND\n";
  assert.ok(createIndex(text).occurrences.some((item) => item.name === "n"));
  assert.deepEqual(analyze(text), []);
});
