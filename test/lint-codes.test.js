"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CODES, codeFor, filterDiagnostics } = require("../lib/lint-codes");

const uri = "file:///project/main.dat";
const location = (uri, line) => ({
  uri,
  range: { start: { line, character: 0 }, end: { line, character: 12 } },
});
const finding = (line = 1, code = "variable-before-declaration") => ({
  range: location(uri, 0).range,
  source: "sofistik-linter",
  code,
  message: "Variable is used before its declaration.",
  data: { recordOrigin: location(uri, line) },
});

test("public rule codes are unique and remain stable for saved noqa settings", () => {
  assert.equal(new Set(Object.values(CODES)).size, Object.keys(CODES).length);
  assert.equal(codeFor("undefined-macro"), "G004");
  assert.equal(codeFor("variable-before-declaration"), "G101");
  assert.equal(codeFor("load-without-load-case"), "SL001");
  assert.equal(codeFor("vertex-without-polygon"), "AQ001");
  assert.throws(() => codeFor("unregistered"), /Unregistered/);
});

test("Ruff-style diagnostics retain internal rule identity and original record location", () => {
  const [item] = filterDiagnostics([finding()], { uri });
  assert.equal(item.code, "G101");
  assert.equal(item.data.rule, "variable-before-declaration");
  assert.deepEqual(item.data.recordOrigin, location(uri, 1));
});

test("global NOQA selects codes or suppresses all new linter findings", () => {
  const input = [finding(), finding(1, "load-without-load-case")];
  assert.deepEqual(
    filterDiagnostics(input, { uri, ignore: "G101" }).map((item) => item.code),
    ["SL001"],
  );
  assert.deepEqual(filterDiagnostics(input, { uri, ignore: "ALL" }), []);
});

test("module selectors are distinct and partial numeric families work like Ruff", () => {
  const source = [finding(), finding(1, "load-without-load-case")];
  assert.deepEqual(
    filterDiagnostics(source, { uri, ignore: "G1" }).map((item) => item.code),
    ["SL001"],
  );
  assert.deepEqual(
    filterDiagnostics(source, { uri, ignore: "SL" }).map((item) => item.code),
    ["G101"],
  );
  const aqb = { ...finding(), code: "aqb-creep-humidity-range" };
  const aqua = { ...finding(), code: "vertex-without-polygon" };
  const remaining = filterDiagnostics([aqb, aqua], { uri, ignore: "AQ" });
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].code, /^AQB\d+/);
});

test("line noqa applies at the offending source record despite a PROG diagnostic anchor", () => {
  const sources = new Map([[uri, "+PROG ASE\nGRP NO #missing ! noqa: G101\nEND"]]);
  assert.deepEqual(filterDiagnostics([finding()], { uri, sources }), []);
  assert.equal(
    filterDiagnostics([finding(1, "load-without-load-case")], { uri, sources }).length,
    1,
  );
});

test("blanket and header noqa work while quoted text and invalid code lists do not silence errors", () => {
  for (const text of ["GRP NO #missing ! noqa", "GRP NO #missing $ noqa"]) {
    assert.deepEqual(
      filterDiagnostics([finding()], { uri, sources: new Map([[uri, "PROG ASE\n" + text]]) }),
      [],
    );
  }
  const header = new Map([[uri, "+PROG ASE ! noqa: G101\nGRP NO #missing"]]);
  assert.deepEqual(filterDiagnostics([finding()], { uri, sources: header }), []);
  for (const text of [
    "HEAD '! noqa'",
    "HEAD ''! noqa''",
    'HEAD ""! noqa""',
    "GRP NO #missing ! noqa: invalid",
    "#IF $(missing) != 'noqa'",
  ]) {
    assert.equal(
      filterDiagnostics([finding()], { uri, sources: new Map([[uri, "PROG ASE\n" + text]]) })
        .length,
      1,
    );
  }
});

test("a reusable macro can be suppressed at its definition or at one invocation", () => {
  const child = "file:///project/part.inc";
  const diagnostic = finding();
  diagnostic.data.recordOrigin = location(child, 0);
  diagnostic.data.invocation = location(uri, 2);
  const sources = new Map([
    [uri, "#DEFINE block\n#ENDDEF\n#INCLUDE block ! noqa: G101"],
    [child, "GRP NO #missing"],
  ]);
  assert.deepEqual(filterDiagnostics([diagnostic], { uri, sources }), []);
  sources.set(uri, "#DEFINE block\n#ENDDEF\n#INCLUDE block");
  sources.set(child, "GRP NO #missing ! noqa: G101");
  assert.deepEqual(filterDiagnostics([diagnostic], { uri, sources }), []);
});

test("precise primary locations retain independent program and invocation NOQA anchors", () => {
  const diagnostic = finding();
  diagnostic.uri = uri;
  diagnostic.range = location(uri, 1).range;
  diagnostic.data.programAnchor = location(uri, 0);
  const sources = new Map([[uri, "+PROG ASE ! noqa: G101\nGRP NO #missing"]]);
  assert.deepEqual(filterDiagnostics([diagnostic], { uri, sources }), []);
  sources.set(uri, "+PROG ASE\nGRP NO #missing");
  const [item] = filterDiagnostics([diagnostic], { uri, sources });
  assert.equal(item.uri, uri);
  assert.deepEqual(item.data.programAnchor, location(uri, 0));
});

test("a scalar definition's NOQA does not suppress all unrelated uses of its value", () => {
  const diagnostic = finding(2);
  diagnostic.range = location(uri, 2).range;
  diagnostic.data.programAnchor = location(uri, 1);
  diagnostic.relatedInformation = [
    { location: location(uri, 0), message: "Preprocessor value defined here." },
  ];
  const sources = new Map([[uri, "#DEFINE x=#missing ! noqa: G101\n+PROG ASE\nGRP NO $(x)"]]);
  assert.equal(filterDiagnostics([diagnostic], { uri, sources }).length, 1);
});

test("continued records honor a pragma on their final physical line", () => {
  const diagnostic = finding(1, "rely-var-distribution-xor");
  diagnostic.range = {
    start: { line: 1, character: 0 },
    end: { line: 2, character: 19 },
  };
  diagnostic.data.recordOrigin = { uri, range: diagnostic.range };
  const sources = new Map([
    [uri, "+PROG RELY\nVAR NAME rv TYPE NORM $$\nTID 1 P1 1 P2 0.1 ! noqa: RL002"],
  ]);
  assert.deepEqual(filterDiagnostics([diagnostic], { uri, sources }), []);
});

test("source fragments do not borrow suppressions from unrelated lines inside their union", () => {
  const diagnostic = finding(1);
  diagnostic.range = {
    start: { line: 1, character: 0 },
    end: { line: 4, character: 10 },
  };
  diagnostic.data.recordOrigin = { uri, range: diagnostic.range };
  diagnostic.data.focusOrigin = diagnostic.data.recordOrigin;
  diagnostic.data.recordOrigins = [location(uri, 1), location(uri, 4)];
  diagnostic.data.focusOrigins = diagnostic.data.recordOrigins;
  const sources = new Map([[uri, "+PROG TEMPLATE\nLET#a #missing $$\n! noqa: G101\n\n+ #other"]]);
  assert.equal(filterDiagnostics([diagnostic], { uri, sources }).length, 1);
  sources.set(uri, "+PROG TEMPLATE\nLET#a #missing $$\n\n\n+ #other ! noqa: G101");
  assert.deepEqual(filterDiagnostics([diagnostic], { uri, sources }), []);
});
