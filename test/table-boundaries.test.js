"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex, createNavigationIndex } = require("../lib/finder");
const { completion, documentSymbols, semanticTokens, signatureHelp } = require("../lib/features");

const target = { version: "2026", language: "en", keywords: provider().forRelease("2026", "en") };
const program = (body) => `+PROG SOFILOAD\n${body}\nEND\n`;
const enumLines = (index) => index.enumTokens().map((token) => token.range.start.line);
const projectFor = (index) => ({
  settings: { textCase: "upper" },
  loadDocument: async () => ({ index, target }),
});

test("variable statements end table assignments while explicit commands can start them again", () => {
  for (const prefix of ["", "END\n"]) {
    const tail = prefix ? 1 : 0;
    for (const name of ["DBG", "DEL", "LET", "PRT", "RCL", "STO"]) {
      for (const statement of [
        `${name}#value 1`,
        `${name.toLowerCase()} #value 1`,
        `  ${name[0]}${name.slice(1).toLowerCase()}\t#value 1`,
        `${name}#value(#i) 1`,
      ]) {
        const index = createIndex(
          program(
            `${prefix}ACT TYPE SUP\nlp_u cond\n${statement}\nlp_v cond\nACT TYPE SUP\nlp_w cond`,
          ),
          target,
        );
        assert.equal(index.lines[3 + tail].records[0].kind, "variable", statement);
        assert.equal(index.lines[3 + tail].endState.tableHeader, null, statement);
        assert.equal(index.lines[3 + tail].endState.command, null, statement);
        const after = index.contextAt({ line: 4 + tail, character: 7 });
        assert.equal(after.module, "SOFILOAD", statement);
        assert.equal(after.command, null, statement);
        assert.equal(after.param, null, statement);
        assert.equal(after.schema, null, statement);
        assert.deepEqual(after.forms, [], statement);
        assert.deepEqual(enumLines(index), [2 + tail, 6 + tail], statement);
        assert.equal(index.lines[5 + tail].records[0].tableDefinition, true, statement);
      }
    }
  }
});

test("table variable declarations are program peers and leave no signature or enum completion", async () => {
  const text = program(
    "HEAD acts\n" +
      "ACT TYPE PART SUP GAMU GAMF GAMA PSI0 PSI1 PSI2 TITL\n" +
      " lp_u q_1 cond 1.35 0.00 1.00 0.40 0.40 0.00 'live:u-z'\n" +
      "STO#D_f 0.21\nSTO#B_1 -1.175\n" +
      " lp_v q_1 cond 1.35 0.00 1.00 0.40 0.40 0.00 'live:v-z'",
  );
  const index = createIndex(text, target);
  const symbols = documentSymbols({ index });
  assert.deepEqual(
    symbols[0].children.map((item) => item.name),
    ["HEAD", "ACT", "D_f", "B_1"],
  );
  assert.deepEqual(symbols[0].children[1].range.end, { line: 4, character: 0 });
  assert.equal(symbols[0].children[1].children, undefined);
  assert.deepEqual(documentSymbols({ index: createNavigationIndex(text, target) }), symbols);
  assert.deepEqual(enumLines(index), [3]);
  assert.equal(
    await signatureHelp(projectFor(index), "untitled:table", { line: 6, character: 12 }),
    null,
  );
  const items = await completion(projectFor(index), "untitled:table", { line: 6, character: 12 });
  assert.ok(items.every((item) => item.kind !== 20));
});

test("semicolon variable statements close only table commands", () => {
  const text = program("ACT TYPE SUP\nlp_u cond ; STO#value 1 ; lp_v cond\nLC 1");
  const index = createIndex(text, target);
  const [row, variable, following] = index.lines[2].records;
  assert.equal(row.context.command, "ACT");
  assert.equal(variable.kind, "variable");
  assert.equal(following.context.command, null);
  assert.deepEqual(
    index.enumTokens().map((token) => token.value),
    ["cond"],
  );
  const [act, value, lc] = documentSymbols({ index })[0].children;
  assert.equal(act.name, "ACT");
  assert.deepEqual(act.range.end, { line: 2, character: text.split("\n")[2].indexOf("STO") - 1 });
  assert.equal(value.name, "value");
  assert.equal(lc.name, "LC");

  const ordinary = createIndex("+PROG SOFIMSHA\nNODE 1 X 0 ; LET#x 1 ; Y 3\nEND\n", target);
  assert.equal(ordinary.lines[1].endState.command, "NODE");
  assert.equal(ordinary.contextAt({ line: 1, character: 30 }).param, "Y");
  assert.deepEqual(
    documentSymbols({ index: ordinary })[0].children[0].children.map((item) => item.name),
    ["x"],
  );
});

test("incremental table boundary insertion and deletion match fresh context and symbols", () => {
  const index = createIndex(program("ACT TYPE SUP\nlp_u cond\nlp_v cond"), target);
  const insertion = { line: 3, character: 0 };
  for (const change of [
    { range: { start: insertion, end: insertion }, text: "STO#value 1\n" },
    { range: { start: insertion, end: { line: 4, character: 0 } }, text: "" },
  ]) {
    index.applyChanges([change]);
    const fresh = createIndex(index.text, target);
    assert.deepEqual(index.records, fresh.records);
    assert.deepEqual(semanticTokens({ index }), semanticTokens({ index: fresh }));
    assert.deepEqual(documentSymbols({ index }), documentSymbols({ index: fresh }));
    const stopped = index.text.includes("STO");
    assert.deepEqual(enumLines(index), stopped ? [2] : [2, 3]);
    assert.equal(index.lines[stopped ? 4 : 3].records[0].context.command, stopped ? null : "ACT");
  }
});

test("table boundaries respect continuations and preserve preprocessor auxiliaries", () => {
  const assignment = createIndex(
    program("ACT TYPE SUP\nlp_u cond\nSTO#value $$\n 1\nlp_v cond"),
    target,
  );
  assert.equal(assignment.lines[3].endState.command, null);
  assert.deepEqual(enumLines(assignment), [2]);
  const continuedRow = createIndex(
    program("ACT TYPE SUP\nlp_u cond $$\n STO#value 1\nlp_v cond"),
    target,
  );
  assert.equal(continuedRow.lines[3].records[0].continuedFromPrevious, true);
  assert.equal(continuedRow.lines[3].endState.command, "ACT");
  assert.deepEqual(enumLines(continuedRow), [2, 4]);
  for (const statement of ['#INCLUDE "part.dat"', "#UNDEF macro"]) {
    const index = createIndex(program(`ACT TYPE SUP\nlp_u cond\n${statement}\nlp_v cond`), target);
    assert.equal(index.lines[3].endState.command, "ACT", statement);
    assert.deepEqual(index.lines[3].endState.tableHeader, ["TYPE", "SUP"], statement);
    assert.deepEqual(enumLines(index), [2, 4], statement);
  }
});
