"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { SofistikSchemaProvider } = require("@lumine-code/sofistik-schema");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { codeFor, filterDiagnostics } = require("../lib/lint-codes");

const provider = new SofistikSchemaProvider();
const fixtureRoot = path.resolve("invalid-number-fixtures");
const uri = pathToFileURL(path.join(fixtureRoot, "main.dat")).href;
const fileUri = (name) => pathToFileURL(path.join(fixtureRoot, name)).href;
const numeric = (result) => result.diagnostics.filter((issue) => issue.code === "invalid-number");
const program = (body, module = "SOFIMSHA") => `+PROG ${module}\n${body}\nEND\n`;

function analyze(
  text,
  { engine = new LintEngine(), version = "2026", language = "en", ...options } = {},
) {
  return engine.analyze({
    uri,
    text,
    version,
    language,
    keywords: provider.forRelease(version, language),
    ...options,
  });
}

async function expanded(text, { files = new Map(), engine = new LintEngine(), ...options } = {}) {
  const sources = new Map([[uri, text], ...files]);
  const result = await preprocess(
    { uri, text },
    {
      readSource: async (source) =>
        sources.has(source) ? { uri: source, text: sources.get(source) } : null,
    },
  );
  return { result: analyze(result.text, { ...result, ...options, engine }), sources };
}

function selectedText(text, range) {
  const lines = text.split(/\r?\n/);
  assert.equal(
    range.start.line,
    range.end.line,
    "a malformed numeric atom has a single-line focus",
  );
  return lines[range.start.line].slice(range.start.character, range.end.character);
}

test("the public general numeric syntax code is stable", () => {
  assert.equal(codeFor("invalid-number"), "G310");
});

test("known numeric named and positional parameters highlight only the malformed atom", () => {
  for (const body of ["NODE NO 1 X 1.00.0 Y 2", "NODE 1 1.00.0 2", "NODE NO 1.00.0 X 2 Y 3"]) {
    const text = program(body);
    const issues = numeric(analyze(text));
    assert.equal(issues.length, 1, body);
    assert.equal(issues[0].uri, uri);
    assert.equal(selectedText(text, issues[0].range), "1.00.0", body);
    assert.equal(issues[0].data.recordOrigin.range.start.line, 1);
    assert.equal(issues[0].relatedInformation, undefined);
    assert.equal(issues[0].data.programAnchor.range.start.line, 0);
  }
});

test("dimensionless numeric parameters and load values retain numeric context", () => {
  for (const [module, body] of [
    ["ASE", "LC NO 1 FACT 1.00.0"],
    ["SOFILOAD", "LC 1\nLINE REF SLN NO 12 TYPE PZZ P1 1.00.0"],
    ["SOFIMSHC", "SPT NO 1 X 1.00.0 Y 2 Z 3"],
  ]) {
    const text = program(body, module);
    const issues = numeric(analyze(text));
    assert.equal(issues.length, 1, body);
    assert.equal(selectedText(text, issues[0].range), "1.00.0");
  }
});

test("LET and STO detect repeated mantissa dots without schema confidence", () => {
  for (const value of ["1.00.0", "1..2", ".1.2", "1.0.", "-1.00.0", "+.1.2"]) {
    for (const command of ["LET", "STO"]) {
      const text = program(`${command}#value ${value}`, "TEMPLATE");
      const issues = numeric(analyze(text));
      assert.equal(issues.length, 1, `${command} ${value}`);
      assert.ok(selectedText(text, issues[0].range).includes(value.replace(/^[+-]/, "")));
    }
  }
});

test("malformed atoms inside arithmetic and functions keep precise focus", () => {
  for (const expression of [
    "2+1.00.0-3",
    "2*1.00.0/3",
    "SIN(1.00.0)+2",
    "MAX(2,1.00.0)",
    "=(1.00.0+2)/3",
    "1E-3+1.00.0",
    "1D+3/1.00.0",
  ]) {
    const text = program(`LET#value ${expression}`, "TEMPLATE");
    const issues = numeric(analyze(text));
    assert.equal(issues.length, 1, expression);
    assert.equal(selectedText(text, issues[0].range), "1.00.0", expression);
  }
});

test("assignment and access indices are numeric expressions", () => {
  for (const body of ["LET#a(1.00.0) 3", "LET#a 1,2,3\nLET#b #a(1.00.0)"]) {
    const text = program(body, "TEMPLATE");
    const issues = numeric(analyze(text));
    assert.equal(issues.length, 1, body);
    assert.equal(selectedText(text, issues[0].range), "1.00.0");
  }
});

test("runtime conditions and loop expressions detect malformed numeric atoms", () => {
  for (const body of [
    "IF 1.00.0\nENDIF",
    "IF 0\nELSEIF 1.00.0\nENDIF",
    "LOOP#i 1.00.0\nENDLOOP",
    "LOOP#i 1\nENDLOOP 1.00.0",
  ]) {
    const issues = numeric(analyze(program(body, "TEMPLATE")));
    assert.equal(issues.length, 1, body);
  }
});

test("standalone variable fragments can still prove malformed numeric syntax", () => {
  const text = "LET#value 1.00.0\n";
  assert.equal(numeric(analyze(text)).length, 1);
});

test("table headers stay inert while implicit rows retain numeric column metadata", () => {
  const text = program("NODE NO X Y Z\n1 1.00.0 2 3\n2 4 5 6");
  const issues = numeric(analyze(text));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].range.start.line, 2);
  assert.equal(selectedText(text, issues[0].range), "1.00.0");
});

test("semicolons and $$ continuations preserve the physical error location", () => {
  const text = program(
    "NODE NO 1 X 0 ; NODE NO 2 X 1.00.0\nNODE NO 3 X 0 $$ comment 1.00.0\n Y 1.00.0 Z 2",
  );
  const issues = numeric(analyze(text));
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((issue) => issue.range.start.line),
    [1, 3],
  );
  for (const issue of issues) assert.equal(selectedText(text, issue.range), "1.00.0");
});

test("ordinary decimals, signs, trailing dots and arithmetic remain valid", () => {
  for (const expression of [
    "0",
    "1.",
    ".5",
    "-.5",
    "+1.0",
    "1-2",
    "1+2.3",
    "1.2*3.4",
    "SIN(0.5)",
    "MAX(1.2,3.4)",
    "=1.2+3.4",
    "1.2/3.4",
    "(1.2+3.4)*5",
  ]) {
    assert.deepEqual(
      numeric(analyze(program(`LET#value ${expression}`, "TEMPLATE"))),
      [],
      expression,
    );
  }
});

test("existing E and D notation stays outside repeated-decimal validation", () => {
  for (const value of ["1E3", "1e-3", "1.E+3", ".5e-3", "-1.25E-03", "1D3", "1d-3", "1.D+3"]) {
    assert.deepEqual(numeric(analyze(program(`LET#value ${value}`, "TEMPLATE"))), [], value);
  }
});

test("a well-formed exponent does not excuse repeated dots in its mantissa", () => {
  for (const value of ["1.00.0E-3", ".1.2D+3"]) {
    const text = program(`LET#value ${value}`, "TEMPLATE");
    const issues = numeric(analyze(text));
    assert.equal(issues.length, 1, value);
    assert.ok(selectedText(text, issues[0].range).startsWith(value.split(/[ED]/)[0]));
  }
});

test("native-accepted incomplete exponents and deferred exponent syntax stay outside G310", () => {
  for (const value of [
    "1E",
    "1E+",
    "1E-",
    "1E+-2",
    "1E2E3",
    "=1E2E3",
    "1E2.3",
    "=1E2.3",
    "1.2E2.3",
    "=1.2D2.3",
  ]) {
    assert.deepEqual(numeric(analyze(program(`LET#value ${value}`, "TEMPLATE"))), [], value);
  }
});

test("generation, repetition, default markers and array slices are preserved", () => {
  const text = program(
    [
      "LET#a 1(0.5)4",
      "LET#b 1,2,3 4,5,6",
      "LET#c(0:10) 1.0",
      "LET#d #c(:)",
      "LET#e #c(3:)",
      "LET#f #c(2:4)",
      "NODE NO 1 X 1.2 Y 3.4 Z 5.6",
      "NODE NO 2 X = Y == Z -",
      "NODE NO 3 X ++ Y -- Z 0",
    ].join("\n"),
  );
  assert.deepEqual(numeric(analyze(text)), []);
});

test("quoted text, comments and prose do not become malformed numeric expressions", () => {
  const text = program(
    [
      "HEAD 2026.10.05 and 1.00.0",
      "LET#label '1.00.0'",
      'LET#other "1.00.0"',
      "NODE NO 1 X 1 Y 2 ! 1.00.0",
      "NODE NO 2 X 2 Y 3 $ 1.00.0",
      "NODE NO 3 X 3 Y 4 // 1.00.0",
      "<TEXT>",
      "LET#prose 1.00.0",
      "NODE X 1.00.0",
      "</TEXT>",
      "TXAB 1.00.0",
      "1.00.0 is prose",
      "TXEN",
    ].join("\n"),
  );
  assert.deepEqual(numeric(analyze(text)), []);
});

test("opaque names, action identifiers, titles and import paths are excluded by slot metadata", () => {
  for (const [module, body] of [
    ["SOFIMSHC", "GAX ID axis TYPE AXIS\nGAXV NAME 1.00.0 VAL 1"],
    ["SOFILOAD", "LC NO 1 TYPE 1.00.0 TITL 2026.10.05"],
    ["SOFIMSHA", "IMPO OPT CDB FROM 1.00.0.dat"],
    ["SOFIMSHA", "IMPO OPT CDB FROM C:/models/1.00.0"],
  ]) {
    assert.deepEqual(numeric(analyze(program(body, module))), [], body);
  }
});

test("unit contents are opaque while a malformed numeric atom before a unit is still diagnosed", () => {
  const clean = program("NODE NO 1 X 1.0[m] Y 2.0[kN/m2] Z 3.0[1.00.0]");
  assert.deepEqual(numeric(analyze(clean)), []);
  const malformed = program("UNIT 1001 1\nNODE NO 1 X 1.00.0[m] Y 2");
  const issues = numeric(analyze(malformed));
  assert.equal(issues.length, 1);
  assert.equal(selectedText(malformed, issues[0].range), "1.00.0");
});

test("inactive programs do not contribute numeric findings", () => {
  const text = "-PROG SOFIMSHA\nNODE NO 1 X 1.00.0\nEND\n+PROG SOFIMSHA\nNODE NO 1 X 1\nEND\n";
  assert.deepEqual(numeric(analyze(text)), []);
});

test("all seven supported releases and German coordinate aliases share the general syntax rule", () => {
  for (const version of provider.getAvailableVersions()) {
    for (const language of ["en", "de"]) {
      const body = language === "de" ? "KNOT NR 1 X 1.00.0 Y 2" : "NODE NO 1 X 1.00.0 Y 2";
      assert.equal(
        numeric(analyze(program(body), { version, language })).length,
        1,
        `${version}/${language}`,
      );
    }
  }
  assert.equal(numeric(analyze(program("LET#a 1.00.0", "STAR2"))).length, 1);
});

test("unknown module command payloads are not assigned numeric meaning", () => {
  const text = program("SOMETHING VALUE 1.00.0", "UNKNOWN");
  assert.deepEqual(numeric(analyze(text)), []);
});

test("UTF-16 offsets remain precise after Unicode text on the same physical line", () => {
  const text = program("LET#text 'ą😀'; NODE NO 1 X 1.00.0 Y 2");
  const issues = numeric(analyze(text));
  assert.equal(issues.length, 1);
  assert.equal(selectedText(text, issues[0].range), "1.00.0");
  const line = text.split("\n")[1];
  assert.equal(issues[0].range.start.character, line.indexOf("1.00.0"));
});

test("unused or textual preprocessor values are not numeric statements", async () => {
  const text = "#DEFINE version=1.00.0\n+PROG ASE\nHEAD $(version)\nLET#value 1\nEND\n";
  assert.deepEqual(numeric((await expanded(text)).result), []);
});

test("a scalar macro producing a malformed number focuses its use and links its definition", async () => {
  const text = "#DEFINE value=1.00.0\n+PROG ASE\nLET#a $(value)\nEND\n";
  const issues = numeric((await expanded(text)).result);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].uri, uri);
  assert.equal(selectedText(text, issues[0].range), "$(value)");
  assert.ok(issues[0].relatedInformation.some((item) => item.location.range.start.line === 0));
});

test("ordinary includes report the malformed literal at the child source", async () => {
  const child = fileUri("parts/child.dat");
  const childText = program("NODE NO 1 X 1.00.0 Y 2");
  const text = '#INCLUDE "parts/child.dat"\n';
  const issues = numeric((await expanded(text, { files: new Map([[child, childText]]) })).result);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].uri, child);
  assert.equal(selectedText(childText, issues[0].range), "1.00.0");
});

test("a reused whole-program block keeps separate invocation findings", async () => {
  const text =
    "#DEFINE block\n+PROG ASE\nLET#a 1.00.0\nEND\n#ENDDEF\n#INCLUDE block\n#INCLUDE block\n";
  const issues = numeric((await expanded(text)).result);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((issue) => issue.range.start.line),
    [5, 6],
  );
  assert.ok(issues.every((issue) => issue.data.focusOrigin.range.start.line === 2));
});

test("Ruff-style per-line and global G310 suppression retain subsequent findings", async () => {
  const text = program("NODE NO 1 X 1.00.0 ! noqa: G310\nNODE NO 2 X 1.00.0");
  const { result, sources } = await expanded(text);
  const remaining = filterDiagnostics(result.diagnostics, { uri, sources }).filter(
    (issue) => issue.code === "G310",
  );
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].range.start.line, 2);
  assert.deepEqual(
    filterDiagnostics(result.diagnostics, { uri, sources, ignore: "G310" }).filter(
      (issue) => issue.code === "G310",
    ),
    [],
  );
});

test("cached numeric findings remap after source moves and disappear after repair", () => {
  const engine = new LintEngine();
  const text = program("NODE NO 1 X 1.00.0 Y 2");
  assert.equal(numeric(analyze(text, { engine })).length, 1);
  const warm = analyze(text, { engine });
  assert.equal(warm.metrics.scannedLines, 0);
  assert.equal(warm.metrics.parsedRecords, 0);
  assert.equal(numeric(warm).length, 1);
  const moved = analyze(`$ moved\n${text}`, { engine });
  assert.equal(moved.metrics.reusedModules, 1);
  assert.equal(numeric(moved)[0].range.start.line, 2);
  assert.equal(selectedText(`$ moved\n${text}`, numeric(moved)[0].range), "1.00.0");
  assert.deepEqual(numeric(analyze(text.replace("1.00.0", "1.00"), { engine })), []);
});

test("a large unchanged numeric module reuses compact lexical facts", () => {
  const engine = new LintEngine();
  const body = Array.from(
    { length: 500 },
    (_, index) => `NODE NO ${index + 1} X ${index}.25 Y 0`,
  ).join("\n");
  const text = program(`${body}\nNODE NO 501 X 1.00.0 Y 0`);
  assert.equal(numeric(analyze(text, { engine })).length, 1);
  const warm = analyze(text, { engine });
  assert.equal(warm.metrics.scannedLines, 0);
  assert.equal(warm.metrics.parsedRecords, 0);
  assert.equal(warm.metrics.reusedModules, 1);
  assert.equal(numeric(warm).length, 1);
});

test("repeated malformed assignments retain distinct source locations within the diagnostic limit", () => {
  const text = program("LET#same 1.00.0\n".repeat(500), "TEMPLATE");
  const issues = numeric(analyze(text));
  assert.equal(issues.length, 100);
  assert.equal(new Set(issues.map((issue) => issue.range.start.line)).size, 100);
  assert.ok(issues.every((issue) => selectedText(text, issue.range) === "1.00.0"));
});

test("a long malformed literal retains its full range with a bounded diagnostic message", () => {
  const value = "1." + "0".repeat(5000) + ".0";
  const text = program("LET#a " + value, "TEMPLATE");
  const [issue] = numeric(analyze(text));
  assert.equal(selectedText(text, issue.range), value);
  assert.ok(issue.message.length < 200);
});

test("one arithmetic token with many malformed atoms keeps diagnostic output bounded", () => {
  const text = program("LET#a " + Array(1000).fill("1..2").join("+"), "TEMPLATE");
  const issues = numeric(analyze(text));
  assert.equal(issues.length, 100);
  assert.ok(issues.every((issue) => selectedText(text, issue.range) === "1..2"));
});
