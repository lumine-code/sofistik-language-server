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
          `${command} title's (draft $$\n still (part 2)`,
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
