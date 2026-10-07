const assert = require("node:assert/strict");
const test = require("node:test");
const { SofistikDataProvider } = require("@lumine-code/sofistik-data");
const corpus = require("@lumine-code/sofistik-data/fixtures/cadinp-structure.json");
const { createIndex, createNavigationIndex } = require("../lib/finder");
const { documentStructure } = require("../lib/structure");

function selections(index) {
  const result = { programs: [], commands: [] };
  const visit = (symbols) => {
    for (const symbol of symbols) {
      if (["module", "command"].includes(symbol.kind))
        result[symbol.kind === "module" ? "programs" : "commands"].push({
          name: symbol.name,
          ...symbol.selectionRange.start,
        });
      if (symbol.children) visit(symbol.children);
    }
  };
  visit(documentStructure({ index }));
  return result;
}

for (const fixture of corpus.cases) {
  test(`shared CADINP structure: ${fixture.name}`, () => {
    const keywords = new SofistikDataProvider().forRelease(corpus.version, corpus.language);
    const expected = { programs: fixture.programs, commands: fixture.commands };
    const index = createIndex(fixture.source, { keywords });
    assert.deepEqual(selections(index), expected);
    assert.deepEqual(selections(createNavigationIndex(fixture.source, { keywords })), expected);
    const first = fixture.commands[0];
    if (first) {
      index.applyChanges(
        [
          {
            range: {
              start: { line: first.line, character: first.character },
              end: { line: first.line, character: first.character + first.name.length },
            },
            text: first.name.toLowerCase(),
          },
        ],
        2,
      );
      assert.deepEqual(
        selections(index),
        expected,
        "incremental command casing preserves structure",
      );
    }
  });
}
