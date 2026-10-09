"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createIndex } = require("../lib/finder");
const { provider } = require("@lumine-code/sofistik-schema");

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
    "+PROG AQUA\nHEAD 'a; ''quoted'' $(macro) #fake ! PROG' \"\"double\"\" BAUMANN'S f'= tent'\n$ PROG SOFIMSHA\nHEAD #real $ #comment\n";
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

test("HEAD titles keep punctuation and semicolons as prose with real substitutions", () => {
  const text =
    "+PROG ASE\nLET#steps 2\n#DEFINE title=calc\n" +
    "head $(title) O'Brien (part 2), = prose; +PROG AQUA <TEXT> #steps #(#steps,4.2) [m]  \n" +
    "GRP NO 1 VAL FULL\nEND\n";
  const index = createIndex(text, target());
  assert.equal(index.lines[3].records.length, 1);
  assert.equal(index.lines[3].records[0].kind, "command");
  assert.equal(index.contextAt(at(text, "head", 1)).role, "command");
  for (const needle of ["O'Brien", "(part 2)", "= prose", "+PROG AQUA", "<TEXT>", "[m]  "]) {
    const context = index.contextAt(at(text, needle, 2));
    assert.equal(context.role, "text", needle);
    assert.equal(context.inText, true, needle);
    assert.equal(context.module, "ASE", needle);
  }
  assert.deepEqual(index.diagnostics, []);
  assert.deepEqual(
    index.occurrences.filter((item) => item.line === 3).map((item) => item.name),
    ["title", "steps", "steps"],
  );
  assert.equal(index.definitionsAt(at(text, "#steps #", 3)).length, 1);
  assert.equal(index.contextAt(at(text, "FULL", 1)).param, "VAL");
});

test("title dollar comments do not continue input or hide bang and slash prose", () => {
  const text =
    "+PROG ASE\nHEAD calc (part 2) $$ ignored\nGRP NO 1 VAL FULL\n" +
    "HEAD next ! bang // slash $ comment\nHEAD last $$ ignored\nGRP NO 2 VAL FULL\nEND\n";
  const index = createIndex(text, target());
  assert.equal(index.lines[2].records[0].continuedFromPrevious, false);
  assert.equal(index.contextAt(at(text, "! bang", 2)).role, "text");
  assert.equal(index.contextAt(at(text, "// slash", 2)).role, "text");
  for (const line of [1, 3, 4]) {
    const content = index.lines[line].text;
    assert.equal(index.contextAt({ line, character: content.length - 1 }).role, "comment");
  }
  assert.equal(index.contextAt(at(text, "FULL", 1)).param, "VAL");
  const changed = text.replace("HEAD calc", "GRP NO 1 VAL");
  index.applyChanges([{ text: changed }], 2);
  assert.deepEqual(index.lines, createIndex(changed, target()).lines);
});

test("native text commands retain substitutions without reading embedded HTML or code", () => {
  for (const [language, command] of [
    ["en", "TXB"],
    ["en", "TXE"],
    ["de", "TXA"],
    ["de", "TXE"],
  ]) {
    const text =
      "+PROG ASE\nLET#steps 2\n#DEFINE title=calc\n" +
      `${command} $(title) (part 2); <b>O'Brien #steps</b> $$ comment\n` +
      `${command} continued; +PROG AQUA (draft ! bang // slash\nLET#after 1\nEND\n`;
    const index = createIndex(text, {
      ...target(),
      language,
      keywords: provider().forRelease("2026", language),
    });
    assert.equal(index.contextAt(at(text, command, 1)).role, "command");
    assert.equal(index.contextAt(at(text, "(part 2)", 2)).role, "text");
    assert.equal(index.contextAt(at(text, "continued", 2)).role, "text");
    assert.equal(index.lines[3].records.length, 1);
    assert.equal(index.lines[4].records.length, 1);
    assert.equal(index.lines[5].records[0].kind, "variable");
    assert.equal(index.definitionsAt(at(text, "#steps<", 3)).length, 1);
    assert.deepEqual(index.diagnostics, []);
    assert.deepEqual(
      index.occurrences.filter((item) => item.line === 3).map((item) => item.name),
      ["title", "steps"],
    );
  }
});

test("legacy text blocks keep literal bodies and closing payload without declaring text variables", () => {
  for (const [language, command] of [
    ["en", "TXBB"],
    ["en", "TXEB"],
    ["de", "TXAB"],
    ["de", "TXEB"],
  ]) {
    const text =
      "+PROG ASE\nLET#steps 2\n#DEFINE title=calc\n" +
      `${command} $(title) O'Brien (part 2); LET#ghost 1\n` +
      "'unfinished <b> ! bang // slash; (1 11) $$ ignored\n" +
      "LET#steps 17\nLOOP#steps 2\nENDLOOP\n" +
      "TXEN ignored; LET#tail 5\nLET#after 1\nEND\n";
    const selected = {
      ...target(),
      language,
      keywords: provider().forRelease("2026", language),
    };
    const index = createIndex(text, selected);
    assert.equal(index.lines[3].records.length, 1);
    assert.equal(index.lines[4].records.length, 1);
    assert.equal(index.lines[4].endState.continued, false);
    assert.equal(index.lines[5].records[0].kind, "text");
    assert.equal(index.contextAt(at(text, "! bang", 2)).role, "text");
    assert.equal(index.contextAt(at(text, "// slash", 2)).role, "text");
    assert.equal(index.contextAt(at(text, "ignored;", 2)).role, "text");
    assert.deepEqual(index.diagnostics, []);
    assert.deepEqual(
      index.declarations.filter((item) => item.namespace === "variable").map((item) => item.name),
      ["steps", "after"],
    );
    assert.equal(
      index.occurrences.some((item) => item.name === "tail"),
      false,
    );
    const changed = text.replace("TXEN ignored; LET#tail 5", "still text");
    index.applyChanges([{ text: changed }], 2);
    assert.equal(
      index.declarations.some((item) => item.name === "after"),
      false,
    );
    assert.deepEqual(index.lines, createIndex(changed, selected).lines);
  }
});

test("legacy prose requires complete structural names and real PROG starts restore code", () => {
  const text =
    "+PROG ASE\nTXBB opening\nIF2 'unfinished; LOOP_name (1 11)\n" +
    "END9 'unfinished\nTXEN9 'unfinished\n+PROG SOFIMSHA\nNODE 1 X 0\nEND\n";
  const index = createIndex(text, target());
  assert.deepEqual(index.diagnostics, []);
  for (const line of [2, 3, 4]) {
    assert.equal(index.lines[line].records.length, 1);
    assert.equal(index.lines[line].records[0].kind, "text");
  }
  assert.equal(index.contextAt(at(text, "X 0", 2)).param, "X");
  assert.equal(index.contextAt(at(text, "X 0", 2)).module, "SOFIMSHA");
  assert.equal(index.lines[5].endState.mode, "code");
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
  const text = "NODE 1 X 0\nNODE 3 X 'unfinished\nNODE 2 Y 3\n";
  const index = createIndex(text, { ...target(), module: "SOFIMSHA", scopeId: "caller" });
  assert.equal(index.contextAt({ line: 0, character: 9 }).module, "SOFIMSHA");
  assert.equal(index.contextAt({ line: 2, character: 9 }).scopeId, "caller");
  assert.equal(index.diagnostics[0].code, "unterminated-string");
  assert.equal(createIndex("#DEFINE shared\n#INCLUDE $(incomplete", {}).diagnostics.length, 0);
});

test("only emits enum semantic tokens for values of an identified named or positional slot", () => {
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
  assert.equal(index.contextAt({ line: 4, character: 10 }).role, "text");
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

test("named GRP values advance through subsequent positional slots", () => {
  const records = [
    "GRP NUMB 57 OFF SPRI",
    "GRP NUMB=57 OFF SPRI",
    "GRP NUMB = 57 OFF SPRI",
    "GRP NUMB #base+1 OFF SPRI",
    "GRP NUMB (57) OFF SPRI",
    "GRP NUMB ((57)) OFF SPRI",
    "GRP NUMB=(57) OFF SPRI",
    "GRP NUMB=((57)) OFF SPRI",
    "GRP NUMB 57[mm] OFF SPRI",
    "GRP NUMB (57+#base)[mm] OFF SPRI",
    "GRP NUMB=(#base+1)[mm] OFF SPRI",
    "GRP NUMB 57 $$ annotation\nOFF SPRI",
    "GRP NUMB $$ annotation\n57 OFF SPRI",
    "GRP NUMB (57 $$ annotation\n+#base) OFF SPRI",
    "GRP NUMB 57 $$ annotation\nOFF $$ annotation\nSPRI",
    "GRP NUMB 57 OPTI OFF SPRI",
    "GRP NUMB 57 OFF ETYP SPRI",
  ];
  for (const module of ["RESULTS", "WING"]) {
    for (const record of records) {
      const text = `+PROG ${module}\n${record}\n`;
      const index = createIndex(text, target());
      const message = `${module}: ${record}`;
      for (const line of index.lines.slice(1)) {
        for (const token of line.tokens.filter((item) => item.role === "value")) {
          const expected =
            token.value === "OFF"
              ? ["OPTI", 1]
              : token.value === "SPRI"
                ? ["ETYP", 2]
                : ["NUMB", 0];
          assert.deepEqual([token.param, token.activeParameter], expected, message);
        }
      }
      for (const [value, param, activeParameter] of [
        ["OFF", "OPTI", 1],
        ["SPRI", "ETYP", 2],
      ]) {
        const context = index.contextAt(at(text, value, 1));
        assert.equal(context.param, param, message);
        assert.equal(context.activeParameter, activeParameter, message);
        assert.equal(context.role, "value", message);
      }
      assert.deepEqual(
        index.enumTokens().map((token) => [token.value, token.param]),
        [
          ["OFF", "OPTI"],
          ["SPRI", "ETYP"],
        ],
        message,
      );
    }
  }
});

test("positional and table GRP records use the same schema slots as named records", () => {
  for (const module of ["RESULTS", "WING"]) {
    for (const record of [
      "GRP 57 OFF SPRI",
      "GRP (57) OFF SPRI",
      "GRP NUMB OPTI ETYP\n57 OFF SPRI",
    ]) {
      const text = `+PROG ${module}\n${record}\n`;
      const index = createIndex(text, target());
      for (const [value, param, activeParameter] of [
        ["57", "NUMB", 0],
        ["OFF", "OPTI", 1],
        ["SPRI", "ETYP", 2],
      ]) {
        const context = index.contextAt(at(text, value, 1));
        assert.equal(context.param, param, `${module}: ${record}`);
        assert.equal(context.activeParameter, activeParameter, `${module}: ${record}`);
      }
    }
  }
});

test("table expressions retain the header's field order through adjacent fragments", () => {
  for (const module of ["RESULTS", "WING"]) {
    for (const record of [
      "GRP NUMB OPTI ETYP\n(#base+1)[mm] OFF SPRI",
      "GRP ETYP NUMB OPTI\nSPRI (#base+1)[mm] OFF",
    ]) {
      const text = `+PROG ${module}\n${record}\n`;
      const index = createIndex(text, target());
      for (const token of index.lines[2].tokens.filter((item) => item.role === "value")) {
        const expected =
          token.value === "OFF" ? ["OPTI", 1] : token.value === "SPRI" ? ["ETYP", 2] : ["NUMB", 0];
        assert.deepEqual([token.param, token.activeParameter], expected, `${module}: ${record}`);
      }
      for (const [value, param, activeParameter] of [
        ["#base", "NUMB", 0],
        ["+1", "NUMB", 0],
        ["[mm]", "NUMB", 0],
        ["OFF", "OPTI", 1],
        ["SPRI", "ETYP", 2],
      ]) {
        const context = index.contextAt(at(text, value, 1));
        assert.equal(context.param, param, `${module}: ${record}`);
        assert.equal(context.activeParameter, activeParameter, `${module}: ${record}`);
      }
    }
  }
});

test("positional values after an uncertain named slot remain unclassified", () => {
  const schema = {
    forms: [
      { slots: [{ name: "NUMB" }, { name: "OPTI", enumValues: ["OFF"] }] },
      { slots: [{ name: "OTHER" }, { name: "NUMB" }, { name: "ETYP", enumValues: ["OFF"] }] },
    ],
  };
  const keywords = {
    getModuleNames: () => ["CUSTOM"],
    getCommandSchema: (_module, command) => (command === "GRP" ? schema : null),
  };
  for (const record of ["GRP NUMB 57 OFF", "GRP NUMB 57 $$ annotation\nOFF"]) {
    const text = `+PROG CUSTOM\n${record}\n`;
    const index = createIndex(text, { keywords });
    const number = index.contextAt(at(text, "57", 1));
    assert.equal(number.param, "NUMB", record);
    assert.equal(number.activeParameter, null, record);
    const value = index.contextAt(at(text, "OFF", 1));
    assert.equal(value.param, null, record);
    assert.equal(value.activeParameter, null, record);
    assert.deepEqual(index.enumTokens(), [], record);
  }
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

test("quoted enum values retain their string context without semantic enum tokens", () => {
  const text =
    "+PROG ASE\nGRP NO 1 VAL 'FULL'\nGRP NO 2 VAL \"FULL\"\nGRP NO 3 VAL ''FULL''\nGRP NO 4 VAL \"\"FULL\"\"\nHEAD 'FULL'\n$ GRP NO 5 VAL 'FULL'\nGRP NO 6 VAL '$(choice)'\nGRP NO 7 VAL FULL\n";
  const index = createIndex(text, target());
  assert.deepEqual(
    index.enumTokens().map((item) => ({ value: item.value, param: item.param, range: item.range })),
    [
      {
        value: "FULL",
        param: "VAL",
        range: { start: { line: 8, character: 13 }, end: { line: 8, character: 17 } },
      },
    ],
  );
  const context = index.contextAt({ line: 1, character: 16 });
  assert.equal(context.prefix, "FU");
  assert.equal(context.role, "value");
  assert.equal(context.inString, true);
  assert.equal(context.param, "VAL");
});

test("partial remaining field names follow consumed values without stealing enum prefixes", () => {
  const cases = [
    {
      input: "GRP NO 1 F",
      prefix: "F",
      role: "param",
      names: ["FACS", "FACL", "FACD", "FACP", "FACT", "FACB"],
    },
    { input: "GRP NO 1 PH", prefix: "PH", role: "param", names: ["PHI", "PHIF", "PHIS"] },
    { input: "GRP NO=1\tPH", prefix: "PH", role: "param", names: ["PHI", "PHIF", "PHIS"] },
    {
      input: "GRP NO 1 $$ note\n\tPH",
      prefix: "PH",
      role: "param",
      names: ["PHI", "PHIF", "PHIS"],
    },
    {
      input: "GRP NO #size F",
      prefix: "F",
      role: "param",
      names: ["FACS", "FACL", "FACD", "FACP", "FACT", "FACB"],
    },
    { input: "GRP NO 1 VAL F", prefix: "F", role: "value", param: "VAL" },
    { input: "GRP NO=1\tVAL=F", prefix: "F", role: "value", param: "VAL" },
    { input: "GRP NO 1 VAL $$ note\n\tF", prefix: "F", role: "value", param: "VAL" },
    { input: "GRP NO 1 VAL 'F'", prefix: "F", role: "value", param: "VAL", quoted: true },
    { input: "GRP NO 1 'F'", prefix: "F", role: "value", param: "VAL", quoted: true },
    { input: "GRP NO 1 XYZ", prefix: "XYZ", role: "value", param: "VAL" },
  ];
  for (const item of cases) {
    const text = `+PROG ASE\n${item.input}`;
    const cursor = text.length - (item.quoted ? 1 : 0);
    const prefix = text.slice(0, cursor);
    const position = {
      line: prefix.split("\n").length - 1,
      character: cursor - prefix.lastIndexOf("\n") - 1,
    };
    const initialText = text.slice(0, cursor - item.prefix.length) + text.slice(cursor);
    const insertionPrefix = text.slice(0, cursor - item.prefix.length);
    const insertion = {
      line: insertionPrefix.split("\n").length - 1,
      character: insertionPrefix.length - insertionPrefix.lastIndexOf("\n") - 1,
    };
    const incremental = createIndex(initialText, target());
    incremental.applyChanges(
      [{ range: { start: insertion, end: insertion }, text: item.prefix }],
      2,
    );
    const fresh = createIndex(text, target());
    assert.deepEqual(incremental.contextAt(position), fresh.contextAt(position), item.input);
    for (const index of [fresh, incremental]) {
      const context = index.contextAt(position);
      assert.equal(context.role, item.role, item.input);
      assert.equal(context.prefix, item.prefix, item.input);
      assert.equal(context.param, item.param ?? null, item.input);
      assert.deepEqual(context.paramCandidates, item.names, item.input);
      assert.equal(index.enumTokens().length, 0, item.input);
    }
  }
});

test("used named fields remain excluded from partial matches across $$ continuation", () => {
  const text = "+PROG ASE\nGRP NO 1 PHI 2 $$ note\nPH";
  const index = createIndex(text, target());
  const context = index.contextAt({ line: 2, character: 2 });
  assert.equal(context.role, "param");
  assert.deepEqual(context.paramCandidates, ["PHIF", "PHIS"]);
});

test("comma-separated enum alternatives retain one positional slot and individual ranges", () => {
  for (const values of ["BEAM,GLN", "BEAM, GLN", "BEAM , GLN", "BEAM, $$ annotation\nGLN"]) {
    const text = `+PROG WING\nGRP NUMB 31+#grp YES ${values} DEFA\n`;
    const index = createIndex(text, target());
    for (const [value, param, activeParameter] of [
      ["31+", "NUMB", 0],
      ["#grp", "NUMB", 0],
      ["YES", "OPTI", 1],
      ["BEAM", "ETYP", 2],
      ["GLN", "ETYP", 2],
      ["DEFA", "GDIV", 3],
    ]) {
      const context = index.contextAt(at(text, value, 1));
      assert.equal(context.param, param, values);
      assert.equal(context.activeParameter, activeParameter, values);
    }
    assert.deepEqual(
      index.enumTokens().map((token) => ({ value: token.value, range: token.range })),
      ["YES", "BEAM", "GLN", "DEFA"].map((value) => ({
        value,
        range: { start: at(text, value), end: at(text, value, value.length) },
      })),
      values,
    );
  }
});

test("root expression lists stay in one field while function commas remain nested", () => {
  for (const record of [
    "GRP NUMB MAX(1,2), (31+#grp),57 YES BEAM,GLN",
    "GRP ETYP NUMB OPTI\nBEAM,GLN MAX(1,2), (31+#grp),57 YES,NO",
  ]) {
    const text = `+PROG WING\n${record}\n`;
    const index = createIndex(text, target());
    for (const [value, param, activeParameter] of [
      ["MAX", "NUMB", 0],
      ["1,2", "NUMB", 0],
      ["2)", "NUMB", 0],
      ["31+", "NUMB", 0],
      ["#grp", "NUMB", 0],
      ["57", "NUMB", 0],
      ["YES", "OPTI", 1],
      ["BEAM", "ETYP", 2],
      ["GLN", "ETYP", 2],
    ]) {
      const context = index.contextAt(at(text, value, 1));
      assert.equal(context.param, param, record);
      assert.equal(context.activeParameter, activeParameter, record);
    }
    assert.deepEqual(
      index.enumTokens().map((token) => token.value),
      record.startsWith("GRP ETYP") ? ["BEAM", "GLN", "YES", "NO"] : ["YES", "BEAM", "GLN"],
      record,
    );
  }
});

test("quoted list alternatives and commas inside quoted values keep string context", () => {
  for (const [values, expectedEnums] of [
    ["'BEAM',GLN", ["YES", "GLN", "DEFA"]],
    ["'BEAM', 'GLN'", ["YES", "DEFA"]],
    ["'BEAM,GLN'", ["YES", "DEFA"]],
  ]) {
    const text = `+PROG WING\nGRP NUMB 57 YES ${values} DEFA\n`;
    const index = createIndex(text, target());
    for (const value of ["BEAM", "GLN"]) {
      const context = index.contextAt(at(text, value, 1));
      assert.equal(context.param, "ETYP", values);
      assert.equal(context.activeParameter, 2, values);
    }
    assert.equal(index.contextAt(at(text, "BEAM", 1)).inString, true, values);
    assert.equal(index.contextAt(at(text, "DEFA", 1)).param, "GDIV", values);
    assert.deepEqual(
      index.enumTokens().map((token) => token.value),
      expectedEnums,
      values,
    );
  }
});

test("commas disambiguate enum alternatives that also name a parameter", () => {
  for (const values of ["YES, NO", "NO,YES"]) {
    const text = `+PROG ASE\nGRP NO 57 VAL ${values} FACS 1\n`;
    const index = createIndex(text, target());
    for (const value of ["YES", "NO"]) {
      const position = at(text, `VAL ${values}`, 4 + values.indexOf(value) + 1);
      const context = index.contextAt(position);
      assert.equal(context.param, "VAL", values);
      assert.equal(context.activeParameter, 1, values);
      assert.equal(context.role, "value", values);
      assert.equal(context.confidence, true, values);
    }
    assert.equal(index.contextAt(at(text, "FACS", 1)).param, "FACS", values);
    assert.deepEqual(
      index.enumTokens().map((token) => token.value),
      values.split(/,\s*/),
      values,
    );
  }
});

test("an unfinished list expects another value after the comma, whitespace or continuation", () => {
  for (const record of [
    "GRP NUMB 57 YES BEAM,",
    "GRP NUMB 57 YES BEAM, ",
    "GRP NUMB 57 YES BEAM, $$ annotation\n ",
  ]) {
    const text = `+PROG WING\n${record}`;
    const index = createIndex(text, target());
    const line = index.lines.length - 1;
    const context = index.contextAt({ line, character: index.lines[line].text.length });
    assert.equal(context.role, "value", record);
    assert.equal(context.param, "ETYP", record);
    assert.equal(context.activeParameter, 2, record);
    assert.equal(context.prefix, "", record);
  }
});

test("alternatives of an unnamed slot retain its known position across continuation", () => {
  const schema = {
    forms: [{ slots: [{ name: "NUMB" }, { name: null }, { name: "ETYP", enumValues: ["SPRI"] }] }],
  };
  const keywords = {
    getModuleNames: () => ["CUSTOM"],
    getCommandSchema: (_module, command) => (command === "GRP" ? schema : null),
  };
  for (const values of ["foo,bar", "foo, $$ annotation\nbar"]) {
    const text = `+PROG CUSTOM\nGRP NUMB 57 ${values} SPRI\n`;
    const index = createIndex(text, { keywords });
    for (const value of ["foo", "bar"]) {
      const context = index.contextAt(at(text, value, 1));
      assert.equal(context.param, null, values);
      assert.equal(context.activeParameter, 1, values);
    }
    const next = index.contextAt(at(text, "SPRI", 1));
    assert.equal(next.param, "ETYP", values);
    assert.equal(next.activeParameter, 2, values);
    assert.deepEqual(
      index.enumTokens().map((token) => token.value),
      ["SPRI"],
      values,
    );
  }
  const unfinished = createIndex("+PROG CUSTOM\nGRP NUMB 57 foo, $$ annotation\n ", { keywords });
  const context = unfinished.contextAt({ line: 2, character: 1 });
  assert.equal(context.role, "value");
  assert.equal(context.param, null);
  assert.equal(context.activeParameter, 1);
});

test("incremental comma edits converge with fresh positional and list assignments", () => {
  const text = "+PROG WING\nGRP NUMB 57 YES BEAM GLN\n";
  const index = createIndex(text, target());
  const position = at(text, "BEAM", 4);
  for (const [version, replacement, width, expectedParam] of [
    [2, ",", 0, "ETYP"],
    [3, "", 1, "GDIV"],
  ]) {
    index.applyChanges(
      [
        {
          range: { start: position, end: { ...position, character: position.character + width } },
          text: replacement,
        },
      ],
      version,
    );
    const fresh = createIndex(index.text, target());
    const contextPosition = at(index.text, "GLN", 1);
    assert.deepEqual(index.contextAt(contextPosition), fresh.contextAt(contextPosition));
    assert.deepEqual(index.enumTokens(), fresh.enumTokens());
    assert.equal(index.contextAt(contextPosition).param, expectedParam);
  }
});
