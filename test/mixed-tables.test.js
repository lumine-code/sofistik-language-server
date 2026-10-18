"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex } = require("../lib/finder");
const { documentSymbols, semanticTokens } = require("../lib/features");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { LspClient } = require("./lsp-client");

const uri = "file:///mixed-table.dat";
const keywords = provider();
const targetFor = (language = "en") => ({
  version: "2026",
  language,
  keywords: keywords.forRelease("2026", language),
});
const program = (body, module = "MAXIMA") => `+PROG ${module}\n${body}\nEND\n`;
const sample = program(
  "SUPP ETYP TYPE LC COMB=1 EXTR=MAMI TITL='UDL_ueberlagert'\n" +
    " 'BEAM' MY 501\n 'SPRI' P 502\n 'NODE' PZ 505",
);
const rowValues = (record) =>
  record.tokens
    .filter((token) => token.role === "value" && token.type !== "equals")
    .map((token) => [token.value, token.param]);

async function analyze(text, language = "en") {
  const expanded = await preprocess({ uri, text }, { readSource: async () => null });
  assert.deepEqual(expanded.diagnostics, []);
  return new LintEngine().analyze({ uri, ...expanded, ...targetFor(language) });
}

test("MAXIMA mixed SUPP header preserves declared columns and produces no missing ETYP finding", async () => {
  const index = createIndex(sample, targetFor());
  const header = index.lines[1].records[0];
  assert.equal(header.tableDefinition, true);
  assert.deepEqual(header.context.tableHeader, ["ETYP", "TYPE", "LC", "COMB", "EXTR", "TITL"]);
  assert.deepEqual(rowValues(index.lines[2].records[0]), [
    ["'BEAM'", "ETYP"],
    ["MY", "TYPE"],
    ["501", "LC"],
  ]);
  assert.deepEqual(rowValues(index.lines[4].records[0]), [
    ["'NODE'", "ETYP"],
    ["PZ", "TYPE"],
    ["505", "LC"],
  ]);
  assert.deepEqual(
    index.enumTokens().map(({ value, param }) => [value, param]),
    [
      ["MAMI", "EXTR"],
      ["MY", "TYPE"],
      ["P", "TYPE"],
      ["PZ", "TYPE"],
    ],
  );
  assert.deepEqual((await analyze(sample)).diagnostics, []);
});

test("default-bearing columns preserve positions before, between and after bare columns", () => {
  for (const [header, columns, row, expected] of [
    [
      "SUPP COMB=1 EXTR=MAMI ETYP TYPE LC",
      ["COMB", "EXTR", "ETYP", "TYPE", "LC"],
      "- - 'BEAM' MY 501",
      [
        ["-", "COMB"],
        ["-", "EXTR"],
        ["'BEAM'", "ETYP"],
        ["MY", "TYPE"],
        ["501", "LC"],
      ],
    ],
    [
      "SUPP ETYP COMB=1 TYPE EXTR=MAMI LC",
      ["ETYP", "COMB", "TYPE", "EXTR", "LC"],
      "'BEAM' - MY - 501",
      [
        ["'BEAM'", "ETYP"],
        ["-", "COMB"],
        ["MY", "TYPE"],
        ["-", "EXTR"],
        ["501", "LC"],
      ],
    ],
    [
      "SUPP ETYP TYPE LC COMB=1 EXTR=MAMI",
      ["ETYP", "TYPE", "LC", "COMB", "EXTR"],
      "'BEAM' MY 501",
      [
        ["'BEAM'", "ETYP"],
        ["MY", "TYPE"],
        ["501", "LC"],
      ],
    ],
    [
      "SUPP ETYP COMB = 1 TYPE EXTR = 'MAMI' LC TITL = 'two words'",
      ["ETYP", "COMB", "TYPE", "EXTR", "LC", "TITL"],
      "'BEAM' 2 MY - 501 'row title'",
      [
        ["'BEAM'", "ETYP"],
        ["2", "COMB"],
        ["MY", "TYPE"],
        ["-", "EXTR"],
        ["501", "LC"],
        ["'row title'", "TITL"],
      ],
    ],
  ]) {
    const index = createIndex(program(`${header}\n ${row}`), targetFor());
    assert.equal(index.lines[1].records[0].tableDefinition, true, header);
    assert.deepEqual(index.lines[1].endState.tableHeader, columns, header);
    assert.deepEqual(rowValues(index.lines[2].records[0]), expected, header);
  }
});

test("mixed headers remain inert and their fixed values participate in each row's domain checks", async () => {
  for (const language of ["en", "de"]) {
    const header = "EIGE RH=110 TEMP";
    assert.deepEqual((await analyze(program(header, "AQB"), language)).diagnostics, []);
    const result = await analyze(program(`${header}\n- 20\n- 30`, "AQB"), language);
    assert.deepEqual(
      result.diagnostics.map((issue) => [issue.code, issue.data.recordOrigin.range.start.line]),
      [
        ["aqb-creep-humidity-range", 2],
        ["aqb-creep-humidity-range", 3],
      ],
    );
  }
});

test("mixed table row values keep their own ranges and dynamic constants stay unknown", async () => {
  const text = program("EIGE RH=50 TEMP\n- 90\n- 20", "AQB");
  const result = await analyze(text);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "aqb-creep-temperature-range");
  assert.deepEqual(result.diagnostics[0].range, {
    start: { line: 2, character: 2 },
    end: { line: 2, character: 4 },
  });
  assert.deepEqual(
    (await analyze(program("LET#humidity 110\nEIGE RH=#humidity TEMP\n- 20\n- 30", "AQB")))
      .diagnostics,
    [],
  );
});

test("omitted and explicit dash fields use header defaults independently for each row", async () => {
  const result = await analyze(program("EIGE TEMP RH=110\n20 50\n20\n20 -", "AQB"));
  assert.deepEqual(
    result.diagnostics.map((issue) => [issue.code, issue.data.recordOrigin.range.start.line]),
    [
      ["aqb-creep-humidity-range", 3],
      ["aqb-creep-humidity-range", 4],
    ],
  );
  const override = await analyze(program("EIGE TEMP RH=50\n20 110\n20", "AQB"));
  assert.deepEqual(
    override.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["aqb-creep-humidity-range", 2]],
  );
});

test("all-default headers and named fields outside the declared columns retain semantic checks", async () => {
  const text = program("EIGE TEMP=20 RH=110\n- -\n- 50", "AQB");
  const index = createIndex(text, targetFor());
  assert.equal(index.lines[1].records[0].tableDefinition, true);
  assert.deepEqual(index.lines[1].endState.tableHeader, ["TEMP", "RH"]);
  assert.deepEqual(
    (await analyze(text)).diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["aqb-creep-humidity-range", 2]],
  );
  const named = await analyze(program("EIGE TEMP\n20 RH 110\n20 RH 50", "AQB"));
  assert.deepEqual(
    named.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["aqb-creep-humidity-range", 2]],
  );
});

test("continued headers and data rows retain defaults and physical diagnostic ranges", async () => {
  for (const header of [
    "EIGE RH TEMP $$ header comment\nPHI=1",
    "EIGE RH=110 $$ header comment\nTEMP",
    "EIGE RH= $$ header comment\n110 TEMP",
    "EIGE RH=110 TEMP= $$ header comment\n20",
    "EIGE RH=110 TEMP $$ header comment\nPHI=1",
  ]) {
    const text = program(`${header}\n- $$ row comment\n90`, "AQB");
    const index = createIndex(text, targetFor());
    assert.deepEqual(index.lines[2].endState.tableHeader.slice(0, 2), ["RH", "TEMP"], header);
    const issues = (await analyze(text)).diagnostics;
    assert.ok(
      issues.some((issue) => issue.code === "aqb-creep-temperature-range"),
      header,
    );
    const temperature = issues.find((issue) => issue.code === "aqb-creep-temperature-range");
    assert.equal(temperature.range.start.line, 4, header);
  }
});

test("ordinary continued records revoke a provisional table header", async () => {
  for (const body of ["EIGE RH=110 $$\nTEMP 20", "EIGE RH $$\n110 TEMP 20"]) {
    const text = program(body, "AQB");
    const index = createIndex(text, targetFor());
    assert.equal(index.lines[2].endState.tableHeader, null, body);
    assert.deepEqual(
      (await analyze(text)).diagnostics.map((issue) => issue.code),
      ["aqb-creep-humidity-range"],
      body,
    );
  }
});

test("standalone equals repeats a supplied item instead of making it absent", async () => {
  for (const repeated of ["ETYP =", "ETYP="]) {
    const text = program(`SUPP ETYP NODE TYPE N\nSUPP ${repeated} TYPE N`);
    assert.deepEqual((await analyze(text)).diagnostics, [], repeated);
    assert.equal(createIndex(text, targetFor()).lines[2].records[0].tableDefinition, false);
  }
});

test("a spaced default assignment disambiguates an enum that is also an item name", () => {
  const schema = {
    forms: [{ slots: [{ name: "TYPE", enumValues: ["OTHER"] }, { name: "OTHER" }] }],
  };
  const index = createIndex(program("COMMAND TYPE = OTHER OTHER=1\n- 2", "CUSTOM"), {
    keywords: {
      getModuleNames: () => ["CUSTOM"],
      getCommandSchema: (_module, command) => (command === "COMMAND" ? schema : null),
    },
  });
  assert.equal(index.lines[1].records[0].tableDefinition, true);
  assert.deepEqual(index.lines[1].endState.tableHeader, ["TYPE", "OTHER"]);
  assert.deepEqual(rowValues(index.lines[2].records[0]), [
    ["-", "TYPE"],
    ["2", "OTHER"],
  ]);
});

test("table headers establish no load or task context before their rows execute", async () => {
  for (const header of ["NODE NO TYPE P1", "LTD OPT SRC TRG"]) {
    assert.deepEqual((await analyze(program(header, "SOFILOAD"))).diagnostics, []);
  }
  const loads = await analyze(program("NODE NO TYPE P1\n1 PZ 1", "SOFILOAD"));
  assert.deepEqual(
    loads.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["load-without-load-case", 2]],
  );
  const tasks = await analyze(program("LTD OPT SRC TRG\nMOD 1 2", "SOFILOAD"));
  assert.deepEqual(
    tasks.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["ltd-without-task", 2]],
  );
});

test("ordinary records with supplied values remain commands and missing ETYP is still diagnosed", async () => {
  for (const body of [
    "SUPP ETYP NODE TYPE N LC 501 COMB=1",
    "SUPP COMB=1 EXTR MAMI ETYP NODE TYPE N",
    "SUPP COMB 1 EXTR MAMI TYPE N",
  ]) {
    const index = createIndex(program(body), targetFor());
    assert.equal(index.lines[1].records[0].tableDefinition, false, body);
    assert.equal(index.lines[1].endState.tableHeader, null, body);
  }
  assert.deepEqual(
    (await analyze(program("SUPP COMB 1 EXTR MAMI TYPE N"))).diagnostics.map((issue) => issue.code),
    ["maxima-supp-element-type"],
  );
});

test("new commands and table-ending variable statements discard inherited fixed fields", async () => {
  const text = program("EIGE RH=50 TEMP\n- 20\nLET#value 1\nEIGE TEMP RH\n20 110", "AQB");
  const result = await analyze(text);
  assert.deepEqual(
    result.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["aqb-creep-humidity-range", 5]],
  );
  const direct = await analyze(program("EIGE RH=50 TEMP\n- 20\nEIGE RH 110 TEMP 20", "AQB"));
  assert.deepEqual(
    direct.diagnostics.map((issue) => [issue.code, issue.range.start.line]),
    [["aqb-creep-humidity-range", 3]],
  );
});

test("incremental fixed-field and column changes agree with a fresh index", () => {
  const index = createIndex(program("EIGE RH=50 TEMP\n- 20\n- 30", "AQB"), targetFor());
  for (const change of [
    {
      range: { start: { line: 1, character: 8 }, end: { line: 1, character: 10 } },
      text: "110",
    },
    {
      range: { start: { line: 1, character: 5 }, end: { line: 1, character: 16 } },
      text: "TEMP=20 RH",
    },
  ]) {
    index.applyChanges([change]);
    const fresh = createIndex(index.text, targetFor());
    assert.deepEqual(index.records, fresh.records);
    assert.deepEqual(semanticTokens({ index }), semanticTokens({ index: fresh }));
    assert.deepEqual(documentSymbols({ index }), documentSymbols({ index: fresh }));
  }
  assert.deepEqual(index.lines[1].endState.tableHeader, ["TEMP", "RH"]);
  assert.deepEqual(rowValues(index.lines[2].records[0]), [
    ["-", "TEMP"],
    ["20", "RH"],
  ]);
});

test("stdio linter accepts the mixed SUPP table while retaining actual missing-field diagnostics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-mixed-table-"));
  await fs.writeFile(path.join(root, "sofistik.def"), "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n");
  const client = new LspClient(root);
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await client.start();
  const documentUri = pathToFileURL(path.join(root, "model.dat")).href;
  const diagnostics = async () =>
    (await client.request("textDocument/diagnostic", { textDocument: { uri: documentUri } })).items;
  client.open(documentUri, sample);
  assert.deepEqual(
    (await diagnostics()).filter((issue) => issue.source === "sofistik-linter"),
    [],
  );
  client.change(documentUri, [{ text: program("SUPP COMB 1 EXTR MAMI TYPE N") }], 2);
  assert.ok((await diagnostics()).some((issue) => issue.code === "MX004"));
  client.change(documentUri, [{ text: program("EIGE RH=110 TEMP\n- 20\n- 30", "AQB") }], 3);
  assert.deepEqual(
    (await diagnostics())
      .filter((issue) => issue.data?.rule === "aqb-creep-humidity-range")
      .map((issue) => issue.data.recordOrigin.range.start.line),
    [2, 3],
  );
});
