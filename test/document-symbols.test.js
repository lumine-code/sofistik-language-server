"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex, createNavigationIndex } = require("../lib/finder");
const { documentSymbols, workspaceSymbols } = require("../lib/features");

const target = { version: "2026", language: "en", keywords: provider().forRelease("2026", "en") };
const outline = (text, options = target) => documentSymbols({ index: createIndex(text, options) });
const range = (line, character, endLine, endCharacter) => ({
  start: { line, character },
  end: { line: endLine, character: endCharacter },
});
const flatten = (symbols) =>
  symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children ?? [])]);
const names = (symbols) => symbols.map((symbol) => symbol.name);

test("programs contain distinct explicit commands and full implicit record ranges", () => {
  const text =
    "+PROG SOFIMSHA\nHEAD Example\nNODE 1 X 0 Y 0\n     2 X 1 Y 0\nNODE 3 X 2 Y 0\nEND\n\n+PROG AQUA\nCONC 1 C 30\nEND\n";
  const symbols = outline(text);
  assert.deepEqual(names(symbols), ["SOFIMSHA", "AQUA"]);
  assert.equal(symbols[0].kind, 2);
  assert.deepEqual(symbols[0].range, range(0, 0, 6, 0));
  assert.deepEqual(symbols[0].selectionRange, range(0, 6, 0, 14));
  assert.deepEqual(names(symbols[0].children), ["HEAD", "NODE", "NODE"]);
  const [, first, repeated] = symbols[0].children;
  assert.equal(first.kind, 6);
  assert.deepEqual(first.range, range(2, 0, 4, 0));
  assert.deepEqual(first.selectionRange, range(2, 0, 2, 4));
  assert.deepEqual(repeated.range, range(4, 0, 5, 0));
  assert.deepEqual(symbols[1].range, range(7, 0, 10, 0));
  assert.deepEqual(names(symbols[1].children), ["CONC"]);
});

test("tables and annotated continuations belong to their explicit command", () => {
  const symbols = outline(
    "+PROG SOFIMSHA\nNODE NO X Y Z\n1 0 3 0\n2 4 5 6\nNODE 3 X 4 $$ note; NODE fake\n Y 2 Z 3 ; NODE 4 X 8\nEND\n",
  );
  assert.deepEqual(names(symbols[0].children), ["NODE", "NODE", "NODE"]);
  assert.deepEqual(symbols[0].children[0].range, range(1, 0, 4, 0));
  assert.deepEqual(symbols[0].children[1].range, range(4, 0, 5, 10));
  assert.deepEqual(symbols[0].children[2].range, range(5, 11, 6, 0));
  assert.deepEqual(symbols[0].children[2].selectionRange, range(5, 11, 5, 15));
});

test("semicolon siblings retain exact selections and END separators", () => {
  const text = "  +prog aqua; head 'a; END'; conc 1 c 30; end; +prog ase; grp no 1 val full";
  const symbols = outline(text);
  assert.deepEqual(names(symbols), ["AQUA", "ASE"]);
  assert.deepEqual(names(symbols[0].children), ["HEAD", "CONC"]);
  const secondProgram = text.indexOf("+prog ase");
  const end = text.indexOf("end;") + 4;
  assert.deepEqual(symbols[0].range, range(0, 2, 0, end));
  assert.deepEqual(symbols[1].range, range(0, secondProgram, 0, text.length));
  const head = text.indexOf("head");
  const conc = text.indexOf("conc");
  assert.deepEqual(symbols[0].children[0].selectionRange, range(0, head, 0, head + 4));
  assert.deepEqual(symbols[0].children[0].range, range(0, head, 0, conc - 1));
});

test("unfinished programs end at the next header or actual EOF", () => {
  const text = "+PROG AQUA\nCONC 1 C 30\n+PROG ASE\nGRP NO 1 VAL FULL";
  const symbols = outline(text);
  assert.deepEqual(symbols[0].range, range(0, 0, 2, 0));
  assert.deepEqual(symbols[1].range, range(2, 0, 3, 17));
  assert.deepEqual(symbols[1].children[0].range, range(3, 0, 3, 17));
  assert.deepEqual(outline("+PROG AQUA\nEND")[0].range, range(0, 0, 1, 3));
});

test("END closes a command while module tails remain under their program", () => {
  const symbols = outline(
    "+PROG AQB\nLC 1\nEND\n$ tail comment\n\nLC 2\nEND\n+PROG AQUA\nEND\n\n$ trailing comment\n",
  );
  assert.deepEqual(names(symbols), ["AQB", "AQUA"]);
  assert.deepEqual(names(symbols[0].children), ["LC", "LC"]);
  assert.deepEqual(symbols[0].children[0].range, range(1, 0, 2, 0));
  assert.deepEqual(symbols[0].children[1].range, range(5, 0, 6, 0));
  assert.deepEqual(symbols[0].range, range(0, 0, 7, 0));
  assert.deepEqual(symbols[1].range, range(7, 0, 9, 0));
});

test("comments, strings, TEXT prose and unknown commands cannot invent symbols", () => {
  const symbols = outline(
    "+PROG SOFIMSHA\nHEAD 'NODE 8; +PROG AQUA'\n$ NODE 9\n! +PROG AQUA\n// NODE 10\n<TEXT,TITLE='NODE'>\n+PROG AQUA; NODE 11\n</TEXT>\n'NODE' 12\nWRONGCOMMAND NODE 13\nNODE 1 X 0\nEND\n",
  );
  assert.deepEqual(names(symbols), ["SOFIMSHA"]);
  assert.deepEqual(names(symbols[0].children), ["HEAD", "NODE"]);
  assert.deepEqual(symbols[0].children[0].range, range(1, 0, 2, 0));
  assert.deepEqual(symbols[0].children[1].selectionRange, range(10, 0, 10, 4));
});

test("legacy prose is opaque while its real opening and closing commands remain visible", () => {
  const symbols = outline(
    "+PROG SOFIMSHA\nTXAB prose\nNODE 1\n+PROG AQUA\nTXEN\nNODE 2 X 0\nEND\n",
  );
  // Legacy text does not parse arbitrary words as commands. PROG retains its
  // existing Finder meaning as a lexical program boundary even in legacy mode.
  assert.deepEqual(names(symbols), ["SOFIMSHA", "AQUA"]);
  assert.deepEqual(names(symbols[0].children), ["TXAB"]);
  assert.ok(!flatten(symbols).some((symbol) => symbol.selectionRange.start.line === 2));
});

test("control and picture boundaries cannot extend unrelated preceding commands", () => {
  const symbols = outline(
    "+PROG SOFIMSHA\nNODE 1 X 0\nLOOP 3\nNODE 2 X 1\nENDLOOP\n<PICT>\nNODE 3 X 2\n</PICT>\nEND\n",
  );
  assert.deepEqual(names(symbols[0].children), ["NODE", "NODE", "NODE"]);
  assert.deepEqual(
    symbols[0].children.map((symbol) => symbol.range.end.line),
    [2, 4, 7],
  );
});

test("variable and macro declarations stay visible without equal-range variable chains", () => {
  const text =
    "#DEFINE global=1\n+PROG SOFIMSHA\nHEAD Example\nLET#size 1\n#DEFINE local=2\nNODE 1 X #size\nEND\n+PROG SOFIMSHA\nGETN X 0 VAR result\nEND\n";
  const symbols = outline(text);
  assert.deepEqual(names(symbols), ["global", "SOFIMSHA", "SOFIMSHA"]);
  assert.deepEqual(names(symbols[1].children), ["HEAD", "NODE"]);
  assert.deepEqual(names(symbols[1].children[0].children), ["size", "local"]);
  assert.equal(symbols[1].children[0].children[0].kind, 13);
  assert.equal(symbols[1].children[0].children[1].kind, 12);
  const getn = symbols[2].children[0];
  assert.equal(getn.name, "GETN");
  assert.deepEqual(names(getn.children), ["result"]);
  assert.equal(getn.children[0].children, undefined);
  assert.deepEqual(
    workspaceSymbols(
      {
        documents: new Map([
          ["model", { uri: "untitled:model", index: createIndex(text, target) }],
        ]),
      },
      "",
    ).map((symbol) => symbol.name),
    ["global", "SOFIMSHA", "size", "local", "SOFIMSHA", "result"],
  );
});

test("commented and missing program headers are barriers without visible invented modules", () => {
  const symbols = outline(
    "+PROG AQUA\nHEAD first\n$PROG ASE\nGRP NO 1 VAL FULL\n+PROG\nLET#orphan 1\n+PROG UNKNOWN\nLET#known 2\nEND\n",
  );
  assert.deepEqual(names(symbols), ["AQUA", "GRP", "orphan", "UNKNOWN"]);
  assert.deepEqual(symbols[0].range, range(0, 0, 2, 0));
  assert.deepEqual(names(symbols[0].children), ["HEAD"]);
  assert.deepEqual(names(symbols.at(-1).children), ["known"]);
});

test("unsupported releases keep structural headers and declarations without command guessing", () => {
  const symbols = outline("+PROG ASE\nLET#size 1\nGRP NO 1 VAL FULL\nEND\n", { keywords: null });
  assert.deepEqual(names(symbols), ["ASE"]);
  assert.deepEqual(names(symbols[0].children), ["size"]);
  assert.deepEqual(symbols[0].range, range(0, 0, 4, 0));
});

test("incremental edits publish the same hierarchy as fresh and compact indexes", () => {
  const index = createIndex(
    "+PROG SOFIMSHA\nNODE 1 X 0\n 2 X 1\nNODE 3 X 2\nEND\n+PROG AQUA\nCONC 1 C 30\nEND\n",
    target,
  );
  for (const change of [
    { range: range(1, 10, 1, 10), text: " $$" },
    { range: range(4, 0, 5, 0), text: "" },
    { range: range(2, 0, 2, 0), text: "HEAD 'ą😀; NODE'\n" },
    { range: range(0, 0, 0, 15), text: "$PROG ASE" },
    { text: "+PROG AQUA\r\nCONC 1 C 30\r\nEND\r\n" },
  ]) {
    index.applyChanges([change]);
    const symbols = documentSymbols({ index });
    assert.deepEqual(symbols, outline(index.text));
    assert.deepEqual(
      symbols,
      documentSymbols({ index: createNavigationIndex(index.text, target) }),
    );
    for (const symbol of flatten(symbols)) {
      assert.ok(symbol.range.start.line <= symbol.selectionRange.start.line);
      assert.ok(symbol.selectionRange.end.line <= symbol.range.end.line);
    }
  }
});
