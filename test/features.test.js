const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const { createIndex } = require("../lib/finder");
const { signatureHelp, completion } = require("../lib/features");

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
