"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikSchemaProvider } = require("@lumine-code/sofistik-schema");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { codeFor, filterDiagnostics } = require("../lib/lint-codes");

const provider = new SofistikSchemaProvider();
const uri = "file:///project/main.dat";
const program = (body, module = "SOFILOAD") => `+PROG ${module}\n${body}\nEND\n`;
function analyze(
  text,
  { version = "2026", language = "en", engine = new LintEngine(), ...options } = {},
) {
  return engine
    .analyze({
      uri,
      text,
      version,
      language,
      keywords: provider.forRelease(version, language),
      ...options,
    })
    .diagnostics.filter((issue) => issue.code === "trailing-comma");
}
const selected = (text, issue) => {
  assert.equal(issue.range.start.line, issue.range.end.line);
  return text
    .split(/\r?\n/)
    [issue.range.start.line].slice(issue.range.start.character, issue.range.end.character);
};

async function expanded(text, files = new Map()) {
  const sources = new Map([[uri, text], ...files]);
  const result = await preprocess(
    { uri, text },
    {
      readSource: async (source) =>
        sources.has(source) ? { uri: source, text: sources.get(source) } : null,
    },
  );
  return { issues: analyze(result.text, result), sources };
}

test("the trailing value-list comma has a stable general syntax code", () => {
  assert.equal(codeFor("trailing-comma"), "G313");
});

test("a comma before the next named parameter selects only the comma", () => {
  for (const body of [
    "LC 321 NONE TITL 'N-summer'\nAREA QGRP 51, TYPE DTXY 1",
    "LC 1\nLINE BGRP 11,21,31,41, TYPE DT 1",
    "LC 1\nAREA QGRP 51, TYPE=DTXY 1",
    "LC 1\nAREA QGRP 51,TYPE DTXY 1",
    "LC 1\nAREA QGRP 51, TYPE DTXY 1, P2 2",
  ]) {
    const text = program(body);
    const issues = analyze(text);
    assert.equal(issues.length, body.includes("P2") ? 2 : 1, body);
    for (const issue of issues) {
      assert.equal(selected(text, issue), ",");
      assert.equal(issue.uri, uri);
      assert.match(issue.message, /followed by another value/);
      assert.equal(issue.relatedInformation, undefined);
    }
  }
});

test("lists at a logical record boundary reject a final comma", () => {
  for (const body of [
    "LC 1,",
    "LC 1, ! comment",
    "LC 1, $ comment",
    "LC 1,; LC 2",
    "LC 1\nAREA QGRP 51,",
    "LET#a 1,",
    "STO#a 1,2,",
  ]) {
    const text = program(body);
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, [], body);
    assert.ok(issue, body);
    assert.equal(selected(text, issue), ",", body);
  }
});

test("complete lists, expressions, functions, strings, units and prose keep their commas", () => {
  for (const body of [
    "LC 1\nLINE BGRP 11,21,31,41 TYPE DT 1",
    "LC 1\nAREA QGRP 51,52 TYPE DTXY 1",
    "LET#a 1,2,3",
    "LET#a MAX(1,2)",
    "LET#a MAX(1,)",
    "LET#a 1[m,]",
    "LET#a '51,'",
    "LC 1 TITL '51, TYPE DTXY'",
    "HEAD 51, TYPE DTXY",
    "LC 1 ! 51,",
    "<TEXT>\nAREA QGRP 51, TYPE DTXY 1\n</TEXT>",
  ])
    assert.deepEqual(analyze(program(body)), [], body);
});

test("a list continuation waits for the next physical line's value", () => {
  for (const body of [
    "LC 1\nAREA QGRP 51, $$\n52 TYPE DTXY 1",
    "LET#a 1, $$\n2,3",
    "LET#a 1, $$\n2, $$\n3",
  ])
    assert.deepEqual(analyze(program(body)), [], body);
  for (const body of [
    "LC 1\nAREA QGRP 51, $$\nTYPE DTXY 1",
    "LC 1\nAREA QGRP 51, $$ ! comment\nTYPE DTXY 1",
    "LET#a 1, $$\n2,",
  ]) {
    const text = program(body);
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, [], body);
    assert.ok(issue, body);
    assert.equal(selected(text, issue), ",", body);
  }
});

test("a final continuation without a next value still reports its comma", () => {
  for (const text of [
    "+PROG SOFILOAD\nLC 1\nAREA QGRP 51, $$\n",
    "+PROG TEMPLATE\nLET#a 51, $$\n",
  ]) {
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, []);
    assert.ok(issue);
    assert.equal(selected(text, issue), ",");
  }
});

test("all supported releases and German keyword aliases share the comma check", () => {
  for (const version of provider.getAvailableVersions())
    for (const language of ["en", "de"]) {
      const body =
        language === "de" ? "LF 1\nFLAE QGR 51, TYP DTXY 1" : "LC 1\nAREA QGRP 51, TYPE DTXY 1";
      const text = program(body);
      const issues = analyze(text, { version, language });
      assert.equal(issues.length, 1, `${version}/${language}`);
      assert.equal(selected(text, issues[0]), ",");
    }
});

test("inactive programs and unknown command payloads do not report list syntax", () => {
  assert.deepEqual(analyze("-PROG SOFILOAD\nLC 1\nAREA QGRP 51, TYPE DTXY 1\nEND\n"), []);
  assert.deepEqual(analyze(program("SOMETHING VALUE 51,", "UNKNOWN")), []);
});

test("comma ranges remain precise after Unicode, semicolons and CRLF", () => {
  const text = "+PROG SOFILOAD\r\nHEAD 'ą😀'; LC 1; AREA QGRP 51, TYPE DTXY 1\r\nEND\r\n";
  const [issue] = analyze(text);
  assert.equal(selected(text, issue), ",");
  assert.equal(issue.range.start.character, text.split("\r\n")[1].indexOf(","));
});

test("a macro-generated comma focuses its use and links its definition", async () => {
  const text = "#DEFINE list=51,\n" + program("LC 1\nAREA QGRP $(list) TYPE DTXY 1");
  const { issues } = await expanded(text);
  assert.equal(issues.length, 1);
  assert.equal(selected(text, issues[0]), "$(list)");
  assert.ok(issues[0].relatedInformation.some(({ location }) => location.range.start.line === 0));
});

test("ordinary includes report their original comma and support noqa", async () => {
  const child = "file:///project/child.dat";
  const childText = program("LC 1\nAREA QGRP 51, TYPE DTXY 1");
  const text = '#INCLUDE "child.dat"\n';
  const { issues } = await expanded(text, new Map([[child, childText]]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].uri, child);
  assert.equal(selected(childText, issues[0]), ",");
  const suppressed = await expanded(
    text,
    new Map([[child, childText.replace("TYPE DTXY 1", "TYPE DTXY 1 ! noqa: G313")]]),
  );
  assert.deepEqual(filterDiagnostics(suppressed.issues, { uri, sources: suppressed.sources }), []);
});

test("global, program and physical continuation-line noqa suppress G313", () => {
  const source = program("LC 1\nAREA QGRP 51, $$\nTYPE DTXY 1");
  assert.deepEqual(filterDiagnostics(analyze(source), { uri, ignore: "G313" }), []);
  for (const text of [
    source.replace("+PROG SOFILOAD", "+PROG SOFILOAD ! noqa: G313"),
    source.replace("51, $$", "51, $$ ! noqa: G313"),
    source.replace("TYPE DTXY 1", "TYPE DTXY 1 ! noqa: G313"),
  ])
    assert.deepEqual(
      filterDiagnostics(analyze(text), { uri, sources: new Map([[uri, text]]) }),
      [],
    );
});

test("cached programs shift comma ranges and incremental correction clears them", () => {
  const engine = new LintEngine();
  const body = program("LC 1\nAREA QGRP 51, TYPE DTXY 1");
  const before = program("LET#a 1", "TEMPLATE");
  assert.equal(analyze(before + body, { engine }).length, 1);
  const moved = before.replace("LET#a 1", "LET#a 1\nLET#b 2") + body;
  const [issue] = analyze(moved, { engine });
  assert.equal(selected(moved, issue), ",");
  assert.equal(issue.range.start.line, 6);
  const corrected = moved.replace("51, TYPE", "51 TYPE");
  assert.deepEqual(analyze(corrected, { engine }), []);
  assert.equal(analyze(moved, { engine }).length, 1);
});
