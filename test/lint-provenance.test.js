"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { preprocess } = require("../lib/preprocessor");
const { LintEngine } = require("../lib/lint-engine");
const { filterDiagnostics } = require("../lib/lint-codes");

const uri = "file:///project/main.dat";
const range = (line, start, end) => ({
  start: { line, character: start },
  end: { line, character: end },
});

async function analyze(text, sources = new Map(), engine = new LintEngine()) {
  sources = new Map([[uri, text], ...sources]);
  const expanded = await preprocess(
    { uri, text },
    {
      readSource: async (name) =>
        sources.has(name) ? { uri: name, text: sources.get(name) } : null,
    },
  );
  const result = engine.analyze({ uri, ...expanded });
  return {
    ...result,
    diagnostics: filterDiagnostics([...expanded.diagnostics, ...result.diagnostics], {
      uri,
      sources,
    }),
  };
}

const issue = (result, code = "G101") => result.diagnostics.find((item) => item.code === code);

test("precise variable diagnostics preserve UTF-16 columns across CRLF and semicolon records", async () => {
  const prefix = "HEAD 'ą😀'; LET#a ";
  const result = await analyze(`+PROG TEMPLATE\r\n${prefix}#missing\r\nEND\r\n`);
  assert.deepEqual(issue(result).range, range(1, prefix.length, prefix.length + 8));
  assert.deepEqual(issue(result).data.programAnchor, { uri, range: range(0, 0, 14) });
  assert.deepEqual(issue(result).data.recordOrigin.range, range(1, 12, prefix.length + 8));
});

test("a scalar's generated variable points to its use and links its actual definition", async () => {
  const result = await analyze("#DEFINE value = #missing\n+PROG TEMPLATE\nLET#a $(value)\nEND\n");
  const found = issue(result);
  assert.equal(found.uri, uri);
  assert.deepEqual(found.range, range(2, 6, 14));
  assert.ok(
    found.relatedInformation.some(
      ({ location }) =>
        location.uri === uri &&
        location.range.start.line === 0 &&
        location.range.start.character === 16,
    ),
  );
});

test("array errors select the variable and literal index, including a substituted index", async () => {
  const literal = await analyze("+PROG TEMPLATE\nLET#a 1\nLET#b #a(99)\nEND\n");
  assert.deepEqual(issue(literal, "G102").range, range(2, 6, 12));
  const macro = await analyze("#DEFINE idx = 99\n+PROG TEMPLATE\nLET#a 1\nLET#b #a($(idx))\nEND\n");
  assert.deepEqual(issue(macro, "G102").range, range(3, 6, 16));
  assert.ok(
    issue(macro, "G102").relatedInformation.some(({ location }) => location.range.start.line === 0),
  );
});

test("a composite generated command covers copied text and the substitution", async () => {
  const result = await analyze("#DEFINE suffix = ne\n+PROG SOFILOAD\nli$(suffix) P1 1\nEND\n");
  const found = issue(result, "SL001");
  assert.deepEqual(found.range, range(2, 0, 11));
  assert.ok(found.relatedInformation.some(({ location }) => location.range.start.line === 0));
});

test("ERR checks select the invalid literal or the complete scalar use site", async () => {
  const literal = await analyze("+PROG AQB\nEIGE RH 110 TEMP 20\nEND\n");
  const literalIssue = literal.diagnostics.find(
    (item) => item.data.rule === "aqb-creep-humidity-range",
  );
  assert.deepEqual(literalIssue.range, range(1, 8, 11));
  const macro = await analyze(
    "#DEFINE humidity = 110\n+PROG AQB\nEIGE RH $(humidity) TEMP 20\nEND\n",
  );
  const macroIssue = macro.diagnostics.find(
    (item) => item.data.rule === "aqb-creep-humidity-range",
  );
  assert.deepEqual(macroIssue.range, range(2, 8, 19));
});

test("native dollar comments do not hide records after doubled-delimiter quoted text", async () => {
  for (const quote of ["'", '"']) {
    const prefix = `HEAD ${quote}${quote}Dollar $ title${quote}${quote}; EIGE RH `;
    const result = await analyze(`+PROG AQB\n${prefix}110\nEND\n`);
    const found = result.diagnostics.find(({ data }) => data.rule === "aqb-creep-humidity-range");
    assert.ok(found);
    assert.deepEqual(found.range, range(1, prefix.length, prefix.length + 3));
  }
});

test("a block fragment reports only its failing invocation and links the exact body variable", async () => {
  const text = [
    "#DEFINE fragment",
    "LET#a #caller",
    "#ENDDEF",
    "+PROG TEMPLATE",
    "LET#caller 1",
    "#INCLUDE fragment",
    "END",
    "+PROG TEMPLATE",
    "#INCLUDE fragment",
    "END",
    "",
  ].join("\n");
  const result = await analyze(text);
  assert.equal(result.diagnostics.length, 1);
  const found = issue(result);
  assert.deepEqual(found.range, range(8, 0, 17));
  assert.deepEqual(found.data.focusOrigin, { uri, range: range(1, 6, 13) });
  assert.ok(
    found.relatedInformation.some(
      ({ location }) => location.range.start.line === 1 && location.range.start.character === 6,
    ),
  );
});

test("normal included records target their own URI and retain the caller's program anchor", async () => {
  const child = "file:///project/values.inc";
  const result = await analyze(
    '+PROG TEMPLATE\n#INCLUDE "values.inc"\nEND\n',
    new Map([[child, "LET#a #missing\n"]]),
  );
  const found = issue(result);
  assert.equal(found.uri, child);
  assert.deepEqual(found.range, range(0, 6, 14));
  assert.equal(found.data.programAnchor.uri, uri);
  assert.equal(found.data.programAnchor.range.start.line, 0);
});

test("conditional programs retain original columns and program-level suppression", async () => {
  const text = "#IF 1\n  +PROG TEMPLATE ! noqa: G101\n  LET#a #missing\nEND\n#ENDIF\n";
  assert.deepEqual((await analyze(text)).diagnostics, []);
  const enabled = await analyze(text.replace(" ! noqa: G101", ""));
  assert.deepEqual(issue(enabled).range, range(2, 8, 16));
});

test("a continued multi-field ERR record honors NOQA on its final source line", async () => {
  const text = "+PROG RELY\nVAR NAME rv TYPE NORM $$\nTID 1 P1 1 P2 0.1 ! noqa: RL002\nEND\n";
  assert.equal(issue(await analyze(text), "RL002"), undefined);
  const enabled = issue(await analyze(text.replace(" ! noqa: RL002", "")), "RL002");
  assert.ok(enabled);
  assert.deepEqual(
    enabled.data.recordOrigins.map((origin) => origin.range.start.line),
    [1, 2],
  );
});

test("preprocessing failures use their own line rather than a program header's suppression", async () => {
  const text = "+PROG TEMPLATE ! noqa: G004\nLET#a $(missing)\nEND\n";
  assert.ok(issue(await analyze(text), "G004"));
  assert.equal(
    issue(await analyze(text.replace("$(missing)", "$(missing) ! noqa: G004")), "G004"),
    undefined,
  );
});

test("cached module issues map again after a scalar changes length without changing expanded text", async () => {
  const engine = new LintEngine();
  const first = "#DEFINE x = #missing\n+PROG TEMPLATE\nLET#a $(x)\nEND\n";
  await analyze(first, new Map(), engine);
  const result = await analyze(
    first.replaceAll(" x ", " long ").replace("$(x)", "$(long)"),
    new Map(),
    engine,
  );
  assert.ok(result.metrics.reusedModules > 0);
  assert.deepEqual(issue(result).range, range(2, 6, 13));
});
