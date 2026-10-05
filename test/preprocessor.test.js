const assert = require("node:assert/strict");
const test = require("node:test");
const { preprocess } = require("../lib/preprocessor");

const URI = "file:///project/main.dat";
const entry = (text) => ({ uri: URI, text });
const codes = (result) => result.diagnostics.map((diagnostic) => diagnostic.code);

test("substitutions join tokens, defer values and nested names, and ignore name case", async () => {
  const result = await preprocess(
    entry(
      "#define command=$(suffix)\n#define A1=first\n#define INDEX=1\n#define SUFFIX=mb\n" +
        "+PROG MAXIMA\nco$(command) 1 TITL '$(A$(index))'\n#define suffix=nc\nco$(Command) 2\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG MAXIMA\ncomb 1 TITL 'first'\nconc 2\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.segments[1].origin.range.start.line, 5);
});

test("scalar definitions inside repeated block inclusions flow back to the parent", async () => {
  const result = await preprocess(
    entry(
      "#define block\nPROG $(module)\n#define selected=$(module)\nHEAD $(title)\nEND\n#enddef\n" +
        "#define module=AQUA\n#define title=one\n#include block\n#define module=ASE\n#define title=two\n" +
        "#include BLOCK\nTXA $(selected)\n",
    ),
  );
  assert.equal(result.text, "PROG AQUA\nHEAD one\nEND\nPROG ASE\nHEAD two\nEND\nTXA ASE\n");
  assert.deepEqual(result.segments[0].origin.range.start, { line: 1, character: 0 });
  assert.deepEqual(result.segments[0].invocation.range.start, { line: 8, character: 0 });
  assert.equal(result.segments[3].invocation.range.start.line, 11);
});

test("nested block definitions stay deferred until invocation", async () => {
  const result = await preprocess(
    entry(
      "#define outer\n#define inner\nPROG $(module)\nEND\n#enddef\n#include inner\n#enddef\n" +
        "#define module=ASE\n#include outer\n",
    ),
  );
  assert.equal(result.text, "PROG ASE\nEND\n");
  assert.equal(result.segments[0].origin.range.start.line, 2);
  assert.equal(result.segments[0].invocation.range.start.line, 8);
});

test("file inclusions are repeated in environment order, cached only as sources, and line separated", async () => {
  const reads = [];
  const result = await preprocess(
    entry(
      "#define source=part.dat\n#define module=AQUA\n#include '$(source)'\n" +
        "#define module=ASE\n#include part.dat\nTXA $(last)\n",
    ),
    {
      readSource: async (uri) => {
        reads.push(uri);
        return { uri, text: "PROG $(module)\n#define last=$(module)\n#include nested.dat\nEND" };
      },
    },
  );
  // The same resolver returns recursive content for nested.dat; the depth limit
  // must stop it without preventing analysis of the caller's remaining input.
  assert.ok(codes(result).includes("include-depth"));
  assert.deepEqual(reads, ["file:///project/part.dat", "file:///project/nested.dat"]);
  assert.ok(result.text.includes("END\nPROG ASE\n"));
  assert.ok(result.text.endsWith("END\nTXA ASE\n"));
});

test("file includes preserve original positions and outermost root invocation", async () => {
  const source = {
    "file:///project/sub/part.dat": "#include ../leaf.dat\n#define result=good",
    "file:///project/leaf.dat": "PROG AQUA\nEND",
  };
  const result = await preprocess(entry("#include 'sub\\part.dat'\nTXA $(result)\n"), {
    readSource: async (uri) => (source[uri] === undefined ? null : { uri, text: source[uri] }),
  });
  assert.equal(result.text, "PROG AQUA\nEND\nTXA good\n");
  assert.equal(result.segments[0].origin.uri, "file:///project/leaf.dat");
  assert.equal(result.segments[0].invocation.uri, URI);
  assert.equal(result.segments[0].invocation.range.start.line, 0);
  assert.deepEqual(result.dependencies, [
    URI,
    "file:///project/sub/part.dat",
    "file:///project/leaf.dat",
  ]);
});

test("active and nested conditional branches ignore definitions in inactive input", async () => {
  const result = await preprocess(
    entry(
      "#define enabled=1\n#if disabled\n#define bad\nPROG INVALID\n#enddef\n#define name=wrong\n" +
        "#elseif enabled\n#define name=AQUA\n#if name\nPROG $(name)\n#else\nPROG INVALID\n#endif\n" +
        "#else\nPROG INVALID\n#endif\nEND\n#undef enabled\n#if enabled\nPROG INVALID\n#endif\n",
    ),
  );
  assert.equal(result.text, "PROG AQUA\nEND\n");
  assert.equal(result.complete, true);
  assert.equal(result.segments[0].origin.range.start.line, 9);
  assert.equal(result.segments[0].invocation, undefined);
});

test("SPS comparisons align numeric strings and retain lexical decimal ordering", async () => {
  const cases = [
    ["10.0 > 12", true],
    ["3 < 10", true],
    ["10 < 18", true],
    ["AA < BA", true],
    ["'A=B' == 'A=B'", true],
    ["'A' < > 'B'", true],
    ["1 != 2", true],
    ["0", false],
    ["0.0", false],
    ["absent", false],
  ];
  for (const [condition, yes] of cases) {
    const result = await preprocess(entry(`#if ${condition}\nyes\n#else\nno\n#endif\n`));
    assert.equal(result.text, yes ? "yes\n" : "no\n", condition);
    assert.deepEqual(result.diagnostics, [], condition);
  }
});

test("external parameters and NAME/PROJECT defaults remain redefinable", async () => {
  const result = await preprocess(
    entry("TXA $(NAME) $(PROJECT) $(MODE)\n#define mode=local\nTXA $(mode)\n"),
    {
      defines: new Map([
        ["mode", "initial"],
        ["PROJECT", "configured"],
      ]),
    },
  );
  assert.equal(result.text, "TXA main configured initial\nTXA local\n");
});

test("unresolved include produces a root diagnostic and a position-specific uncertainty", async () => {
  const result = await preprocess(entry("PROG AQUA\nEND\n#include child.dat\nPROG ASE\nEND\n"), {
    readSource: async (uri) =>
      uri.endsWith("child.dat") ? { uri, text: "#include missing.dat\n" } : null,
  });
  assert.equal(result.text, "PROG AQUA\nEND\nPROG ASE\nEND\n");
  assert.equal(result.complete, false);
  assert.deepEqual(result.uncertainties, [{ start: 14, end: 14, kind: "include" }]);
  assert.equal(result.diagnostics[0].uri, URI);
  assert.equal(result.diagnostics[0].range.start.line, 2);
  assert.equal(
    result.diagnostics[0].relatedInformation[0].location.uri,
    "file:///project/child.dat",
  );
  assert.ok(result.dependencies.includes("file:///project/missing.dat"));
});

test("recursive and incomplete substitutions are bounded and cannot invent a command", async () => {
  const result = await preprocess(
    entry("#define a=$(b)\n#define b=$(a)\nPROG AQUA\nco$(a) 1\nTXA $(missing\nEND\n"),
  );
  assert.deepEqual(codes(result), ["recursive-macro", "unclosed-substitution"]);
  assert.equal(result.complete, false);
  assert.ok(result.text.includes("co$(a) 1"));
  assert.equal(result.uncertainties.filter((item) => item.kind === "macro").length, 2);
});

test("unknown conditional skips both branches and reports uncertainty instead of guessing", async () => {
  const result = await preprocess(entry("#if $(missing)==1\nPROG AQUA\n#else\nPROG ASE\n#endif\n"));
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
  assert.deepEqual(result.uncertainties, [{ start: 0, end: 0, kind: "conditional" }]);
  assert.deepEqual(codes(result), ["undefined-macro"]);
});

test("malformed structure reports directives without leaking inactive code", async () => {
  const result = await preprocess(entry("#else\n#if missing\n#define unfinished\nPROG AQUA\n"));
  assert.deepEqual(codes(result), [
    "unmatched-conditional",
    "unclosed-definition",
    "unclosed-conditional",
  ]);
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
});

test("SYS/APPLY are retained and never executed; APPLY marks downstream state unknown", async () => {
  let reads = 0;
  const result = await preprocess(
    entry("SYS del important.dat\n+APPLY 'generated.dat'\n-APPLY 'disabled.dat'\n"),
    {
      readSource: async () => {
        reads++;
        return null;
      },
    },
  );
  assert.equal(reads, 0);
  assert.equal(
    result.text,
    "SYS del important.dat\n+APPLY 'generated.dat'\n-APPLY 'disabled.dat'\n",
  );
  assert.equal(result.uncertainties.length, 1);
  assert.equal(result.uncertainties[0].kind, "apply");
});

test("output/work limits stop exponential expansion and cancellation aborts promptly", async () => {
  const input = entry("#define a=1234567890\nTXA $(a)$(a)$(a)\nPROG ASE\nEND\n");
  const result = await preprocess(input, { maxBytes: 20 });
  assert.equal(result.complete, false);
  assert.deepEqual(codes(result), ["expansion-limit"]);
  assert.equal(result.text, "");
  const limited = await preprocess(entry("PROG AQUA\nEND\nPROG ASE\nEND\n"), { maxOperations: 2 });
  assert.equal(limited.text, "PROG AQUA\nEND\n");
  assert.ok(codes(limited).includes("expansion-limit"));
  let checks = 0;
  await assert.rejects(preprocess(entry("PROG AQUA\nEND\n"), { isCancelled: () => ++checks > 1 }), {
    name: "AbortError",
  });
});

test("shared compile cache never leaks definitions across independent runs", async () => {
  const cache = new Map();
  const input = entry("TXA $(mode)\n");
  const first = await preprocess(input, { cache, defines: { mode: "first" } });
  const second = await preprocess(input, { cache, defines: { mode: "second" } });
  assert.equal(first.text, "TXA first\n");
  assert.equal(second.text, "TXA second\n");
  assert.equal(cache.size, 1);
});

test("a substitution can generate a preprocessor directive", async () => {
  const result = await preprocess(
    entry("#define directive=#define result=works\n$(directive)\nTXA $(result)\n"),
  );
  assert.equal(result.text, "TXA works\n");
  assert.equal(result.complete, true);
});

test("conditional state follows textual insertion across file boundaries", async () => {
  const result = await preprocess(
    entry("#define enabled=1\n#include condition.dat\nPROG AQUA\n#else\nPROG ASE\n#endif\nEND\n"),
    { readSource: async (uri) => ({ uri, text: "#if enabled\n" }) },
  );
  assert.equal(result.text, "PROG AQUA\nEND\n");
  assert.equal(result.complete, true);
});

test("comments cannot create unresolved parameters and quoted include punctuation is literal", async () => {
  const requested = [];
  const result = await preprocess(
    entry(
      "$ comment $(not_defined)\nPROG AQUA $ comment $(ignored)\n#include 'part#1?.dat' $ comment\nEND\n",
    ),
    {
      readSource: async (uri) => {
        requested.push(uri);
        return { uri, text: "HEAD 'title ! quoted'\n" };
      },
    },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(requested, ["file:///project/part%231%3F.dat"]);
  assert.ok(result.text.includes("HEAD 'title ! quoted'"));
});

test("unknown directives and computed CADINP conditions stop certainty without evaluation", async () => {
  const result = await preprocess(
    entry("#if #x+1\nPROG AQUA\n#else\nPROG ASE\n#endif\n#exec danger\n"),
  );
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
  assert.deepEqual(codes(result), ["unsupported-condition", "unsupported-directive"]);
});

test("include URIs match open-buffer canonical encoding for brackets and literal percent", async () => {
  const requested = [];
  const result = await preprocess(entry("#include '[x] load.dat'\n#include 'part%20name.dat'\n"), {
    readSource: async (uri) => {
      requested.push(uri);
      return { uri, text: "PROG AQUA\nEND\n" };
    },
  });
  assert.equal(result.complete, true);
  assert.deepEqual(requested, [
    "file:///project/%5Bx%5D%20load.dat",
    "file:///project/part%2520name.dat",
  ]);
});

test("source line limits bound compilation and produce explicit incomplete diagnostics", async () => {
  const cache = new Map();
  const input = entry("PROG AQUA\nEND\nPROG ASE\nEND\n");
  const result = await preprocess(input, { cache, maxSourceLines: 2 });
  assert.equal(result.text, "PROG AQUA\nEND\n");
  assert.equal(result.complete, false);
  assert.deepEqual(codes(result), ["expansion-limit"]);
  assert.equal(result.diagnostics[0].range.start.line, 2);
  assert.match(result.diagnostics[0].message, /limit of 2 lines/);
  assert.equal(cache.get(URI).lines.length, 2);
  const unlimited = await preprocess(input, { cache, maxSourceLines: 4 });
  assert.equal(unlimited.text, input.text);
  assert.equal(unlimited.complete, true);
});

test("truncated block definitions report the line limit without invented syntax errors", async () => {
  const result = await preprocess(
    entry("#if 1\n#define block\nPROG AQUA\nEND\n#enddef\n#endif\n"),
    {
      maxSourceLines: 3,
    },
  );
  assert.deepEqual(codes(result), ["expansion-limit"]);
  assert.equal(result.complete, false);
  assert.equal(result.text, "");
});

test("line limits in included sources retain the outermost invocation anchor", async () => {
  const result = await preprocess(entry("#include large.dat\n"), {
    maxSourceLines: 2,
    readSource: async (uri) => ({ uri, text: "PROG AQUA\nEND\nPROG ASE\nEND\n" }),
  });
  assert.deepEqual(codes(result), ["expansion-limit"]);
  assert.equal(result.diagnostics[0].uri, URI);
  assert.equal(result.diagnostics[0].range.start.line, 0);
  assert.equal(result.diagnostics[0].relatedInformation[0].location.range.start.line, 2);
  assert.equal(result.text, "PROG AQUA\nEND\n");
});

test("line limits also bound generated directives and anchor them at the substitution", async () => {
  const result = await preprocess(entry("$(module)\n"), {
    maxSourceLines: 2,
    defines: { module: "#if 1\nPROG AQUA\nEND\n#endif\n" },
  });
  assert.deepEqual(codes(result), ["expansion-limit"]);
  assert.equal(result.diagnostics[0].range.start.line, 0);
  assert.equal(result.complete, false);
  assert.equal(result.text, "PROG AQUA\n");
});

test("SPS quote handling differs from CADINP doubled delimiters during substitution", async () => {
  // Confirmed against SPS 2026-6 in parse-only mode: a doubled quote closes
  // SPS's ordinary string, so a following ! starts a preprocessor comment.
  const result = await preprocess(
    entry(
      "#define macro=replaced\n+PROG TEMPLATE\n" +
        "LET#a ''text ! $(macro) $ good''\nLET#b \"\"$(macro)\"\"\n" +
        "LET#c '$(macro) $ good'\n#define DOUBLE=''keep ! $(macro) $ here''\n" +
        "LET#d $(DOUBLE)\nEND\n",
    ),
  );
  assert.equal(
    result.text,
    "+PROG TEMPLATE\nLET#a ''text ! $(macro) $ good''\nLET#b \"\"replaced\"\"\n" +
      "LET#c 'replaced $ good'\nLET#d ''keep\nEND\n",
  );
  assert.equal(result.complete, true);
});
