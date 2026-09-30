"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createIndex } = require("../lib/finder");
const { provider } = require("@lumine-code/sofistik-data");

const target = () => ({
  version: "2026",
  language: "en",
  keywords: provider().forRelease("2026", "en"),
});
const at = (text, needle, delta = 0) => {
  const index = text.indexOf(needle) + delta;
  const before = text.slice(0, index);
  return { line: before.split("\n").length - 1, character: index - (before.lastIndexOf("\n") + 1) };
};

test("module and command context survive END and transparent auxiliaries", () => {
  const text =
    "$PROG SOFIMSHA\nNODE 1 X 0\nLET#a 2\n#IF $(use)\nX 2 Y 3\n#ENDIF\nEND\nNODE 2 X 4\n+PROG AQUA\nHEAD tail\n";
  const index = createIndex(text, target());
  assert.equal(index.contextAt(at(text, "Y 3", 2)).command, "NODE");
  assert.equal(index.contextAt(at(text, "NODE 2", 6)).module, "SOFIMSHA");
  assert.equal(index.contextAt(at(text, "HEAD tail", 6)).module, "AQUA");
  assert.notEqual(
    index.contextAt(at(text, "NODE 2", 6)).scopeId,
    index.contextAt(at(text, "X 2", 3)).scopeId,
  );
});

test("continues logical record through annotated $$ and handles semicolons", () => {
  const text = "+PROG SOFIMSHA\nNODE 1 X 0 $$ note; not code\n Y 2 Z 3 ; NODE 2 X 4\nEND\n";
  const index = createIndex(text, target());
  assert.equal(index.contextAt(at(text, "Y 2", 2)).param, "Y");
  assert.equal(index.contextAt(at(text, "NODE 2", 6)).command, "NODE");
  assert.equal(index.contextAt(at(text, "not code", 3)).role, "comment");
  assert.equal(index.lines[2].records[0].continuedFromPrevious, true);
});

test("does not read code from comments or single/doubled quoted strings", () => {
  const text =
    "+PROG AQUA\nHEAD 'a; ''quoted'' $(macro) #fake ! PROG' \"\"double\"\" BAUMANN'S f'= tent'\n$ PROG SOFIMSHA\nHEAD #real ! #comment\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.occurrences.filter((item) => item.namespace === "variable").map((item) => item.name),
    ["real"],
  );
  assert.deepEqual(
    index.occurrences.filter((item) => item.namespace === "macro").map((item) => item.name),
    ["macro"],
  );
  assert.equal(index.contextAt(at(text, "#real", 3)).module, "AQUA");
  assert.equal(index.diagnostics.length, 0);
});

test("TEXT is opaque prose with refs, PICT is code, legacy text ends at TXEN", () => {
  const text =
    "+PROG SOFIMSHA\n<TEXT,TITLE='test'>\nPROG AQUA; $ not comment !\nnatural it's #real\n' unmatched #later\n<\\TEXT>\n<PICT>\nNODE 1 X 0\n</PICT>\nTXAB prose\nNODE 7 #a\nTXEN\nNODE 2 X 1\n";
  const index = createIndex(text, target());
  assert.equal(index.contextAt(at(text, "PROG AQUA", 5)).module, "SOFIMSHA");
  assert.equal(index.contextAt(at(text, "PROG AQUA", 5)).role, "text");
  assert.deepEqual(
    index.occurrences.map((item) => item.name),
    ["real", "later", "a"],
  );
  assert.equal(index.contextAt(at(text, "NODE 1", 5)).command, "NODE");
  assert.equal(index.contextAt(at(text, "NODE 7", 5)).role, "text");
  assert.equal(index.contextAt(at(text, "NODE 2", 5)).command, "NODE");
});

test("table header supplies parameter context for implicit rows", () => {
  const text = "+PROG SOFIMSHA\nNODE NO X Y Z\n1 0 3 0\n2 4 5 6\n";
  const index = createIndex(text, target());
  assert.equal(index.contextAt(at(text, "3 0", 0)).param, "Y");
  assert.equal(index.contextAt(at(text, "5 6", 0)).param, "Y");
  assert.equal(index.contextAt(at(text, "5 6", 0)).activeParameter, 2);
});

test("indexes local definitions, recursive references, macros and include kinds", () => {
  const text =
    "+PROG AQUA\nLET#A 1\nLET#B #A(#i)\n#DEFINE demo= #A; literal\n#INCLUDE demo\n#INCLUDE 'part.dat'\n#INCLUDE $(project).dat\nHEAD \"ą😀\" #A\nEND\n+PROG AQUA\nHEAD #A\n";
  const index = createIndex(text, target());
  assert.equal(index.definitionsAt(at(text, "#A(#i)", 1)).length, 1);
  assert.equal(index.referencesAt(at(text, "LET#A", 4)).length, 4);
  assert.equal(index.definitionsAt(at(text, "HEAD #A", 6)).length, 0);
  assert.deepEqual(
    index.includes().map((item) => item.kind),
    ["macro", "static", "dynamic"],
  );
  assert.equal(index.declarations.find((item) => item.name === "demo").namespace, "macro");
  assert.equal(index.lines[3].records.length, 1);
  assert.deepEqual(index.occurrences.find((item) => item.line === 7).range.start, {
    line: 7,
    character: 12,
  });
});

test("accepts inherited fragment context and incomplete input", () => {
  const text = "NODE 1 X 0\nHEAD 'unfinished\nNODE 2 Y 3\n";
  const index = createIndex(text, { ...target(), module: "SOFIMSHA", scopeId: "caller" });
  assert.equal(index.contextAt({ line: 0, character: 9 }).module, "SOFIMSHA");
  assert.equal(index.contextAt({ line: 2, character: 9 }).scopeId, "caller");
  assert.equal(index.diagnostics[0].code, "unterminated-string");
  assert.equal(createIndex("#DEFINE shared\n#INCLUDE $(incomplete", {}).diagnostics.length, 0);
});

test("only emits enum semantic tokens for values of an identified slot", () => {
  const text = "+PROG TENDON\nAXES KIND QUAD\nAXES VAL3 11 QUAD\nAXES KIND 'QUAD'\nHEAD 'QUAD'\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.enumTokens().map((token) => token.value),
    ["QUAD", "QUAD"],
  );
  assert.ok(index.enumTokens().every((token) => token.param === "KIND"));
});

test("incremental edits converge and match a fresh index after context changes", () => {
  const text =
    "+PROG SOFIMSHA\n" +
    Array.from({ length: 1200 }, (_, i) => `NODE ${i + 1} X 0 Y 0`).join("\n") +
    "\nEND\n";
  const index = createIndex(text, target());
  index.applyChanges(
    [
      {
        range: { start: { line: 700, character: 11 }, end: { line: 700, character: 12 } },
        text: "ą😀",
      },
    ],
    2,
  );
  assert.ok(index.metrics.scannedLines < 5);
  assert.ok(index.metrics.reusedLines > 1190);
  const fresh = createIndex(index.text, target());
  assert.deepEqual(index.symbols(), fresh.symbols());
  assert.deepEqual(
    index.contextAt({ line: 1100, character: 12 }),
    fresh.contextAt({ line: 1100, character: 12 }),
  );
  index.applyChanges(
    [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } },
        text: "AQUA",
      },
    ],
    3,
  );
  assert.equal(index.contextAt({ line: 1000, character: 4 }).module, "AQUA");
  assert.equal(index.metrics.reusedLines, 0);
});

test("ordered LSP changes and inserted lines produce fresh equivalent occurrences", () => {
  const index = createIndex("+PROG AQUA\nLET#A 1\nHEAD #A\nEND\n", target());
  index.applyChanges(
    [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        text: "$ comment\n",
      },
      { range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } }, text: "2" },
    ],
    4,
  );
  const fresh = createIndex(index.text, target());
  assert.deepEqual(index.occurrences, fresh.occurrences);
  assert.deepEqual(index.declarations, fresh.declarations);
});

test("finds bare math and loop references without classifying built-in functions", () => {
  const text =
    "+PROG SOFIMSHA\nLET#A 1,2,3\nLET#B =A(1)+SIN(A(2))\nLOOP#i A\nGETN X 0 VAR found\nSTO#A(#i)\nDEL#OPT*\nENDLOOP\n";
  const index = createIndex(text, target());
  assert.equal(
    index.occurrences.filter((item) => item.name === "A" && item.syntax === "bare-expression")
      .length,
    2,
  );
  assert.equal(
    index.occurrences.some((item) => item.name === "SIN"),
    false,
  );
  assert.equal(index.occurrences.find((item) => item.syntax === "loop-array").name, "A");
  assert.equal(index.declarations.find((item) => item.name === "found").syntax, "getn-output");
  assert.equal(index.declarations.filter((item) => item.name === "A").length, 1);
  assert.equal(index.occurrences.find((item) => item.name === "OPT").wildcard, true);
});

test("cursor token boundaries and macro interpolation retain exact replacement prefixes", () => {
  const text = "+PROG TENDON\nAXES KIND=QUAD\nHEAD '$(project)'\n";
  const index = createIndex(text, target());
  assert.equal(index.contextAt(at(text, "QUAD", 1)).prefix, "Q");
  assert.equal(index.contextAt(at(text, "project", 3)).role, "macro");
  assert.equal(index.contextAt(at(text, "project", 3)).prefix, "pro");
});

test("preprocessor names and neutral conditions do not start accidental records", () => {
  const text =
    "ï»¿+PROG AQUA\n#DEFINE #foo.bar-1=value; PROG SOFIMSHA\n#IF $(foo.bar-1); PROG SOFIMSHA\n#UNDEF #foo.bar-1\nHEAD test;";
  const index = createIndex(text, target());
  assert.equal(index.declarations.find((item) => item.namespace === "macro").name, "foo.bar-1");
  assert.equal(index.occurrences.find((item) => item.role === "undef").namespace, "macro");
  assert.equal(index.contextAt({ line: 3, character: 5 }).module, "AQUA");
  assert.equal(index.lines[2].records.length, 1);
  assert.equal(index.contextAt({ line: 4, character: 10 }).role, "command");
});

test("unknown scopes stay neutral and CDB statements emit no enum overlay", () => {
  const unknown = createIndex("+PROG UNKNOWN\nENDIF\n#ENDDEF\n", target());
  assert.deepEqual(unknown.diagnostics, []);
  const text = "+PROG TENDON\nAXES KIND QUAD\n@KEY QUAD\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.enumTokens().map((item) => item.range.start.line),
    [1],
  );
});

test("incremental marker edits agree with fresh indexes across lexical modes", () => {
  const variants = [
    "+PROG TENDON\nAXES KIND QUAD\nHEAD #A\nEND\n",
    "+PROG TENDON\nAXES $$ annotation\nKIND QUAD\nHEAD #A\nEND\n",
    "+PROG TENDON\n<TEXT>\nAXES KIND QUAD\n#A $(macro)\n</TEXT>\nEND\n",
    "+PROG TENDON\n#DEFINE macro\nAXES KIND QUAD\n#ENDDEF\n#INCLUDE macro\nEND\n",
    "+PROG SOFIMSHA\nNODE NO X Y Z\n1 0 2 0\nEND\n",
    "+PROG SOFIMSHA\nHEAD 'unfinished\nNODE 1 X 0\nEND\n",
  ];
  const positionAt = (text, offset) => {
    const prefix = text.slice(0, offset);
    return {
      line: prefix.split("\n").length - 1,
      character: offset - prefix.lastIndexOf("\n") - 1,
    };
  };
  for (const before of variants) {
    for (const after of variants) {
      let start = 0;
      let suffix = 0;
      while (start < before.length && start < after.length && before[start] === after[start])
        start++;
      while (
        suffix < before.length - start &&
        suffix < after.length - start &&
        before.at(-1 - suffix) === after.at(-1 - suffix)
      )
        suffix++;
      const index = createIndex(before, target());
      index.applyChanges(
        [
          {
            range: {
              start: positionAt(before, start),
              end: positionAt(before, before.length - suffix),
            },
            text: after.slice(start, after.length - suffix),
          },
        ],
        2,
      );
      const fresh = createIndex(after, target());
      assert.deepEqual(index.declarations, fresh.declarations);
      assert.deepEqual(index.occurrences, fresh.occurrences);
      assert.deepEqual(index.diagnostics, fresh.diagnostics);
      assert.deepEqual(index.enumTokens(), fresh.enumTokens());
      for (let line = 0; line < index.lines.length; line++) {
        const position = { line, character: index.lines[line].text.length };
        assert.deepEqual(index.contextAt(position), fresh.contextAt(position));
      }
    }
  }
});

test("natural apostrophes in TEXT do not hide variables before a later quoted value", () => {
  const index = createIndex(
    "+PROG AQUA\n<TEXT>\nit's #real 'quoted #literal' $(macro)\n</TEXT>\n",
    target(),
  );
  assert.deepEqual(
    index.occurrences.map((item) => item.name),
    ["real", "macro"],
  );
});

test("terminal NO is a VAL enum rather than an empty NO field in a populated GRP record", () => {
  const text = "+PROG ASE\nHEAD 'Example'\nLET#size 1\nGRP NO #size VAL FULL\nEND\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.enumTokens().map((item) => item.value),
    ["FULL"],
  );
  index.applyChanges(
    [{ range: { start: { line: 3, character: 17 }, end: { line: 3, character: 21 } }, text: "NO" }],
    2,
  );
  const fresh = createIndex(index.text, target());
  assert.deepEqual(
    index.enumTokens().map((item) => item.value),
    ["NO"],
  );
  assert.deepEqual(index.enumTokens(), fresh.enumTokens());
  assert.equal(index.contextAt({ line: 3, character: 18 }).param, "VAL");
  assert.equal(index.contextAt({ line: 3, character: 18 }).confidence, true);
});

test("whitespace after an explicit parameter expects its value until a value is consumed", () => {
  const cases = [
    ["GRP NO 1 VAL ", "value"],
    ["GRP\tNO\t1\tVAL\t", "value"],
    ["GRP NO 1 VAL= ", "value"],
    ["GRP NO 1 VAL FULL ", "param"],
    ["GRP\tNO\t1\tVAL\tFULL\t", "param"],
    ["GRP NO 1 VAL $$ annotation\n \t", "value"],
    ["GRP NO 1 VAL FULL $$ annotation\n \t", "param"],
  ];
  for (const [input, expected] of cases) {
    const text = `+PROG ASE\n${input}`;
    const index = createIndex(text, target());
    const line = index.lines.length - 1;
    const context = index.contextAt({ line, character: index.lines[line].text.length });
    assert.equal(context.role, expected, input);
    assert.equal(context.param, "VAL", input);
    assert.equal(context.activeParameter, 1, input);
  }
  const table = createIndex("+PROG SOFIMSHA\nNODE NO X Y Z ", target());
  assert.equal(table.contextAt({ line: 1, character: 14 }).role, "param");
});

test("known quoted ASE enum literals classify only their contents in the exact value slot", () => {
  const text =
    "+PROG ASE\nGRP NO 1 VAL 'FULL'\nGRP NO 2 VAL \"FULL\"\nGRP NO 3 VAL ''FULL''\nHEAD 'FULL'\n$ GRP NO 4 VAL 'FULL'\nGRP NO 5 VAL '$(choice)'\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.enumTokens().map((item) => ({ value: item.value, param: item.param, range: item.range })),
    [
      {
        value: "FULL",
        param: "VAL",
        range: { start: { line: 1, character: 14 }, end: { line: 1, character: 18 } },
      },
      {
        value: "FULL",
        param: "VAL",
        range: { start: { line: 2, character: 14 }, end: { line: 2, character: 18 } },
      },
      {
        value: "FULL",
        param: "VAL",
        range: { start: { line: 3, character: 15 }, end: { line: 3, character: 19 } },
      },
    ],
  );
  const context = index.contextAt({ line: 1, character: 16 });
  assert.equal(context.prefix, "FU");
  assert.equal(context.role, "value");
  assert.equal(context.inString, true);
  assert.equal(context.param, "VAL");
});
