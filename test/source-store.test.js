const assert = require("node:assert/strict");
const test = require("node:test");
const { provider } = require("@lumine-code/sofistik-schema");
const { SourceStore } = require("../lib/source-store");
const { createIndex, applyTextChanges } = require("../lib/finder");

test("source edits apply ordered ranges once and keep the incremental index", (t) => {
  const target = {
    version: "2026",
    language: "en",
    keywords: provider().forRelease("2026", "en"),
  };
  const store = new SourceStore({ targetFor: () => target, invalidate: () => {} });
  t.after(() => store.dispose());
  const uri = "untitled:source-store";
  const text =
    "+PROG SOFIMSHA\n" +
    Array.from({ length: 120 }, (_, index) => `NODE ${index + 1} X 0 Y 0`).join("\n") +
    "\nEND\n";
  const document = store.open({ uri, text, version: 1 });
  const index = document.index;
  const updates = [
    {
      range: { start: { line: 70, character: 0 }, end: { line: 70, character: 0 } },
      text: "$ comment\n",
    },
    {
      range: { start: { line: 71, character: 10 }, end: { line: 71, character: 11 } },
      text: "ą😀",
    },
  ];
  let reads = 0;
  const changes = updates.map((update) => ({
    range: update.range,
    get text() {
      reads++;
      return update.text;
    },
  }));

  store.change(uri, changes, 2);

  assert.equal(reads, updates.length, "each edit is applied once before indexing");
  assert.equal(document.index, index);
  assert.equal(document.version, 2);
  assert.equal(index.documentVersion, 2);
  assert.equal(document.text, applyTextChanges(text, updates));
  assert.equal(index.metrics.updateCount, 1);
  assert.ok(index.metrics.scannedLines < 5);
  assert.ok(index.metrics.reusedLines > 115);
  const fresh = createIndex(document.text, target);
  assert.deepEqual(index.diagnostics, fresh.diagnostics);
  assert.deepEqual(index.occurrences, fresh.occurrences);
  assert.deepEqual(
    index.contextAt({ line: 110, character: 12 }),
    fresh.contextAt({ line: 110, character: 12 }),
  );
});
