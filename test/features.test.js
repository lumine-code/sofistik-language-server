const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { createIndex } = require("../lib/finder");
const { signatureHelp, completion, hover } = require("../lib/features");

const keywords = new SofistikDataProvider().forRelease("2026", "en");

function projectFor(module, record) {
  const text = `+PROG ${module}\n${record}\nEND\n`;
  const index = createIndex(text, { version: "2026", language: "en", keywords });
  return {
    loadDocument: async () => ({ text, index }),
    targetFor: () => ({ version: "2026", language: "en", keywords }),
    settings: { textCase: "upper" },
  };
}

test("signature help selects the real BDK EIGE form containing the named parameters", async () => {
  const firstRecord = "EIGE TYPE 1 NEIG ";
  const first = await signatureHelp(projectFor("BDK", firstRecord), "untitled:fixture", {
    line: 1,
    character: firstRecord.length,
  });
  assert.equal(first.activeSignature, 0);
  assert.equal(first.activeParameter, 1);
  const secondRecord = "EIGE BEAM 1 LC 2 TYPE ";
  const second = await signatureHelp(projectFor("BDK", secondRecord), "untitled:fixture", {
    line: 1,
    character: secondRecord.length,
  });
  assert.equal(second.signatures.length, 2);
  assert.equal(second.activeSignature, 1);
  assert.equal(second.activeParameter, 2);
});

test("completion distinguishes a named enum value from the next parameter", async () => {
  const valueRecord = "GRP NO 1 VAL ";
  const values = await completion(projectFor("ASE", valueRecord), "untitled:fixture", {
    line: 1,
    character: valueRecord.length,
  });
  assert.ok(values.some((item) => item.label === "FULL"));
  assert.ok(values.every((item) => item.kind === 20));
  const parameterRecord = "GRP NO 1 VAL FULL ";
  const parameters = await completion(projectFor("ASE", parameterRecord), "untitled:fixture", {
    line: 1,
    character: parameterRecord.length,
  });
  assert.ok(parameters.some((item) => item.label === "FACS"));
  assert.ok(parameters.every((item) => item.kind === 5));
});

test("parameter completion keeps canonical slot order and conveys it through sortText", async () => {
  const record = "GRP NO 1 VAL FULL ";
  const items = await completion(projectFor("ASE", record), "untitled:fixture", {
    line: 1,
    character: record.length,
  });
  const names = keywords
    .getCommandSchema("ASE", "GRP")
    .forms[0].slots.map((slot) => slot.name)
    .filter(Boolean);
  assert.deepEqual(
    items.map((item) => item.label),
    names,
  );
  assert.deepEqual(
    items.slice(0, 4).map((item) => item.sortText),
    ["000000", "000001", "000002", "000003"],
  );
  assert.deepEqual(
    [...items].sort((a, b) => a.sortText.localeCompare(b.sortText)).map((item) => item.label),
    names,
  );
});

test("fresh filtered completions preserve the same canonical rank as the unfiltered fields", async () => {
  const record = "GRP NO 1 F";
  const items = await completion(projectFor("ASE", record), "untitled:fixture", {
    line: 1,
    character: record.length,
  });
  assert.deepEqual(
    items.map((item) => item.label),
    ["FACS", "FACL", "FACD", "FACP", "FACT", "FACB"],
  );
  assert.equal(items[0].sortText, "000002");
  assert.equal(items.at(-1).sortText, "000028");
  const second = "GRP NO 1 PH";
  const ph = await completion(projectFor("ASE", second), "untitled:fixture", {
    line: 1,
    character: second.length,
  });
  assert.deepEqual(
    ph.map((item) => item.label),
    ["PHI", "PHIF", "PHIS"],
  );
  const value = "GRP NO 1 VAL F";
  const values = await completion(projectFor("ASE", value), "untitled:fixture", {
    line: 1,
    character: value.length,
  });
  assert.deepEqual(
    values.map((item) => item.label),
    ["FULL"],
  );
  assert.ok(values.every((item) => item.kind === 20));
});

test("compact parameter hover uses slash position and a complete naturally wrapping enum list", async () => {
  const project = projectFor("AQUA", "CONC NO 1 TYPE C");
  const result = await hover(project, "untitled:fixture", { line: 1, character: 12 });
  const values = keywords
    .getCommandSchema("AQUA", "CONC")
    .forms[0].slots.find((slot) => slot.name === "TYPE").enumValues;
  assert.equal(values.length, 69);
  assert.deepEqual(result.contents, {
    kind: "plaintext",
    value: `AQUA · CONC · TYPE /2\n\n${values.join(", ")}`,
  });
  assert.doesNotMatch(result.contents.value, /Slot|Catalogue type|2026|\bEN\b|…/);
  assert.ok(result.contents.value.endsWith("SSNI"));
});

test("hover stays quiet on vocabulary, whitespace, comments and unrelated prose", async () => {
  const record = "GRP NO 1 VAL FULL $ a comment";
  const project = projectFor("ASE", record);
  for (const position of [
    { line: 0, character: 7 },
    { line: 1, character: 1 },
    { line: 1, character: 3 },
    { line: 1, character: 12 },
    { line: 1, character: 22 },
  ])
    assert.equal(await hover(project, "untitled:fixture", position), null);
  assert.equal(
    await hover(projectFor("ASE", "HEAD 'GRP FULL'"), "untitled:fixture", {
      line: 1,
      character: 7,
    }),
    null,
  );
  const number = await hover(project, "untitled:fixture", { line: 1, character: 7 });
  assert.equal(number.contents.value, "ASE · GRP · NO /1");
});
