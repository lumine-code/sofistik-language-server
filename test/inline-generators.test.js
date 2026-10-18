"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikSchemaProvider } = require("@lumine-code/sofistik-schema");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { codeFor, filterDiagnostics } = require("../lib/lint-codes");

const provider = new SofistikSchemaProvider();
const uri = "file:///project/main.dat";
const codes = new Set(["inline-generator-increment", "unclosed-inline-generator"]);
const program = (body, module = "SOFILOAD") => `+PROG ${module}\n${body}\nEND\n`;
function analyze(
  text,
  { version = "2026", language = "en", engine = new LintEngine(), ...rest } = {},
) {
  const result = engine.analyze({
    uri,
    text,
    version,
    language,
    keywords: provider.forRelease(version, language),
    ...rest,
  });
  return result.diagnostics.filter((issue) => codes.has(issue.code));
}
const selected = (text, issue) => {
  const lines = text.split(/\r?\n/);
  return lines
    .slice(issue.range.start.line, issue.range.end.line + 1)
    .map((line, index, all) =>
      line.slice(
        index ? 0 : issue.range.start.character,
        index === all.length - 1 ? issue.range.end.character : undefined,
      ),
    )
    .join("\n");
};

test("inline generator diagnostic codes remain stable", () => {
  assert.equal(codeFor("inline-generator-increment"), "G311");
  assert.equal(codeFor("unclosed-inline-generator"), "G312");
});

test("exactly one generator may supply a third increment argument", () => {
  for (const body of [
    "LC (1 11 1) TITL (101 111)",
    "LC (1 11) TITL (101 111 1)",
    "LC (1 11 1)",
    "LC (1 11) FACT (2 3 1) TITL (101 111)",
    "LC (11 1 -1) TITL (111 101)",
    "LC (1_11_1) TITL (101_111)",
  ])
    assert.deepEqual(analyze(program(body)), [], body);
});

test("single and multiple secondary generators require one primary generator", () => {
  for (const body of ["LC (1 11)", "LC (1 11) TITL (101 111)", "LC (1_11)"]) {
    const text = program(body);
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, [], body);
    assert.equal(issue.code, "inline-generator-increment");
    assert.equal(selected(text, issue), body.includes("_") ? "(1_11)" : "(1 11)");
    assert.match(issue.message, /Exactly one/);
  }
});

test("comma and numeric underscore lists drive secondary generators", () => {
  for (const body of [
    "NODE (1 1) X -129,-105,-75,-45,-15",
    "NODE (1 1) X -129_-105_-75_-45_-15",
    "NODE 1,3,5,7,9 X 0 Y (0. 100.) Z (0.00 -0.20)",
    "NODE (1 1) X #x,#y,#z Y (0 1)",
    "NODE (1 1) $$\n X 0,1,2",
    "NODE (1 1) X 0,1,2[mm]",
  ])
    assert.deepEqual(analyze(program(body, "SOFIMSHA")), [], body);

  for (const body of [
    "LC (1 11) FACT MAX(1,2)",
    "LC (1 11) FACT #my_array",
    "LC (1 11) FACT #array_1_2",
    "LC (1 11) TITL 'first,last'",
    "LC (1 11) TITL 'first_1_2'",
  ])
    assert.equal(analyze(program(body))[0]?.code, "inline-generator-increment", body);
});

test("repeated and incremented list items preserve generation for the same record name", () => {
  for (const repeat of ["=", "++", "--"]) {
    const body = `NODE (11 1) 0.0,1.8,2.2 0.0\n(21 1) ${repeat} 1.25`;
    assert.deepEqual(analyze(program(body, "SOFIMSHA")), [], body);
  }
  const inherited = program(
    "NODE NO X Y\n(11 1) 0.0,1.8,2.2 0.0\n(21 1) = 1.25\n(31 1) = 1.75",
    "SOFIMSHA",
  );
  assert.deepEqual(analyze(inherited), []);
  for (const body of [
    "NODE (11 1) 0.0,1.8,2.2 0.0\n(21 1) ==",
    "NODE (11 1) 0.0 0.0,1.8,2.2\n(21 1) ==",
  ])
    assert.deepEqual(analyze(program(body, "SOFIMSHA")), [], body);

  for (const body of [
    "NODE (11 1) 0.0,1.8,2.2 0.0\nNODE (21 1) 0.0 =",
    "NODE (11 1) 0.0,1.8,2.2 0.0\nNODE 21 0.0 0.0\nNODE (31 1) = 0.0",
    "NODE (11 1) 0.0,1.8,2.2 0.0\nGRP 1\nNODE (21 1) = 0.0",
  ])
    assert.equal(analyze(program(body, "SOFIMSHA"))[0]?.code, "inline-generator-increment", body);
});

test("lists do not permit multiple primaries, invalid arguments or unclosed generators", () => {
  for (const [body, code] of [
    ["NODE (1 3 1) X 0,1,2 Y (0 2 1)", "inline-generator-increment"],
    ["NODE (1 3 1 4) X 0,1,2", "inline-generator-increment"],
    ["NODE X 0,1,2 NO (1 1", "unclosed-inline-generator"],
  ])
    assert.ok(
      analyze(program(body, "SOFIMSHA")).some((issue) => issue.code === code),
      body,
    );

  assert.deepEqual(analyze(program("NODE NO X=0,1,2 Y\n(1 1) - 0", "SOFIMSHA")), []);
});

test("extra primary generators select their own expression", () => {
  const text = program("LC (1 11 1) FACT (2 3 1) TITL (101 111 1)");
  const issues = analyze(text);
  assert.deepEqual(
    issues.map((issue) => selected(text, issue)),
    ["(2 3 1)", "(101 111 1)"],
  );
  assert.ok(issues.every((issue) => issue.code === "inline-generator-increment"));
  assert.ok(issues.every((issue) => /Only one/.test(issue.message)));
});

test("generators with more than three arguments have invalid increment syntax", () => {
  for (const body of ["LC (1 11 1 2)", "LC (1 11 1) TITL (101 111 1 2)"]) {
    const text = program(body);
    const [issue, ...others] = analyze(text);
    assert.deepEqual(others, []);
    assert.equal(issue.code, "inline-generator-increment");
    assert.match(issue.message, /requires two arguments/);
  }
});

test("unclosed generators are diagnosed even when another generator supplies the increment", () => {
  for (const body of ["LC (1 11) TITL (101 111", "LC (1 11 1) TITL (101 111", "LC (1 11 1"]) {
    const text = program(body);
    const issues = analyze(text);
    const unclosed = issues.filter((issue) => issue.code === "unclosed-inline-generator");
    assert.equal(unclosed.length, 1, body);
    assert.equal(selected(text, unclosed[0]), body.slice(body.lastIndexOf("(")));
  }
});

test("nested arithmetic, indexed variables and variable names stay within generator arguments", () => {
  for (const body of [
    "LC (SIN(1) 11 1) TITL (101 111)",
    "LC (#start_value #end_value #step) TITL (101 111)",
    "LC (111+10*#1 110+10*#1+#BN(#1+1) 1)",
    "LC (1 11 #steps(1)) TITL (101 111)",
    "LC (1 [m] 11 [m] 1 [m])",
    "LC (1 11 1) TITL ('first title' 'last title')",
  ])
    assert.deepEqual(analyze(program(body)), [], body);
  const text = program("LC (SIN(1) #end_value) TITL (101 111)");
  assert.equal(analyze(text)[0].code, "inline-generator-increment");
});

test("functions, indices, grouping, repeat markers, strings and comments are not generators", () => {
  for (const body of [
    "LC 1 FACT SIN(1)",
    "LC 1 FACT MAX (1 2)",
    "LC 1 FACT #values(1 2)",
    "LC 1 FACT =(1 + 2)",
    "LC 1 FACT -(1 + 2)",
    "LC 1 FACT - (1 + 2)",
    "LC 1 FACT + (1 11)",
    "LC 1 FACT * (1 11)",
    "LC 1 FACT (1 + 2)",
    "LC 1 FACT ((1+2)*3)",
    "LC 1 FACT 1(1)10",
    "LC 1 TITL '(1 11)'",
    'LC 1 TITL "(1 11 1) (101 111 1)"',
    "LC 1 ! (1 11)",
    "LC 1 $ (1 11)",
    "LC 1 // (1 11)",
    "HEAD (1 11)",
    "TEXT (1 11)",
    "IF (1 + 2)\nENDIF",
    "-PROG SOFILOAD\nLC (1 11)",
  ])
    assert.deepEqual(analyze(program(body)), [], body);
});

test("LET and STO array generators check only assignment values", () => {
  for (const command of ["LET", "STO"]) {
    assert.deepEqual(analyze(program(`${command}#a (1 10 1)`, "TEMPLATE")), []);
    assert.equal(
      analyze(program(`${command}#a (1 10)`, "TEMPLATE"))[0]?.code,
      "inline-generator-increment",
    );
    assert.deepEqual(analyze(program(`${command}#a(1) #other(1)`, "TEMPLATE")), []);
    assert.deepEqual(analyze(program(`${command}#a - (1 10)`, "TEMPLATE")), []);
    assert.equal(
      analyze(program(`${command}#a $$\n(1 10)`, "TEMPLATE"))[0]?.code,
      "inline-generator-increment",
    );
  }
});

test("a spaced generator after a variable belongs to the next value", () => {
  for (const [body, module] of [
    ["LC #id (101 111)", "SOFILOAD"],
    ["LC 1 TYPE NONE (101 111)", "SOFILOAD"],
    ["NODE #id (1 11)", "SOFIMSHA"],
  ])
    assert.equal(analyze(program(body, module))[0]?.code, "inline-generator-increment");
});

test("whole-value markers start the next positional generator at a resolved item boundary", () => {
  for (const body of [
    "BEAM - (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM ++ (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM -- (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM = (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM NO - (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM NO=- (101 120 1) (102 1) NCS 1 KR posy",
    "BEAM NO NA NE NCS\n- (101 120 1) (102 1) 1",
    "BEAM - (101 120 1) $$\n (102 1) NCS 1 KR posy",
  ])
    assert.deepEqual(analyze(program(body, "SOFIMSHA")), [], body);

  const missing = program("BEAM - (101 120) (102 1) NCS 1", "SOFIMSHA");
  const [missingIssue, ...missingOthers] = analyze(missing);
  assert.deepEqual(missingOthers, []);
  assert.equal(selected(missing, missingIssue), "(101 120)");
  assert.match(missingIssue.message, /Exactly one/);

  const extra = program("BEAM - (101 120 1) (102 121 1) NCS 1", "SOFIMSHA");
  const [extraIssue, ...extraOthers] = analyze(extra);
  assert.deepEqual(extraOthers, []);
  assert.equal(selected(extra, extraIssue), "(102 121 1)");
  assert.match(extraIssue.message, /Only one/);

  const header = "NODE NO X PHIZ Z FIX\n";
  assert.deepEqual(analyze(program(`${header}(2 5 1) = (6.625 13.25) = F`, "SOFIMSHA")), []);
  assert.deepEqual(analyze(program(`${header}(2 1) = (6.625 13.25 1) = F`, "SOFIMSHA")), []);
  const repeated = program(`${header}(2 5 1) = (6.625 13.25 1) = F`, "SOFIMSHA");
  const [repeatedIssue, ...repeatedOthers] = analyze(repeated);
  assert.deepEqual(repeatedOthers, []);
  assert.equal(selected(repeated, repeatedIssue), "(6.625 13.25 1)");
  assert.match(repeatedIssue.message, /Only one/);
});

test("table rows and semicolons each have an independent generator count", () => {
  const text = program(
    "LC NO TITL\n(1 11) (101 111)\n(1 11 1) (101 111)\nLC (1 11 1); LC (12 20)\nLC (21 30); LC (31 40 1)",
  );
  assert.deepEqual(
    analyze(text).map((issue) => issue.range.start.line),
    [2, 4, 5],
  );
});

test("physical continuations share one primary and preserve generator source ranges", () => {
  assert.deepEqual(analyze(program("LC (1 11 1) $$ ignored (1 2 1)\n TITL (101 111)")), []);
  assert.deepEqual(analyze(program("LC (1 11) $$\n TITL (101 111 1)")), []);
  assert.deepEqual(analyze(program("LC (1 $$\n 11 1) TITL (101 111)")), []);
  const text = program("LC (1 11 1) $$\n TITL (101 111 1)");
  const [issue] = analyze(text);
  assert.equal(issue.range.start.line, 2);
  assert.equal(selected(text, issue), "(101 111 1)");
  const unclosed = program("LC (1 $$\n 11");
  assert.ok(analyze(unclosed).some((issue) => issue.code === "unclosed-inline-generator"));
});

test("verified releases and native keyword languages share the general rule", () => {
  for (const version of ["2018", "2020", "2022", "2023", "2024", "2025", "2026"]) {
    for (const [language, command] of [
      ["en", "LC"],
      ["de", "LF"],
    ])
      assert.equal(
        analyze(program(`${command} (1 11)`), { version, language })[0]?.code,
        "inline-generator-increment",
      );
  }
  assert.deepEqual(analyze(program("LC (1 11)", "UNKNOWN")), []);
  assert.deepEqual(analyze(program("LC (1 11)"), { version: "2019" }), []);
});

test("native text records remain implicit strings in every supported release", () => {
  for (const version of ["2018", "2020", "2022", "2023", "2024", "2025", "2026"]) {
    for (const [language, command] of [
      ["en", "HEAD"],
      ["en", "TXB"],
      ["en", "TXE"],
      ["de", "KOPF"],
      ["de", "TXA"],
      ["de", "TXE"],
    ]) {
      const text = program(
        `${command.toLowerCase()} calc (part 2); LC (1 11)\n` +
          `${command} title's (draft $$\n${command} still (part 2) ! prose // prose`,
        "ASE",
      );
      assert.deepEqual(analyze(text, { version, language }), [], `${version}/${language}`);
    }
  }
});

test("cached analysis rechecks changed generator counts", () => {
  const engine = new LintEngine();
  assert.equal(analyze(program("LC (1 11)"), { engine }).length, 1);
  assert.deepEqual(analyze(program("LC (1 11 1)"), { engine }), []);
  assert.equal(analyze(program("LC (1 11 1) TITL (101 111 1)"), { engine }).length, 1);
});

test("macro and include generators map to original source and honor noqa", async () => {
  const text = "#DEFINE range=1 11\n+PROG SOFILOAD\nLC ($(range))\n#INCLUDE part.dat\nEND\n";
  const included = "file:///project/part.dat";
  const sources = new Map([
    [uri, text],
    [included, "LC (1 11) ! noqa: G311\n"],
  ]);
  const expanded = await preprocess(
    { uri, text },
    {
      readSource: async (source) =>
        sources.has(source) ? { uri: source, text: sources.get(source) } : null,
    },
  );
  const issues = analyze(expanded.text, expanded);
  assert.equal(issues.length, 2);
  assert.equal(selected(text, issues[0]), "($(range))");
  assert.ok(issues[0].relatedInformation.some(({ location }) => location.range.start.line === 0));
  assert.equal(issues[1].uri, included);
  const filtered = filterDiagnostics(issues, { uri, sources });
  assert.deepEqual(
    filtered.map((issue) => issue.code),
    ["G311"],
  );
  assert.deepEqual(filterDiagnostics(issues, { uri, sources, ignore: "G311" }), []);
  const unclosed = program("LC (1 11 ! noqa: G312");
  assert.deepEqual(
    filterDiagnostics(analyze(unclosed), { uri, sources: new Map([[uri, unclosed]]) }).map(
      (issue) => issue.code,
    ),
    ["G311"],
  );
});

test("unresolved preprocessing cannot prove the count of generator arguments", async () => {
  for (const body of ["LC (1 $(missing))", "LC (1 11 $(missing)) TITL (101 111 1)"]) {
    const expanded = await preprocess({ uri, text: program(body) });
    assert.deepEqual(analyze(expanded.text, expanded), []);
  }
  const expanded = await preprocess({ uri, text: program("LC (1 $(missing))\nLC (2 11)") });
  assert.equal(analyze(expanded.text, expanded).length, 1);
});
