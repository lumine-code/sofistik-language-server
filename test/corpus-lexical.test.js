"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex } = require("../lib/finder");
const { LintEngine } = require("../lib/lint-engine");
const { sourceDiagnostics } = require("../lib/source-diagnostics");
const uri = "file:///corpus.dat";
const analyze = (text, language = "en") =>
  new LintEngine().analyze({ uri, text, language }).diagnostics;

test("basic text headers retain prose when a module catalogue omits the alias", () => {
  const text = "+PROG HYDRA\nKOPF DAMM H = 18.0 M > 9.0 M\nEND\n";
  assert.deepEqual(analyze(text, "de"), []);
  assert.deepEqual(
    analyze("+PROG HYDRA\nKOPF H = 18 M #(#missing,8.1)\nEND\n", "de").map((issue) => issue.code),
    ["variable-before-declaration"],
  );
});

test("LOOP function expressions do not become array name reads", () => {
  assert.deepEqual(analyze("+PROG TEMPLATE\nLET#Np 4\nLOOP#i SQR(#Np)\nENDLOOP\nEND\n"), []);
  assert.deepEqual(
    analyze("+PROG TEMPLATE\nLOOP#i missing\nENDLOOP\nEND\n").map((issue) => issue.code),
    ["variable-before-declaration"],
  );
  assert.deepEqual(analyze("+PROG TEMPLATE\nLET#SQR 1,2\nLOOP#i SQR\nENDLOOP\nEND\n"), []);
});

test("a separated parenthesized RHS is a stored value rather than an array index", () => {
  assert.deepEqual(
    analyze(
      "+PROG TEMPLATE\nLET#nnode 4\nSTO#node_no (1 #nnode 1)\nEND\n" +
        "+PROG TEMPLATE\nLET#x #node_no(2)\nEND\n",
    ),
    [],
  );
  assert.deepEqual(
    analyze("+PROG TEMPLATE\nSTO#missing(2)\nEND\n").map((issue) => issue.code),
    ["variable-before-declaration"],
  );
});

test("unrecognized prose records cannot manufacture bare mathematical variables", () => {
  const text = "+PROG AQUA\nEND\nEND\nHEA 360\n(K/D = characteristic/Design)\n";
  assert.deepEqual(analyze(text), []);
  assert.deepEqual(
    analyze("+PROG TEMPLATE\nLET#x =missing\nEND\n").map((issue) => issue.code),
    ["variable-before-declaration"],
  );
});

test("commented module hints are neutral while real unknown programs remain errors", () => {
  const target = {
    version: "2026",
    dataSupported: true,
    keywords: provider().forRelease("2026", "en"),
  };
  const diagnostics = (text) =>
    sourceDiagnostics(
      {
        documents: new Map([[uri, { open: true, index: createIndex(text, target), target }]]),
        skippedInputs: new Map(),
      },
      uri,
    );
  assert.deepEqual(diagnostics("$PROG WINGRAF\nPROG WING\nEND\n"), []);
  assert.deepEqual(
    diagnostics("+PROG UNKNOWN\nEND\n").map((issue) => issue.code),
    ["unknown-module"],
  );
});

test("ASE empty END block closes execution before appended report prose", () => {
  const text =
    "+PROG ASE\nLET#a #before\nEND\nEND\n" +
    "LOAD 2 NONLINEAR\n-Schalten Sie auf Graphik (oder Maus-Rechtsklick)\nENDIF\n" +
    "+PROG TEMPLATE\nLET#b #after\nEND\n";
  assert.deepEqual(
    analyze(text).map((issue) => [issue.code, issue.range.start.line]),
    [
      ["variable-before-declaration", 1],
      ["variable-before-declaration", 8],
    ],
  );
  assert.deepEqual(analyze("+PROG ASE\nLOOP 1\nEND\nEND\nENDLOOP\nEND\n"), []);
});
