"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikSchemaProvider } = require("@lumine-code/sofistik-schema");
const { SchemaResolver } = require("../lib/schema-resolver");
const { createIndex } = require("../lib/finder");
const { completion, hover, signatureHelp } = require("../lib/features");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const registry = require("../lib/err-rules.json");

const provider = new SofistikSchemaProvider();
const uri = "file:///english-directory/german-input.dat";
const targetFor = (language = "en", version = "2026") => ({
  version,
  language,
  keywords: provider.forRelease(version, language),
});

function projectFor(text, language = "en") {
  const target = targetFor(language);
  const index = createIndex(text, target);
  return {
    index,
    settings: { textCase: "upper" },
    loadDocument: async () => ({ text, index, target }),
  };
}

async function analyze(text, language = "en", engine = new LintEngine(), version = "2026") {
  const expanded = await preprocess({ uri, text });
  return engine.analyze({ ...expanded, uri, ...targetFor(language, version) });
}

test("HEAD and KOPF select per-program language without making foreign commands universal aliases", () => {
  const resolver = new SchemaResolver(targetFor().keywords);
  assert.ok(resolver.lookup("SOFILOAD", "LF", "de"));
  assert.equal(resolver.lookup("SOFILOAD", "LF", "en"), null);
  assert.ok(resolver.lookup("SOFILOAD", "LC", "en"));
  assert.equal(resolver.lookup("SOFILOAD", "LC", "de"), null);
  const text =
    "+PROG SOFILOAD\nKOPF Deutsch\nLF 21\nENDE\n+PROG SOFILOAD\nHEAD English\nLC 22\nEND\n";
  const index = projectFor(text).index;
  assert.equal(index.contextAt({ line: 2, character: 2 }).command, "LF");
  assert.equal(index.contextAt({ line: 2, character: 2 }).language, "de");
  assert.equal(index.contextAt({ line: 6, character: 2 }).command, "LC");
  assert.equal(index.contextAt({ line: 6, character: 2 }).language, "en");
});

test("a LET before KOPF remains valid, while a later foreign header cannot change the input language", () => {
  const text = "+PROG SOFILOAD\nLET#probe 1\nKOPF Deutsch\nLF 21\nHEAD Later text\nLF 22\nENDE\n";
  const index = projectFor(text).index;
  assert.equal(index.contextAt({ line: 3, character: 2 }).language, "de");
  assert.equal(index.contextAt({ line: 5, character: 2 }).language, "de");
  assert.equal(index.contextAt({ line: 5, character: 2 }).command, "LF");
  for (const control of ["IF 1", "LOOP 1"]) {
    const controlled = projectFor(`+PROG SOFILOAD\n${control}\nKOPF Deutsch\nLF 21\n`).index;
    assert.equal(controlled.contextAt({ line: 3, character: 2 }).command, "LF");
    assert.equal(controlled.contextAt({ line: 3, character: 2 }).language, "de");
  }
});

test("a program without an explicit language header keeps the configured default after PROG", () => {
  const text = "+PROG SOFILOAD\nKOPF Deutsch\nLF 21\nENDE\n+PROG SOFILOAD\nLC 22\nEND\n";
  const index = projectFor(text).index;
  assert.equal(index.contextAt({ line: 5, character: 2 }).language, "en");
  assert.equal(index.contextAt({ line: 5, character: 2 }).command, "LC");
});

test("German inputs in an English project expose the matching fields, hover, signature and enum tokens", async () => {
  const text = "+PROG SOFILOAD\nKOPF Deutsch\nLF 21 \nQUAD GRP 1 TYP PZZ 30.0\nENDE\n";
  const project = projectFor(text);
  const fields = await completion(project, uri, { line: 2, character: 6 });
  assert.ok(fields.some(({ label }) => label === "TYP"));
  assert.equal(
    fields.some(({ label }) => label === "TYPE"),
    false,
  );
  const signature = await signatureHelp(project, uri, { line: 2, character: 6 });
  assert.match(signature.signatures[0].label, /^LF NR TYP /);
  const info = await hover(project, uri, { line: 3, character: 13 });
  assert.match(info.contents.value, /SOFILOAD · QUAD · TYP/);
  assert.ok(
    project.index.enumTokens().some(({ value, param }) => value === "PZZ" && param === "TYP"),
  );
  const commands = await completion(projectFor("+PROG SOFILOAD\nKOPF Deutsch\n\n"), uri, {
    line: 2,
    character: 0,
  });
  assert.ok(commands.some(({ label }) => label === "LF"));
  assert.equal(
    commands.some(({ label }) => label === "LC"),
    false,
  );
});

test("language cues apply context and ERR rules using their native command and parameter bindings", async () => {
  for (const version of registry.releases) {
    const valid = await analyze(
      "+PROG SOFILOAD\nKOPF\nLF 21; QUAD GRP 1 TYP PZZ 30.0\nENDE\n",
      "en",
      undefined,
      version,
    );
    assert.equal(
      valid.diagnostics.some(({ code }) => code === "load-without-load-case"),
      false,
    );
    const invalid = await analyze(
      "+PROG SOFILOAD\nKOPF\nQUAD GRP 1 TYP PZZ 30.0\nENDE\n",
      "en",
      undefined,
      version,
    );
    assert.ok(invalid.diagnostics.some(({ code }) => code === "load-without-load-case"));
    const grouped = await analyze(
      "+PROG SOFIMSHC\nKOPF\nSYST SPAC GDIV 1000\nGRUP NR 1 BASE 100\nENDE\n",
      "en",
      undefined,
      version,
    );
    assert.ok(grouped.diagnostics.some(({ code }) => code === "sofimshc-grp-base-gdiv"));
  }
});

test("changing a language header invalidates incremental lexer and linter context without changing later programs", async () => {
  const before =
    "+PROG SOFILOAD\nHEAD\nLF 21\nQUAD GRP 1 TYP PZZ 30.0\nENDE\n+PROG SOFILOAD\nHEAD\nLC 22\nEND\n";
  const after = before.replace("HEAD", "KOPF");
  const target = targetFor();
  const index = createIndex(before, target);
  index.applyChanges([
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, text: "KOPF" },
  ]);
  const fresh = createIndex(after, target);
  for (const line of [2, 3, 7]) {
    assert.deepEqual(
      index.contextAt({ line, character: 2 }),
      fresh.contextAt({ line, character: 2 }),
    );
  }
  const engine = new LintEngine();
  await analyze(before, "en", engine);
  const changed = await analyze(after, "en", engine);
  const cold = await analyze(after);
  assert.deepEqual(changed.diagnostics, cold.diagnostics);
  assert.ok(changed.metrics.reusedLexicalModules >= 1);
  assert.ok(changed.metrics.reusedModules >= 1);
});
