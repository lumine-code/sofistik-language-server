const assert = require("node:assert/strict");
const test = require("node:test");
const { preprocess } = require("../lib/preprocessor");
const { mappedLocation } = require("../lib/source-map");

const URI = "file:///project/main.dat";
const location = (uri, line, start, end) => ({
  uri,
  range: { start: { line, character: start }, end: { line, character: end } },
});
const entry = (text) => ({ uri: URI, text });
function mapped(result, text, occurrence = 0) {
  let start = -1;
  for (let index = 0; index <= occurrence; index++) start = result.text.indexOf(text, start + 1);
  assert.notEqual(start, -1, `Missing expanded text ${text}`);
  return mappedLocation(result.segments, start, start + text.length);
}

test("copied LF and normalized CRLF content retains exact columns", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const result = await preprocess(
      entry(`+PROG ASE${newline}LET#x #missing${newline}END${newline}`),
    );
    assert.deepEqual(mapped(result, "#missing"), location(URI, 1, 6, 14));
    assert.equal(result.text, "+PROG ASE\nLET#x #missing\nEND\n");
    assert.equal(result.segments[1].contentEnd, result.segments[1].end - 1);
    assert.equal(result.segments[1].affine, true);
    assert.equal(result.segments[1].pieces, undefined);
  }
});

test("affine mappings also work at source EOF and synthetic include newlines", async () => {
  const direct = await preprocess(entry("LET#x #bad"));
  assert.deepEqual(mapped(direct, "#bad"), location(URI, 0, 6, 10));
  const included = await preprocess(entry("#include part.dat\n"), {
    readSource: async (uri) => ({ uri, text: "LET#x #bad" }),
  });
  const result = mapped(included, "#bad");
  assert.deepEqual(
    { uri: result.uri, range: result.range },
    location("file:///project/part.dat", 0, 6, 10),
  );
  assert.equal(result.blockInvocation, undefined);
  assert.equal(result.invocation.uri, URI);
});

test("composite command names union copied and substituted source fragments", async () => {
  const result = await preprocess(entry("#define test=mb\nco$(test) NO 1\n"));
  const command = mapped(result, "comb");
  assert.deepEqual({ uri: command.uri, range: command.range }, location(URI, 1, 0, 9));
  assert.deepEqual(command.definitions, [location(URI, 0, 13, 15)]);
  assert.deepEqual(mapped(result, "co"), location(URI, 1, 0, 2));
  const replacement = mapped(result, "mb");
  assert.deepEqual(replacement.range, location(URI, 1, 2, 9).range);
  assert.deepEqual(mapped(result, "NO"), location(URI, 1, 10, 12));
});

test("scalar RHS origins survive deferred lookups, nested names and redefinition", async () => {
  const result = await preprocess(
    entry(
      "#define X=old\n#define VALUE=$(X)\n#define INDEX=1\n#define A1=$(VALUE)\n" +
        "#define X=new\nTXA $(A$(INDEX))\n",
    ),
  );
  const selected = mapped(result, "new");
  assert.deepEqual(selected.range, location(URI, 5, 4, 16).range);
  assert.deepEqual(selected.definitions, [
    location(URI, 2, 14, 15),
    location(URI, 3, 11, 19),
    location(URI, 1, 14, 18),
    location(URI, 4, 10, 13),
  ]);
  assert.ok(selected.definitions.every((item) => item.range.start.line !== 0));
});

test("exact RHS locations exclude directive indentation, spaces and comments", async () => {
  const result = await preprocess(entry("  #DEFINE value = #missing $ note\r\nLET#x $(value)\r\n"));
  const issue = mapped(result, "#missing");
  assert.deepEqual(issue.range, location(URI, 1, 6, 14).range);
  assert.deepEqual(issue.definitions, [location(URI, 0, 18, 26)]);
});

test("each reusable block has its own invocation while preserving precise body ranges", async () => {
  const result = await preprocess(
    entry(
      "#define block\nPROG ASE\nLET#x #missing\nEND\n#enddef\n#include block\n#include block\n",
    ),
  );
  const first = mapped(result, "#missing");
  const second = mapped(result, "#missing", 1);
  assert.deepEqual(first.range, location(URI, 2, 6, 14).range);
  assert.deepEqual(second.range, first.range);
  assert.equal(first.blockInvocation.range.start.line, 5);
  assert.equal(second.blockInvocation.range.start.line, 6);
  assert.equal(first.invocation.range.start.line, 5);
  assert.equal(second.invocation.range.start.line, 6);
});

test("ordinary repeated file includes map to their source without a block invocation", async () => {
  const result = await preprocess(entry("#include part.dat\n#include part.dat\n"), {
    readSource: async (uri) => ({ uri, text: "LET#x #missing\r\n" }),
  });
  const first = mapped(result, "#missing");
  const second = mapped(result, "#missing", 1);
  assert.equal(first.uri, "file:///project/part.dat");
  assert.deepEqual(first.range, location(first.uri, 0, 6, 14).range);
  assert.deepEqual(second.range, first.range);
  assert.equal(first.blockInvocation, undefined);
  assert.equal(first.invocation.range.start.line, 0);
  assert.equal(second.invocation.range.start.line, 1);
});

test("outermost executable block invocation is distinct from its enclosing file include", async () => {
  const result = await preprocess(entry("#include part.dat\n"), {
    readSource: async (uri) => ({
      uri,
      text: "#define inner\nLET#x #missing\n#enddef\n#define outer\nPROG ASE\n#include inner\nEND\n#enddef\n#include outer\n",
    }),
  });
  const issue = mapped(result, "#missing");
  assert.equal(issue.uri, "file:///project/part.dat");
  assert.deepEqual(issue.range, location(issue.uri, 1, 6, 14).range);
  assert.equal(issue.invocation.uri, URI);
  assert.equal(issue.blockInvocation.uri, issue.uri);
  assert.equal(issue.blockInvocation.range.start.line, 8);
});

test("UTF-16 columns count surrogate pairs without using UTF-8 byte offsets", async () => {
  const result = await preprocess(entry("#define value=🌞\nTXA 'ą🌞$(value)'\r\n"));
  const first = mapped(result, "ą🌞");
  assert.deepEqual(first.range, location(URI, 1, 5, 8).range);
  const replacement = mapped(result, "🌞", 1);
  assert.deepEqual(replacement.range, location(URI, 1, 8, 16).range);
  assert.deepEqual(replacement.definitions, [location(URI, 0, 14, 16)]);
});

test("empty substitutions remain mapped at collapsed token boundaries", async () => {
  const result = await preprocess(entry("#define empty=\nco$(empty)\n"));
  const issue = mapped(result, "co");
  assert.deepEqual(issue.range, location(URI, 1, 0, 10).range);
  assert.deepEqual(issue.definitions, [location(URI, 0, 14, 14)]);
});

test("copied text after a changed token and comments keeps affine mapping", async () => {
  const result = await preprocess(entry("#define value=10000\nLET#x $(value) ! comment\n"));
  assert.deepEqual(mapped(result, "comment"), location(URI, 1, 17, 24));
});

test("definition locations are deduplicated across multiple overlapping substitutions", async () => {
  const result = await preprocess(entry("#define value=ab\nTXA $(value)$(value)\n"));
  const issue = mapped(result, "abab");
  assert.equal(issue.definitions.length, 1);
  assert.deepEqual(issue.range, location(URI, 1, 4, 20).range);
});

test("legacy mappings remain conservative and missing segments use the supplied fallback", () => {
  const original = location(URI, 4, 0, 8);
  assert.deepEqual(mappedLocation([{ start: 0, end: 9, origin: original }], 2, 5), original);
  assert.deepEqual(
    mappedLocation([{ start: 0, end: 8, origin: original }], 2, 5),
    location(URI, 4, 2, 5),
  );
  const fallback = location(URI, 9, 0, 0);
  assert.equal(mappedLocation([], 4, 6, fallback), fallback);
  assert.deepEqual(
    mappedLocation([], 4, 6, (start, end) => ({ start, end })),
    { start: 4, end: 6 },
  );
});

test("a span crossing different source files retains additional original fragments", () => {
  const result = mappedLocation(
    [
      { start: 0, end: 2, origin: location(URI, 0, 0, 2), affine: true },
      { start: 2, end: 4, origin: location("file:///project/part.dat", 1, 0, 2), affine: true },
    ],
    0,
    4,
  );
  assert.equal(result.uri, URI);
  assert.equal(result.origins.length, 2);
  assert.deepEqual(result.range, location(URI, 0, 0, 2).range);
});

test("noncontiguous fragments in one source keep their actual touched lines", () => {
  const first = location(URI, 2, 5, 8);
  const last = location(URI, 90, 1, 4);
  const result = mappedLocation(
    [
      { start: 0, end: 3, origin: first, affine: true },
      { start: 3, end: 6, origin: last, affine: true },
    ],
    0,
    6,
  );
  assert.deepEqual(result.origins, [first, last]);
  assert.deepEqual(result.range, {
    start: { line: 2, character: 5 },
    end: { line: 90, character: 4 },
  });
  const selected = mappedLocation(
    [
      { start: 0, end: 3, origin: first, affine: true },
      { start: 3, end: 6, origin: last, affine: true },
    ],
    1,
    5,
  );
  assert.deepEqual(selected.origins, [location(URI, 2, 6, 8), location(URI, 90, 1, 3)]);
});

test("substitution errors highlight exact use sites and show lazy RHS references separately", async () => {
  const direct = await preprocess(entry("TXA $(missing)\n"));
  assert.deepEqual(direct.diagnostics[0].range, location(URI, 0, 4, 14).range);
  const lazy = await preprocess(entry("#define outer=$(missing)\nTXA $(outer)\n"));
  assert.deepEqual(lazy.diagnostics[0].range, location(URI, 1, 4, 12).range);
  assert.deepEqual(lazy.diagnostics[0].data.recordOrigin.range, lazy.diagnostics[0].range);
  assert.deepEqual(lazy.diagnostics[0].relatedInformation[0].location, location(URI, 0, 14, 24));
  const recursive = await preprocess(entry("#define value=$(value)\nTXA $(value)\n"));
  assert.deepEqual(recursive.diagnostics[0].range, location(URI, 1, 4, 12).range);
  const unclosed = await preprocess(entry("TXA $(missing\n"));
  assert.deepEqual(unclosed.diagnostics[0].range, location(URI, 0, 4, 13).range);
});

test("file substitution errors use the source URI, while block errors use the invocation", async () => {
  const included = await preprocess(entry("#include part.dat\n"), {
    readSource: async (uri) => ({ uri, text: "TXA $(missing)\n" }),
  });
  assert.equal(included.diagnostics[0].uri, "file:///project/part.dat");
  assert.deepEqual(
    included.diagnostics[0].range,
    location("file:///project/part.dat", 0, 4, 14).range,
  );
  const block = await preprocess(entry("#define block\nTXA $(missing)\n#enddef\n#include block\n"));
  assert.deepEqual(block.diagnostics[0].range, location(URI, 3, 0, 14).range);
  assert.deepEqual(block.diagnostics[0].relatedInformation[0].location, location(URI, 1, 4, 14));
});

test("mapping work limits terminate fragmented expansion with a diagnostic", async () => {
  const result = await preprocess(entry("#define value=1\nTXA $(value) $(value) $(value)\n"), {
    maxMappingPieces: 2,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.diagnostics.map((issue) => issue.code),
    ["expansion-limit"],
  );
  assert.equal(result.text, "");
});

test("scalar includes use an executable invocation and retain RHS origins", async () => {
  const result = await preprocess(entry("#define command=LET#x #bad\n#include command\n"));
  const issue = mapped(result, "#bad");
  assert.deepEqual(issue.range, location(URI, 1, 9, 16).range);
  assert.deepEqual(issue.definitions, [location(URI, 0, 16, 26)]);
  assert.equal(issue.blockInvocation.range.start.line, 1);
  const invalid = await preprocess(entry("#define command=$(missing)\n#include command\n"));
  assert.deepEqual(invalid.diagnostics[0].range, location(URI, 1, 0, 16).range);
  assert.equal(invalid.diagnostics[0].data.blockInvocation.range.start.line, 1);
});

test("generated definitions retain their generator lineage without inventing columns", async () => {
  const result = await preprocess(
    entry("#define generator=#define value=#bad\n$(generator)\nLET#x $(value)\n"),
  );
  const issue = mapped(result, "#bad");
  assert.deepEqual(issue.range, location(URI, 2, 6, 14).range);
  assert.deepEqual(issue.definitions, [location(URI, 1, 0, 12), location(URI, 0, 18, 36)]);
});

test("external define origins add DEF RHS links while preserving use-site ranges", async () => {
  const external = location("file:///project/sofistik.def", 3, 7, 15);
  for (const defineOrigins of [{ value: external }, new Map([["VaLuE", external]])]) {
    const result = await preprocess(entry("LET#x $(VALUE)\nTXA $(NAME) $(PROJECT)\n"), {
      defines: { Value: "#missing" },
      defineOrigins,
    });
    const issue = mapped(result, "#missing");
    assert.deepEqual(issue.range, location(URI, 0, 6, 14).range);
    assert.deepEqual(issue.definitions, [external]);
    const builtin = mapped(result, "main");
    assert.equal(builtin.definitions, undefined);
  }
});
