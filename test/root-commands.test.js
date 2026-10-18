"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { createIndex } = require("../lib/finder");
const { completion, hover, semanticTokens, signatureHelp } = require("../lib/features");
const { LintEngine } = require("../lib/lint-engine");
const { preprocess } = require("../lib/preprocessor");
const { filterDiagnostics } = require("../lib/lint-codes");

const uri = "file:///project/main.dat";
const target = { keywords: provider().forRelease("2026", "en") };

test("SYS variants preserve the entire physical shell tail and only index substitutions", () => {
  for (const command of ["SYS", "+sys", "-SYS", "*SyS"]) {
    const tail = 'del $(project).$d? ! #shell // ; LET#fake = missing ( $$ "$(tail)';
    const text = `+PROG TEMPLATE\n${command} ${tail}\nLET#a #missing\nEND\n`;
    const index = createIndex(text, target);
    const line = index.lines[1];
    assert.deepEqual(
      line.tokens.map((token) => token.type),
      ["word", "string"],
      command,
    );
    assert.equal(line.tokens[1].value, tail, command);
    assert.equal(line.records.length, 1, command);
    assert.equal(line.records[0].kind, "root", command);
    assert.equal(line.endState.continued, false, command);
    assert.deepEqual(
      line.occurrences.map((item) => [item.namespace, item.name]),
      [
        ["macro", "project"],
        ["macro", "tail"],
      ],
    );
    assert.deepEqual(index.diagnostics, [], command);
    const result = new LintEngine().analyze({ uri, text });
    assert.deepEqual(
      result.diagnostics.map((item) => item.code),
      ["variable-before-declaration"],
    );
    assert.equal(result.diagnostics[0].range.start.line, 2, command);
  }
});

test("SYS preprocessor substitutions continue after shell punctuation without executing a source", async () => {
  const tail = 'del $(project).$d? ! #shell // ; $$ "$(tail)';
  for (const command of ["SYS", "+sys", "-SYS", "*SYS"]) {
    const text = `#define tail=finished\n${command} ${tail}\n`;
    const result = await preprocess(
      { uri, text },
      { readSource: () => assert.fail("Root commands must never execute or load sources.") },
    );
    assert.equal(result.text, `${command} del main.$d? ! #shell // ; $$ "finished\n`);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.complete, true);
  }
});

test("SYS punctuation boundaries agree between raw indexing and preprocessing", async () => {
  for (const separator of [";", "!"]) {
    const text = `+SYS${separator}echo $(project).$d? $(project)\n`;
    const index = createIndex(text, target);
    assert.equal(index.lines[0].tokens[1].value, `${separator}echo $(project).$d? $(project)`);
    const result = await preprocess({ uri, text });
    assert.equal(result.text, `+SYS${separator}echo main.$d? main\n`);
    assert.deepEqual(result.diagnostics, []);
  }
  for (const prefix of ["SYS-X", "SYS.EXE"]) {
    assert.notEqual(createIndex(`${prefix} text\n`, target).lines[0].records[0].kind, "root");
  }
});

test("APPLY filenames are opaque while comments, semicolons and continuations keep their meaning", () => {
  for (const command of ["APPLY", "+APPLY", "-APPLY", "$APPLY"]) {
    for (const comment of ["$", "!", "//"]) {
      const text = `${command} C:\\generated\\#part_$(NAME).dat ${comment} #ignored $(ignored)\n`;
      const index = createIndex(text, target);
      assert.deepEqual(
        index.lines[0].tokens.map((token) => token.type),
        ["word", "string", "comment"],
      );
      assert.equal(index.lines[0].records[0].kind, "root");
      assert.deepEqual(
        index.occurrences.map((item) => [item.namespace, item.name]),
        [["macro", "NAME"]],
      );
      assert.deepEqual(index.diagnostics, []);
    }
  }
  const text = "+APPLY generated_ $$\n  #part.dat ; +PROG TEMPLATE\nLET#a #missing\nEND\n";
  const index = createIndex(text, target);
  assert.equal(index.lines[0].records[0].continued, true);
  assert.equal(index.lines[1].records[0].kind, "root");
  assert.equal(index.lines[1].records[1].kind, "program");
  assert.equal(index.lines[1].tokens[0].type, "string");
  assert.equal(index.lines[1].tokens[0].value.trim(), "#part.dat");
  assert.deepEqual(index.lines[1].occurrences, []);
});

test("APPLY quoted filenames protect delimiters and retain unterminated-quote diagnostics", () => {
  for (const quote of ["'", '"', "''", '""']) {
    const text = `+APPLY ${quote}#part ; ! // $ $(NAME).dat${quote} $ ignored\n`;
    const index = createIndex(text, target);
    assert.deepEqual(
      index.lines[0].tokens.map((token) => token.type),
      ["word", "string", "comment"],
    );
    assert.deepEqual(index.diagnostics, []);
    assert.equal(index.occurrences[0].name, "NAME");
  }
  const index = createIndex('+APPLY "unfinished.dat\n', target);
  assert.deepEqual(
    index.diagnostics.map((item) => item.code),
    ["unterminated-string"],
  );
});

test("root arguments suppress CADINP features while macro lookup stays available", async () => {
  for (const record of [
    "+SYS ",
    "*SYS del $(file).$d? #shell ",
    "+APPLY ",
    "+APPLY #part_$(file).dat ",
  ]) {
    const text = `#define file=generated\n${record}\n`;
    const index = createIndex(text, target);
    const project = {
      loadDocument: async () => ({ text, index, target }),
      settings: { textCase: "upper" },
      visibleSymbols: async () => index.symbols(),
    };
    const position = { line: 1, character: record.length };
    assert.deepEqual(await completion(project, uri, position), [], record);
    assert.equal(await hover(project, uri, position), null, record);
    assert.equal(await signatureHelp(project, uri, position), null, record);
    assert.deepEqual(semanticTokens({ index }), { data: [] }, record);
    if (record.includes("$(file)")) {
      const macroPosition = { line: 1, character: record.indexOf("$(file)") + 5 };
      assert.equal(index.contextAt(macroPosition).role, "macro", record);
      assert.equal(index.definitionsAt(macroPosition)[0].name, "file", record);
      assert.deepEqual(
        (await completion(project, uri, macroPosition)).map((item) => item.label),
        ["FILE"],
      );
    }
  }
});

test("SYS shell text cannot act as a NOQA suppression", async () => {
  const text = '+SYS echo "$(missing)" ! noqa: G004\n';
  const expanded = await preprocess({ uri, text });
  const diagnostics = filterDiagnostics(expanded.diagnostics, {
    uri,
    sources: new Map([[uri, text]]),
  });
  assert.deepEqual(
    diagnostics.map((item) => item.code),
    ["G004"],
  );
});

test("unfinished root substitutions retain macro completion without invented references", async () => {
  for (const record of ["+SYS echo $(fi", "+APPLY $(fi", '+APPLY "$(fi"']) {
    const text = `#define file=generated\n${record}\n`;
    const index = createIndex(text, target);
    const project = {
      loadDocument: async () => ({ text, index, target }),
      settings: { textCase: "upper" },
      visibleSymbols: async () => index.symbols(),
    };
    const character = record.indexOf("$(fi") + 4;
    const position = { line: 1, character };
    const context = index.contextAt(position);
    assert.equal(context.role, "macro", record);
    assert.equal(context.prefix, "fi", record);
    assert.deepEqual(
      (await completion(project, uri, position)).map((item) => item.label),
      ["FILE"],
    );
    assert.deepEqual(index.lines[1].occurrences, [], record);
  }
});
