"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { filterDiagnostics } = require("../lib/lint-codes");

const URI = "file:///project/main.dat";
const CONTROL_CODES = new Set([
  "orphan-control",
  "invalid-control-nesting",
  "missing-control-condition",
  "unclosed-control",
]);
const analyze = (text, options = {}) => new LintEngine().analyze({ uri: URI, text, ...options });
const controls = (result) => result.diagnostics.filter((item) => CONTROL_CODES.has(item.code));
const codes = (result) => controls(result).map((item) => item.code);

test("valid IF/ELSEIF/ELSE and nested LOOP controls are checked without expression evaluation", () => {
  const source =
    "+PROG TEMPLATE\nLET#flag 1\nIF #flag\nLOOP#i 3\nIF #i>0\nELSEIF #i==0\nELSE\nENDIF\nENDLOOP\nELSE\nENDIF\nEND\n";
  assert.deepEqual(codes(analyze(source)), []);
});

test("nonempty mismatched closers point to the closer and relate the open frame", () => {
  const result = analyze("+PROG TEMPLATE\nIF 1\nLOOP 2\nENDIF\nENDLOOP\nENDIF\nEND\n");
  assert.deepEqual(codes(result), ["invalid-control-nesting"]);
  const issue = controls(result)[0];
  assert.deepEqual(issue.range, {
    start: { line: 3, character: 0 },
    end: { line: 3, character: 5 },
  });
  assert.ok(
    issue.relatedInformation.some(
      (item) => item.message === "LOOP opened here." && item.location.range.start.line === 2,
    ),
  );
  const opposite = analyze("+PROG TEMPLATE\nLOOP 2\nIF 1\nENDLOOP\nENDIF\nENDLOOP\nEND\n");
  assert.deepEqual(codes(opposite), ["invalid-control-nesting"]);
  assert.match(controls(opposite)[0].message, /IF is still open/);
});

test("branches cannot interrupt an unclosed nested loop", () => {
  const result = analyze("+PROG TEMPLATE\nIF 1\nLOOP 2\nELSE\nENDLOOP\nENDIF\nEND\n");
  assert.deepEqual(codes(result), ["invalid-control-nesting"]);
});

test("duplicate ELSE and ELSEIF after ELSE are invalid within the same IF", () => {
  for (const branch of ["ELSE", "ELSEIF 1"]) {
    const result = analyze(`+PROG TEMPLATE\nIF 1\nELSE\n${branch}\nENDIF\nEND\n`);
    assert.deepEqual(codes(result), ["invalid-control-nesting"]);
    assert.ok(
      controls(result)[0].relatedInformation.some(
        (item) =>
          item.message === "ELSE already appeared here." && item.location.range.start.line === 2,
      ),
    );
  }
});

test("IF and eligible ELSEIF require a condition; zero remains a valid condition", () => {
  for (const expression of ["", " ()", " (( ))", " $ comment", " ! comment"]) {
    assert.deepEqual(codes(analyze(`+PROG TEMPLATE\nIF${expression}\nENDIF\nEND\n`)), [
      "missing-control-condition",
    ]);
  }
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nIF 0\nELSEIF\nENDIF\nEND\n")), [
    "missing-control-condition",
  ]);
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nIF 0\nELSEIF 0\nENDIF\nEND\n")), []);
});

test("bare LOOP uses the documented default bound, with or without ENDLOOP condition", () => {
  for (const source of [
    "+PROG TEMPLATE\nLOOP\nENDLOOP\nEND\n",
    "+PROG TEMPLATE\nLOOP#i\nENDLOOP #i>10\nEND\n",
  ])
    assert.deepEqual(codes(analyze(source)), []);
});

test("a continued IF condition is completed before missing-expression validation", () => {
  const result = analyze("+PROG TEMPLATE\nIF $$ continued\n 1\nENDIF\nEND\n");
  assert.deepEqual(codes(result), []);
});

test("open controls survive input END and only fail at a confirmed program boundary", () => {
  const valid = analyze("+PROG TEMPLATE\nIF 1\nEND\nENDIF\nEND\n");
  assert.deepEqual(codes(valid), []);
  const invalid = analyze("+PROG TEMPLATE\nIF 1\nEND\n+PROG TEMPLATE\nEND\n");
  assert.deepEqual(codes(invalid), ["unclosed-control"]);
  assert.equal(controls(invalid)[0].range.start.line, 1);
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nLOOP 2\n")), ["unclosed-control"]);
});

test("new control diagnostics support verified releases and DE input END spelling", () => {
  for (const version of ["2018", "2020", "2022", "2023", "2024", "2025", "2026"]) {
    for (const language of ["en", "de"]) {
      const end = language === "de" ? "ENDE" : "END";
      const result = analyze(`+PROG TEMPLATE\nif\nendif\n${end}\n`, { version, language });
      assert.deepEqual(codes(result), ["missing-control-condition"], `${version}/${language}`);
    }
  }
  for (const version of ["2019", "2099"]) {
    assert.deepEqual(codes(analyze("+PROG TEMPLATE\nIF\nLOOP 1\nENDIF\nEND\n", { version })), []);
  }
});

test("expanded control checks report empty-stack orphan closers in known programs", () => {
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nENDIF\nENDLOOP\nELSE\nELSEIF\nEND\n")), [
    "orphan-control",
    "orphan-control",
    "orphan-control",
    "orphan-control",
  ]);
  assert.deepEqual(codes(analyze("IF 1\n")), []);
});

test("disabled programs, comments, opaque TEXT and legacy text do not create control frames", () => {
  const source =
    "-PROG TEMPLATE\nIF\nLOOP 2\nENDIF\nEND\n+PROG TEMPLATE\n$ IF\nHEAD IF LOOP ENDIF\n<TEXT>\nIF\nLOOP\nENDIF\n</TEXT>\nTXAB\nIF\nLOOP\nENDIF\nTXEN\nEND\n";
  assert.deepEqual(codes(analyze(source)), []);
});

test("unknown included input suppresses downstream structure certainty until the next PROG", () => {
  const text = "+PROG TEMPLATE\nIF 1\nENDIF\n+PROG TEMPLATE\nIF\nENDIF\nEND\n";
  const position = text.indexOf("ENDIF");
  const result = analyze(text, {
    complete: false,
    uncertainties: [{ start: position, end: position, kind: "include" }],
  });
  assert.deepEqual(codes(result), ["missing-control-condition"]);
  assert.equal(controls(result)[0].range.start.line, 4);
});

test("unknown expansion at EOF or before the next header can supply a missing closer", () => {
  for (const suffix of ["", "+PROG TEMPLATE\nEND\n"]) {
    const first = "+PROG TEMPLATE\nIF 1\n";
    const text = first + suffix;
    const result = analyze(text, {
      complete: false,
      uncertainties: [{ start: first.length, end: first.length, kind: "include" }],
    });
    assert.deepEqual(codes(result), []);
  }
});

test("runtime APPLY and incomplete input suppress possible missing-control conclusions", () => {
  const text = "+PROG TEMPLATE\nIF 1\n+APPLY generated.dat\nEND\n";
  const position = text.indexOf("+APPLY");
  assert.deepEqual(
    codes(
      analyze(text, {
        complete: false,
        uncertainties: [{ start: position, end: position + 20, kind: "apply" }],
      }),
    ),
    [],
  );
  assert.deepEqual(codes(analyze("+PROG TEMPLATE\nIF\nEND\n", { complete: false })), []);
});

test("definite syntax failures suppress dependent symbol warnings across later branch resets", () => {
  const result = analyze(
    "+PROG TEMPLATE\nIF 1\nELSE\nELSE\nLET#a #missing\nENDIF\nLET#b #also_missing\nEND\n",
  );
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    ["invalid-control-nesting"],
  );
});

test("a control mismatch does not prevent independent literal parameter checks", () => {
  const result = analyze("+PROG STAR\nIF 1\nLOOP 2\nENDIF\nNSTR ALPH 2\nENDLOOP\nENDIF\nEND\n");
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-control-nesting"));
  assert.ok(
    result.diagnostics.some((item) => item.code.includes("alpha") || /ALPH/.test(item.message)),
  );
});

test("mismatches across file includes retain precise child ranges and opener links", async () => {
  const source = "+PROG TEMPLATE\nIF 1\nLOOP 2\n#include close.dat\nENDLOOP\nENDIF\nEND\n";
  const expanded = await preprocess(
    { uri: URI, text: source },
    {
      readSource: async (uri) => ({ uri, text: "ENDIF\n" }),
    },
  );
  const result = new LintEngine().analyze({ uri: URI, ...expanded });
  const issue = controls(result)[0];
  assert.equal(issue.uri, "file:///project/close.dat");
  assert.deepEqual(issue.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  });
  assert.ok(
    issue.relatedInformation.some(
      (item) => item.location.uri === URI && item.location.range.start.line === 2,
    ),
  );
});

test("reusable macro controls keep invocation blame and exact body source links", async () => {
  const source =
    "#define block\nPROG TEMPLATE\nIF 1\nLOOP 2\nENDIF\nENDLOOP\nENDIF\nEND\n#enddef\n#include block\n";
  const expanded = await preprocess({ uri: URI, text: source });
  const result = new LintEngine().analyze({ uri: URI, ...expanded });
  const issue = controls(result)[0];
  assert.equal(issue.range.start.line, 9);
  assert.equal(issue.data.focusOrigin.range.start.line, 4);
  assert.ok(
    issue.relatedInformation.some(
      (item) => item.message === "LOOP opened here." && item.location.range.start.line === 3,
    ),
  );
});

test("control NOQA uses the offending source line, not the opener's related source", () => {
  const source = "+PROG TEMPLATE\nIF 1\nLOOP 2\nENDIF ! noqa: G307\nENDLOOP\nENDIF\nEND\n";
  const result = analyze(source);
  assert.deepEqual(
    filterDiagnostics(result.diagnostics, { uri: URI, sources: new Map([[URI, source]]) }),
    [],
  );
  const openerOnly = source
    .replace("LOOP 2", "LOOP 2 ! noqa: G307")
    .replace("ENDIF ! noqa: G307", "ENDIF");
  assert.equal(
    filterDiagnostics(analyze(openerOnly).diagnostics, {
      uri: URI,
      sources: new Map([[URI, openerOnly]]),
    }).length,
    1,
  );
});

test("cached control issues survive unrelated preceding-module offsets", () => {
  const engine = new LintEngine();
  const head = "+PROG TEMPLATE\nHEAD first\nEND\n";
  const body = "+PROG TEMPLATE\nIF 1\nLOOP 2\nENDIF\nENDLOOP\nENDIF\nEND\n";
  const first = engine.analyze({ uri: URI, text: head + body });
  const repeated = engine.analyze({ uri: URI, text: head + body });
  assert.equal(repeated.metrics.reusedModules, 2);
  assert.deepEqual(repeated.diagnostics, first.diagnostics);
  const shifted = engine.analyze({
    uri: URI,
    text: head.replace("HEAD first\n", "HEAD first\n$ inserted\n") + body,
  });
  assert.equal(shifted.metrics.reusedModules, 1);
  assert.equal(controls(shifted)[0].range.start.line, controls(first)[0].range.start.line + 1);
});

test("many sequential valid controls add no diagnostics and retain module cache reuse", () => {
  const engine = new LintEngine();
  const text =
    "+PROG TEMPLATE\n" + "IF 1\nLOOP 2\nENDLOOP\nELSEIF 0\nELSE\nENDIF\n".repeat(1000) + "END\n";
  const first = engine.analyze({ uri: URI, text });
  assert.deepEqual(codes(first), []);
  const repeated = engine.analyze({ uri: URI, text });
  assert.equal(repeated.metrics.reusedModules, 1);
  assert.equal(repeated.metrics.parsedRecords, 0);
});

test("inactive preprocessor branches cannot create orphan control diagnostics", async () => {
  const source = "+PROG TEMPLATE\n#IF 0\nENDIF\n#ENDIF\nEND\n";
  const expanded = await preprocess({ uri: URI, text: source });
  assert.deepEqual(codes(new LintEngine().analyze({ uri: URI, ...expanded })), []);
});

test("ordinary file and memory-block includes can close their caller's controls", async () => {
  for (const source of [
    "+PROG TEMPLATE\nIF 1\n#include close.dat\nEND\n",
    "#define close\nENDIF\n#enddef\n+PROG TEMPLATE\nIF 1\n#include close\nEND\n",
  ]) {
    const expanded = await preprocess(
      { uri: URI, text: source },
      {
        readSource: async (uri) => ({ uri, text: "ENDIF\n" }),
      },
    );
    assert.deepEqual(codes(new LintEngine().analyze({ uri: URI, ...expanded })), []);
  }
});

test("orphan control findings have precise source ranges and preserve header NOQA", async () => {
  const source = "+PROG TEMPLATE $ noqa: G305\n  ENDIF\nEND\n";
  const result = analyze(source);
  const issue = controls(result)[0];
  assert.equal(issue.code, "orphan-control");
  assert.equal(issue.message, "ENDIF has no matching IF.");
  assert.deepEqual(issue.range, {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 7 },
  });
  assert.deepEqual(
    filterDiagnostics(result.diagnostics, { uri: URI, sources: new Map([[URI, source]]) }),
    [],
  );
  const expanded = await preprocess(
    { uri: URI, text: "+PROG TEMPLATE\n#include close.dat\nEND\n" },
    {
      readSource: async (uri) => ({ uri, text: "  ENDLOOP\n" }),
    },
  );
  const included = controls(new LintEngine().analyze({ uri: URI, ...expanded }))[0];
  assert.equal(included.uri, "file:///project/close.dat");
  assert.deepEqual(included.range, {
    start: { line: 0, character: 2 },
    end: { line: 0, character: 9 },
  });
});

test("unknown preprocessing and unsupported modules do not produce definite orphan diagnostics", () => {
  const text = "+PROG TEMPLATE\nENDIF\nEND\n+PROG TEMPLATE\nENDIF\nEND\n";
  const position = text.indexOf("ENDIF");
  const result = analyze(text, {
    complete: false,
    uncertainties: [{ start: position, end: position, kind: "include" }],
  });
  assert.deepEqual(codes(result), ["orphan-control"]);
  assert.equal(controls(result)[0].range.start.line, 4);
  assert.deepEqual(codes(analyze("+PROG UNKNOWN\nENDIF\nIF\nLOOP 1\nENDIF\nEND\n")), []);
  for (const version of ["2019", "2099"]) {
    assert.deepEqual(codes(analyze("+PROG TEMPLATE\nENDIF\nEND\n", { version })), []);
  }
});
