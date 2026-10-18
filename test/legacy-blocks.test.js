"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { preprocess } = require("../lib/preprocessor");
const { LintEngine } = require("../lib/lint-engine");
const { filterDiagnostics } = require("../lib/lint-codes");

const uri = "file:///project/main.dat";
const entry = (text) => ({ uri, text });
const range = (line, start, end) => ({
  start: { line, character: start },
  end: { line, character: end },
});

async function analyze(text, options = {}) {
  const expanded = await preprocess(entry(text), options);
  const result = new LintEngine().analyze({ uri, ...expanded });
  return {
    expanded,
    diagnostics: filterDiagnostics([...expanded.diagnostics, ...result.diagnostics], {
      uri,
      sources: new Map([[uri, text]]),
    }),
  };
}

test("legacy BLOCK captures deferred source and expands like a modern memory block", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const legacy = [
      "$BLOCK BEG1",
      "LET#1 $(value)",
      "LET#a #1",
      "$BLOCK END1",
      "#DEFINE value=2",
      "+PROG TEMPLATE",
      "$BLOCK SET1",
      "END",
      "",
    ].join(newline);
    const modern = legacy
      .replace("$BLOCK BEG1", "#DEFINE block")
      .replace("$BLOCK END1", "#ENDDEF")
      .replace("$BLOCK SET1", "#INCLUDE block");
    const actual = await analyze(legacy);
    const expected = await analyze(modern);
    assert.equal(actual.expanded.text, "+PROG TEMPLATE\nLET#1 2\nLET#a #1\nEND\n");
    assert.equal(actual.expanded.text, expected.expanded.text);
    assert.equal(actual.expanded.complete, true);
    assert.deepEqual(actual.diagnostics, []);
    assert.deepEqual(expected.diagnostics, []);
  }
});

test("capturing a legacy block does not declare runtime variables before SET", async () => {
  const text = [
    "+PROG TEMPLATE",
    "$BLOCK BEG1",
    "LET#1 3",
    "$BLOCK END1",
    "LET#before #1",
    "$BLOCK SET1",
    "LET#after #1",
    "END",
    "",
  ].join("\n");
  const result = await analyze(text);
  assert.equal(result.expanded.text, "+PROG TEMPLATE\nLET#before #1\nLET#1 3\nLET#after #1\nEND\n");
  assert.equal(result.expanded.complete, true);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["G101"],
  );
  assert.deepEqual(result.diagnostics[0].range, range(4, 11, 13));
});

test("legacy block redefinition replaces its body without sharing the modern macro namespace", async () => {
  const source = [
    "#DEFINE BLOCK1",
    "HEAD modern",
    "#ENDDEF",
    "$BLOCK BEG1",
    "HEAD old legacy body",
    "$BLOCK END1",
    "$block beg1",
    "HEAD replacement",
    "$block end1",
    "+PROG TEMPLATE",
    "$block set1",
    "#INCLUDE BLOCK1",
    "END",
    "",
  ].join("\n");
  const result = await analyze(source);
  assert.equal(result.expanded.text, "+PROG TEMPLATE\nHEAD replacement\nHEAD modern\nEND\n");
  assert.equal(result.expanded.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("nested legacy SET diagnostics select the failing outer invocation and link the exact body", async () => {
  const text = [
    "$BLOCK BEG2",
    "LET#a #caller",
    "$BLOCK END2",
    "$BLOCK BEG1",
    "$BLOCK SET2",
    "$BLOCK END1",
    "+PROG TEMPLATE",
    "LET#caller 1",
    "$BLOCK SET1",
    "END",
    "+PROG TEMPLATE",
    "$BLOCK SET1",
    "END",
    "",
  ].join("\n");
  const result = await analyze(text);
  assert.equal(result.expanded.complete, true);
  const replayed = result.expanded.segments.filter(({ origin }) => origin.range.start.line === 1);
  assert.deepEqual(
    replayed.map(({ blockInvocation }) => blockInvocation.range.start.line),
    [8, 11],
  );
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["G101"],
  );
  const issue = result.diagnostics[0];
  assert.deepEqual(issue.range, range(11, 0, 11));
  assert.deepEqual(issue.data.focusOrigin, { uri, range: range(1, 6, 13) });
  assert.deepEqual(issue.data.blockInvocation, { uri, range: range(11, 0, 11) });
  assert.ok(
    issue.relatedInformation.some(
      ({ location }) =>
        location.uri === uri &&
        location.range.start.line === 1 &&
        location.range.start.character === 6 &&
        location.range.end.character === 13,
    ),
  );
});

test("numeric variables declared by SET remain local to the invoking program", async () => {
  const text = [
    "$BLOCK BEG1",
    "LET#1 3",
    "LET#9999 5",
    "$BLOCK END1",
    "+PROG TEMPLATE",
    "$BLOCK SET1",
    "LET#a #1+#9999",
    "END",
    "+PROG TEMPLATE",
    "LET#b #1+#9999",
    "END",
    "",
  ].join("\n");
  const result = await analyze(text);
  assert.equal(result.expanded.complete, true);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["G101", "G101"],
  );
  assert.deepEqual(
    result.diagnostics.map(({ range }) => range),
    [range(9, 6, 8), range(9, 9, 14)],
  );
});

test("a legacy block defined in an include maps its body to the later root SET invocation", async () => {
  const child = "file:///project/values.inc";
  const result = await analyze('#INCLUDE "values.inc"\n+PROG TEMPLATE\n$BLOCK SET1\nEND\n', {
    readSource: async (name) =>
      name === child ? { uri: child, text: "$BLOCK BEG1\nLET#a #missing\n$BLOCK END1\n" } : null,
  });
  assert.equal(result.expanded.complete, true);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["G101"],
  );
  const issue = result.diagnostics[0];
  assert.equal(issue.uri, uri);
  assert.deepEqual(issue.range, range(2, 0, 11));
  assert.deepEqual(issue.data.focusOrigin, { uri: child, range: range(1, 6, 14) });
  assert.deepEqual(issue.data.blockInvocation, { uri, range: range(2, 0, 11) });
  assert.ok(issue.relatedInformation.some(({ location }) => location.uri === child));
});

test("a missing legacy block reports uncertainty instead of inventing downstream variable errors", async () => {
  const result = await analyze("+PROG TEMPLATE\n$BLOCK SET1\nLET#a #maybe_from_block\nEND\n");
  assert.equal(result.expanded.complete, false);
  assert.equal(result.expanded.diagnostics.length, 1);
  assert.equal(result.expanded.diagnostics[0].code, "missing-include");
  assert.equal(result.expanded.diagnostics[0].range.start.line, 1);
  assert.ok(result.expanded.uncertainties.length > 0);
  assert.equal(
    result.diagnostics.some(({ code }) => code === "G101"),
    false,
  );
});

test("an unclosed legacy block reports its opening without executing its unfinished body", async () => {
  const result = await preprocess(entry("+PROG TEMPLATE\n$BLOCK BEG1\nLET#a $(deferred)\n"));
  assert.equal(result.text, "+PROG TEMPLATE\n");
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "unclosed-definition");
  assert.equal(result.diagnostics[0].range.start.line, 1);
  assert.ok(result.uncertainties.length > 0);
  assert.equal(
    result.diagnostics.some(({ code }) => code === "undefined-macro"),
    false,
  );
});

test("nested legacy definitions are stored when their outer block is invoked", async () => {
  const source = [
    "$BLOCK BEG1",
    "$BLOCK BEG2",
    "LET#1 $(value)",
    "$BLOCK END2",
    "$BLOCK SET2",
    "$BLOCK END1",
    "#DEFINE value=3",
    "+PROG TEMPLATE",
    "$BLOCK SET1",
    "LET#a #1",
    "END",
    "",
  ].join("\n");
  const result = await analyze(source);
  assert.equal(result.expanded.text, "+PROG TEMPLATE\nLET#1 3\nLET#a #1\nEND\n");
  assert.equal(result.expanded.complete, true);
  assert.deepEqual(result.diagnostics, []);
  const premature = await preprocess(entry(source.replace("$BLOCK SET1", "$BLOCK SET2")));
  assert.equal(premature.text, "+PROG TEMPLATE\nLET#a #1\nEND\n");
  assert.equal(premature.complete, false);
  assert.deepEqual(
    premature.diagnostics.map(({ code }) => code),
    ["missing-include"],
  );
});

test("inactive and cached legacy definitions cannot leak into a later analysis", async () => {
  const cache = new Map();
  const block = "$BLOCK BEG1\nHEAD retained\n$BLOCK END1\n";
  const invocation = "+PROG TEMPLATE\n$BLOCK SET1\nEND\n";
  const defined = await preprocess(entry(block + invocation), { cache });
  assert.equal(defined.text, "+PROG TEMPLATE\nHEAD retained\nEND\n");
  assert.equal(defined.complete, true);
  for (const source of [invocation, "#IF 0\n" + block + "#ENDIF\n" + invocation]) {
    const result = await preprocess(entry(source), { cache });
    assert.equal(result.text, "+PROG TEMPLATE\nEND\n");
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["missing-include"],
    );
  }
});

test("a mismatched legacy END does not execute its captured body", async () => {
  const result = await preprocess(
    entry(
      "$BLOCK BEG1\nLET#a $(deferred)\n$BLOCK END2\n$BLOCK END1\n+PROG TEMPLATE\nHEAD after\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nHEAD after\nEND\n");
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["orphan-enddef"],
  );
  assert.equal(result.diagnostics[0].range.start.line, 2);
});

test("legacy recursion, capture and expansion obey depth, work, byte and cancellation limits", async () => {
  const recursive = await preprocess(
    entry("$BLOCK BEG1\n$BLOCK SET1\n$BLOCK END1\n$BLOCK SET1\n"),
    { maxDepth: 2 },
  );
  assert.equal(recursive.complete, false);
  assert.deepEqual(
    recursive.diagnostics.map(({ code }) => code),
    ["include-depth"],
  );
  const deep = await preprocess(
    entry("$BLOCK BEG1\n$BLOCK BEG2\nHEAD nested\n$BLOCK END2\n$BLOCK END1\n"),
    { maxDepth: 1 },
  );
  assert.equal(deep.complete, false);
  assert.deepEqual(
    deep.diagnostics.map(({ code }) => code),
    ["expansion-limit"],
  );
  const body = "$BLOCK BEG1\nHEAD first\nHEAD second\nHEAD third\n$BLOCK END1\n$BLOCK SET1\n";
  for (const options of [{ maxOperations: 3 }, { maxBytes: 12 }]) {
    const result = await preprocess(entry(body), options);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ["expansion-limit"],
    );
  }
  let checks = 0;
  await assert.rejects(preprocess(entry(body), { isCancelled: () => ++checks > 3 }), {
    name: "AbortError",
  });
});
