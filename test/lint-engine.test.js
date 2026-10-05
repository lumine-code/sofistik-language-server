"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LintEngine } = require("../lib/lint-engine");

const uri = "file:///main.dat";
const analyze = (text, options = {}) => new LintEngine().analyze({ uri, text, ...options });
const codes = (result) => result.diagnostics.map((item) => item.code);

test("reports reads in order, including a self-referencing first assignment", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a #a+1\nLET#b #later\nLET#later 2\nLET#c #later\nEND\n",
  );
  assert.deepEqual(codes(result), ["variable-before-declaration", "variable-before-declaration"]);
  assert.match(result.diagnostics[0].message, /#A.*analyzed input/);
  assert.equal(result.diagnostics[0].range.start.line, 0);
  assert.equal(result.diagnostics[1].data.recordOrigin.range.start.line, 2);
});

test("LET resets at PROG while ordered STO exports survive and END is conservative", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#local 1\nSTO#saved 2\nEND\nLET#again #local\n+PROG TEMPLATE\nLET#a #saved\nLET#b #local\nSTO#never\nEND\n",
  );
  assert.deepEqual(codes(result), ["variable-before-declaration", "variable-before-declaration"]);
  assert.match(result.diagnostics[0].message, /#LOCAL/);
  assert.match(result.diagnostics[1].message, /#NEVER/);
  assert.equal(result.diagnostics[0].range.start.line, 5);
});

test("STO without a RHS reads and exports a local value, even before a comment", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1,2,3\nSTO#a $ export\nEND\n+PROG TEMPLATE\nLET#b #a(2)\nEND\n",
  );
  assert.deepEqual(codes(result), []);
});

test("RCL and CDB-derived values retain external uncertainty", () => {
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nRCL#outside\nLET#a #outside(99)\nEND\n")), []);
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\n@KEY 20\nLET#a #database_value\nEND\n")), []);
});

test("RCL ALL imports unknown database names without exporting later local array edits", () => {
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nRCL#ALL\nLET#a #external\nEND\n")), []);
  const source =
    "+PROG TEMPLATE\nSTO#a(0) 1\nRCL#a\nLET#a(2) 3\nEND\n+PROG TEMPLATE\nLET#b #a(2)\nEND\n";
  assert.deepEqual(codes(analyze(source)), ["array-index-not-declared"]);
  assert.deepEqual(codes(analyze(source.replace("LET#a(2) 3", "LET#a(2) 3\nSTO#a"))), []);
});

test("DEL wildcard invalidates local and persistent symbols in order", () => {
  const result = analyze(
    "+PROG TEMPLATE\nSTO#temp_a 1\nLET#temp_b 2\nLET#keep 3\nDEL#temp*\nLET#a #temp_a+#temp_b+#keep\nEND\n+PROG TEMPLATE\nLET#a #temp_a\nEND\n",
  );
  assert.deepEqual(codes(result), [
    "variable-before-declaration",
    "variable-before-declaration",
    "variable-before-declaration",
  ]);
});

test("DEL wildcard matching retains suffixes after a question mark", () => {
  const source =
    "+PROG TEMPLATE\nSTO#a100 1\nSTO#ab00 2\nLET#keep 3\nDEL#A?00\nLET#x #a100+#ab00+#keep\nEND\n";
  assert.deepEqual(codes(analyze(source)), [
    "variable-before-declaration",
    "variable-before-declaration",
  ]);
});

test("legacy numeric vectors and named sparse arrays keep their assigned indices", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#11 4,5,6\nLET#a #11+#12+#13\nLET#sparse(3) 7,8\nLET#b #sparse(4)\nLET#c #sparse(0)\nLET#d #14\nEND\n",
  );
  assert.deepEqual(codes(result), ["array-index-not-declared", "variable-before-declaration"]);
  assert.match(result.diagnostics[0].message, /Index 0/);
  assert.match(result.diagnostics[1].message, /#14/);
});

test("space-separated literal vectors declare named and legacy array values", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1 2 3\nLET#11 4 5 6\nLET#b #a(0)+#a(1)+#a(2)+#11+#12+#13\nLET#c #a(3)\nEND\n",
  );
  assert.deepEqual(codes(result), ["array-index-not-declared"]);
  assert.match(result.diagnostics[0].message, /Index 3/);
});

test("spaced expression operators and quoted spaces do not create vector entries", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1\nLET#b 2\nLET#sum #a + #b\nLET#label 'one two three'\nLET#x #sum(1)\nLET#y #label(1)\nEND\n",
  );
  assert.deepEqual(codes(result), ["array-index-not-declared", "array-index-not-declared"]);
});

test("units stay with their values and dynamic vector lengths remain unknown", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1 [m] 2 [m] 3 [m]\nLET#b #a(2)\nLET#copy #a\nLET#c #copy(2)\nLET#range 1(1)10\nLET#d #range(9)\nEND\n",
  );
  assert.deepEqual(codes(result), []);
});

test("dynamic indices and runtime loops are not evaluated as numeric CADINP", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1,2\nLOOP#i a\nLET#b #a(#i)\nLET#created #i\nENDLOOP\nLET#c #created\nEND\n",
  );
  assert.deepEqual(codes(result), []);
});

test("bare LOOP array names are checked before the loop index is declared", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1 2 3\nLOOP#i a\nLET#b #i\nENDLOOP\nLOOP#j missing\nENDLOOP\nEND\n",
  );
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
  assert.match(result.diagnostics[0].message, /#MISSING/);
});

test("assigning a shorter array preserves previously assigned sparse entries", () => {
  const result = analyze("+PROG TEMPLATE\nLET#a(3) 5\nLET#a 1,2\nLET#b #a(3)\nEND\n");
  assert.deepEqual(codes(result), []);
});

test("IF branches start with their incoming state and join possible declarations", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#condition 1\nIF #condition\nLET#a 1\nELSE\nLET#b #a\nLET#a 2\nENDIF\nLET#c #a+#b\nEND\n",
  );
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
  assert.equal(result.diagnostics[0].data.recordOrigin.range.start.line, 5);
});

test("DEF probes and documented external or built-in names do not become missing reads", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a =DEF(missing)+PI+VERSION\nLET#b #GRP_MASS+#ASE_ITER+#AQB_USAGE+#OPT_RESULT\nEND\n+PROG SOFILOAD\nLET#a #COOR_X(1)\nEND\n",
  );
  assert.deepEqual(codes(result), []);
});

test("positive DEF guards make missing names and sparse indices safe inside their branch", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a(2) 1\nIF DEF(a(3))>0\nLET#b #a(3)\nENDIF\nIF DEF(outside)\nLET#c #outside\nELSE\nLET#d #outside\nENDIF\nEND\n",
  );
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
  assert.equal(result.diagnostics[0].data.recordOrigin.range.start.line, 8);
});

test("negative DEF checks and OR conditions do not assert that an index exists", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a(2) 1\nIF DEF(a(3))==0\nLET#b #a(3)\nENDIF\nIF DEF(a(4))>0 OR 1\nLET#c #a(4)\nENDIF\nEND\n",
  );
  assert.deepEqual(codes(result), ["array-index-not-declared", "array-index-not-declared"]);
});

test("bare CADINP expressions still expose ordinary reads", () => {
  const result = analyze("+PROG TEMPLATE\nLET#a 2\nLET#b =a+SIN(a)+missing+DEF(other)\nEND\n");
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
  assert.match(result.diagnostics[0].message, /#MISSING/);
});

test("semicolon, quotes, comments, TEXT and $$ continuations preserve logical records", () => {
  const result = analyze(
    "+PROG TEMPLATE\nLET#a 1, $$ #comment\n2,3 ; LET#b #a(2)\nHEAD 'quoted #absent; LET#fake 1' $ #other\n<TEXT>\nLET#prose #never\n</TEXT>\nEND\n",
  );
  assert.deepEqual(codes(result), []);
});

test("SOFILOAD checks LC loading context without requiring RESP before general ACCE", () => {
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nLINE P1 1\nLC 1\nLINE P1 2\nACCE AX 1\nEND\n")), [
    "load-without-load-case",
  ]);
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nLC 1\nLINE P1 1\nEND\n")), []);
});

test("END clears load-case context while retaining LET values in the same PROG", () => {
  const result = analyze(
    "+PROG SOFILOAD\nLET#x 17\nLC 1\nEND\nHEAD second\nLET#z #x+1\nNODE 1 TYPE PZZ P1 5\nEND\n",
  );
  assert.deepEqual(codes(result), ["load-without-load-case"]);
  assert.equal(result.diagnostics[0].data.recordOrigin.range.start.line, 6);
});

test("inactive -PROG bodies emit no diagnostics and do not export STO values", () => {
  const result = analyze(
    "-PROG SOFILOAD\nLINE P1 #missing\nSTO#disabled 1\n<TEXT>\nEND\n+PROG TEMPLATE\nLET#a #disabled\nEND\n",
  );
  assert.equal(result.metrics.modules, 2);
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
  assert.equal(result.diagnostics[0].range.start.line, 5);
});

test("$PROG remains a comment and preserves the actual module and its context", () => {
  const result = analyze("+PROG SOFILOAD\nLC 1; $PROG AQUA\n$PROG MAXIMA\nLINE P1 1\nEND\n");
  assert.equal(result.metrics.modules, 1);
  assert.deepEqual(codes(result), []);
});

test("LTD defaults to TASK and MOD inherits explicit source and target", () => {
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nLTD OPT MOD SRC 1 TRG 2\nLTDG\nEND\n")), [
    "ltd-without-task",
    "ltdg-without-task",
  ]);
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nLTD SRC 1 TRG 2\nLTD OPT MOD\nLTDG\nEND\n")), []);
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nLTD\nLTD OPT MOD\nEND\n")), [
    "ltd-mod-without-source",
    "ltd-mod-without-target",
  ]);
});

test("tributary records, polygon vertices and combination members need their parents", () => {
  assert.deepEqual(codes(analyze("+PROG SOFILOAD\nTRBP X 0\nTRB NO 1\nTRBA\nEND\n")), [
    "tributary-record-without-area",
  ]);
  assert.deepEqual(codes(analyze("+PROG AQUA\nVERT Y 0 Z 0\nPOLY\nVERT Y 1 Z 1\nEND\n")), [
    "vertex-without-polygon",
  ]);
  assert.deepEqual(codes(analyze("+PROG MAXIMA\nLC 1\nCOMB 1\nACT G\nEND\n")), [
    "combination-record-without-combination",
  ]);
});

test("German schemas supply the same curated context rules", () => {
  const result = analyze(
    "+PROG SOFILOAD\nKNOT NR 1\nLF 1\nSTAB NR 1\nENDE\n+PROG AQUA\nQP Y 0 Z 0\nQPOL\nQP Y 1 Z 1\nENDE\n+PROG MAXIMA\nLF 1\nKOMB 1\nACT G\nENDE\n",
    { language: "de" },
  );
  assert.deepEqual(codes(result), [
    "load-without-load-case",
    "vertex-without-polygon",
    "combination-record-without-combination",
  ]);
});

test("uncertain expansion suppresses local certainty and a new PROG restores context checks", () => {
  const text = "+PROG SOFILOAD\nLINE P1 1\n+PROG SOFILOAD\nLINE P1 2\nEND\n";
  const result = analyze(text, {
    complete: false,
    uncertainties: [{ start: text.indexOf("LINE"), end: text.indexOf("LINE"), kind: "include" }],
  });
  assert.deepEqual(codes(result), ["load-without-load-case"]);
  assert.equal(result.diagnostics[0].range.start.line, 2);
});

test("APPLY external uncertainty does not switch off local context rules", () => {
  const text = "+PROG SOFILOAD\n+APPLY outside.dat\nLET#a #outside\nLINE P1 1\nEND\n";
  const result = analyze(text, {
    complete: false,
    uncertainties: [{ start: text.indexOf("+APPLY"), end: text.indexOf("LET"), kind: "apply" }],
  });
  assert.deepEqual(codes(result), ["load-without-load-case"]);
});

test("unknown input preceding a PROG keeps external variables uncertain but restores local contexts", () => {
  const text = "\n+PROG SOFILOAD\nLET#a #outside\nLINE P1 1\nEND\n";
  for (const start of [0, 1]) {
    const result = analyze(text, {
      complete: false,
      uncertainties: [{ start, end: start, kind: "include" }],
    });
    assert.deepEqual(codes(result), ["load-without-load-case"]);
  }
});

test("incomplete preprocessing without location information is conservative", () => {
  const result = analyze("+PROG SOFILOAD\nLET#a #outside\nLINE P1 1\nEND\n", { complete: false });
  assert.deepEqual(codes(result), []);
});

test("module cache depends on preceding STO and remaps reused issues after source moves", () => {
  const engine = new LintEngine();
  const first = "+PROG TEMPLATE\nSTO#p 1\nEND\n+PROG TEMPLATE\nLET#a #p+#missing\nEND\n";
  const initial = engine.analyze({ uri, text: first });
  assert.equal(initial.metrics.analyzedModules, 2);
  const moved = engine.analyze({ uri, text: `$ moved\n${first}` });
  assert.equal(moved.metrics.reusedModules, 2);
  assert.equal(moved.diagnostics[0].range.start.line, 4);
  assert.equal(moved.diagnostics[0].data.recordOrigin.range.start.line, 5);
  const changed = engine.analyze({ uri, text: first.replace("STO#p", "LET#p") });
  assert.equal(changed.metrics.analyzedModules, 2);
  assert.equal(changed.diagnostics.length, 2);
});

test("source mapping anchors an included program at its outermost invocation", () => {
  const text = "+PROG SOFILOAD\nLINE P1 1\nEND\n";
  const included = "file:///included.dat";
  const invocation = {
    uri,
    range: { start: { line: 7, character: 0 }, end: { line: 7, character: 23 } },
  };
  const segments = [];
  let offset = 0;
  for (const [line, raw] of text.split("\n").entries()) {
    if (!raw) continue;
    segments.push({
      start: offset,
      end: offset + raw.length + 1,
      origin: {
        uri: included,
        range: { start: { line, character: 0 }, end: { line, character: raw.length } },
      },
      invocation,
    });
    offset += raw.length + 1;
  }
  const result = analyze(text, { segments });
  assert.deepEqual(result.diagnostics[0].range, invocation.range);
  assert.equal(result.diagnostics[0].relatedInformation[0].location.uri, included);
  assert.equal(result.diagnostics[0].data.recordOrigin.range.start.line, 1);
  assert.deepEqual(result.diagnostics[0].data.invocation, invocation);
});

test("unchanged expanded input reuses compact lexical blocks", () => {
  const engine = new LintEngine();
  const text = "+PROG TEMPLATE\nLET#a 1\nEND\n+PROG SOFILOAD\nLINE P1 1\nEND\n";
  engine.analyze({ uri, text });
  const result = engine.analyze({ uri, text });
  assert.equal(result.metrics.scannedLines, 0);
  assert.equal(result.metrics.parsedRecords, 0);
  assert.equal(result.metrics.reusedLexicalModules, 2);
  assert.equal(result.metrics.reusedModules, 2);
});

test("ordinary local edits reparse one module and rebase unchanged following records", () => {
  const engine = new LintEngine();
  const text =
    "+PROG TEMPLATE\nSTO#p 1\nEND\n+PROG TEMPLATE\nLET#a 1\nEND\n+PROG SOFILOAD\nLINE P1 1\nEND\n";
  engine.analyze({ uri, text });
  const changed = text.replace("LET#a 1", "LET#a #missing\nLET#b 1");
  const result = engine.analyze({ uri, text: changed });
  assert.equal(result.metrics.scannedLines, 4);
  assert.equal(result.metrics.reusedLexicalModules, 2);
  assert.equal(result.metrics.analyzedModules, 1);
  assert.equal(result.diagnostics[1].range.start.line, 7);
  assert.equal(result.diagnostics[1].data.recordOrigin.range.start.line, 8);
});

test("adding a PROG header falls back to a complete scan and resets variables", () => {
  const engine = new LintEngine();
  const text = "+PROG TEMPLATE\nLET#a 1\nLET#b #a\nEND\n";
  engine.analyze({ uri, text });
  const result = engine.analyze({ uri, text: text.replace("LET#b", "+PROG TEMPLATE\nLET#b") });
  assert.equal(result.metrics.modules, 2);
  assert.equal(result.metrics.reusedLexicalModules, 0);
  assert.deepEqual(codes(result), ["variable-before-declaration"]);
});

test("an edit leaving TEXT open reparses following apparent program headers", () => {
  const engine = new LintEngine();
  const text = "+PROG TEMPLATE\nLET#a 1\nEND\n+PROG SOFILOAD\nLINE P1 1\nEND\n";
  engine.analyze({ uri, text });
  const result = engine.analyze({ uri, text: text.replace("LET#a 1", "<TEXT>\nLET#a 1") });
  assert.equal(result.metrics.modules, 1);
  assert.equal(result.metrics.reusedLexicalModules, 0);
  assert.deepEqual(codes(result), []);
});

test("END edits preserve explicit PROG boundaries and conservative local scope", () => {
  const engine = new LintEngine();
  const text = "+PROG TEMPLATE\nLET#a 1\nEND\nLET#b #a\n+PROG TEMPLATE\nLET#c #a\nEND\n";
  engine.analyze({ uri, text });
  const result = engine.analyze({ uri, text: text.replace("END\nLET#b", "$ removed END\nLET#b") });
  assert.equal(result.metrics.modules, 2);
  assert.equal(result.metrics.reusedLexicalModules, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].range.start.line, 4);
});

test("cancellation returns no partially accumulated diagnostics", () => {
  let calls = 0;
  const result = analyze("+PROG SOFILOAD\nLINE P1 1\nEND\n+PROG AQUA\nVERT\nEND\n", {
    isCancelled: () => ++calls > 3,
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.diagnostics, []);
});

test("repeated missing names and contexts have bounded diagnostic output", () => {
  const result = analyze(`+PROG SOFILOAD\n${"LINE P1 #missing\n".repeat(3000)}END\n`);
  assert.equal(result.diagnostics.length, 100);
});

test("repeated issues retain separate source records for per-line suppression", () => {
  const result = analyze(
    "+PROG SOFILOAD\nLINE P1 #missing ! noqa: G101,SL001\nLINE P1 #missing\nEND\n",
  );
  assert.deepEqual(codes(result), [
    "variable-before-declaration",
    "load-without-load-case",
    "variable-before-declaration",
    "load-without-load-case",
  ]);
  assert.deepEqual(
    result.diagnostics.map((item) => item.data.recordOrigin.range.start.line),
    [1, 1, 2, 2],
  );
});
