const assert = require("node:assert/strict");
const test = require("node:test");
const { preprocess } = require("../lib/preprocessor");

// Scalar timing, project aliases, legacy globals and hash rows were compared
// with SPS 2026-7.0.962 using -Q:filename (parsing without calculation modules).
const entry = (text) => ({ uri: "file:///examples/main.dat", text });

test("table rows beginning with CADINP variables survive SPS preprocessing", async () => {
  const text = [
    "+PROG SOFIMSHA",
    "LET#ymax 4",
    "LET#zmax 6",
    "NODE X Y Z",
    "#ymax/2 0 -#zmax/2",
    "#ymax/2 0 #zmax/2",
    "#A(0) 1 2",
    "#A 3 4",
    "END",
    "",
  ].join("\n");
  const result = await preprocess(entry(text));
  assert.equal(result.text, text);
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.segments[4].origin.range.start, { line: 4, character: 0 });
});

test("substitutions producing a variable row are not recompiled as SPS commands", async () => {
  const result = await preprocess(
    entry("#define value=#dtgust/4\n+PROG SOFILOAD\nFUNC T F\n$(value) 1\nEND\n"),
  );
  assert.equal(result.text, "+PROG SOFILOAD\nFUNC T F\n#dtgust/4 1\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("memory blocks retain variable-leading rows and process actual directives", async () => {
  const result = await preprocess(
    entry(
      "#define rows\n#if selected\n#A 1 2\n#else\n#B 3 4\n#endif\n#enddef\n" +
        "#define selected=1\n+PROG SOFIMSHA\nNODE NO X Y\n#include rows\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG SOFIMSHA\nNODE NO X Y\n#A 1 2\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("unknown hash words remain CADINP input instead of manufacturing SPS errors", async () => {
  const result = await preprocess(entry("#exec 1\n#ifunknown 2\n#defineX 3\n"));
  assert.equal(result.text, "#exec 1\n#ifunknown 2\n#defineX 3\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("the German PROJEKT default follows the selected project name", async () => {
  const result = await preprocess(entry("+SYS copy $(PROJEKT).cdb $(PROJECT).bak\n"), {
    defines: { PROJECT: "selected-project" },
  });
  assert.equal(result.text, "+SYS copy selected-project.cdb selected-project.bak\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("explicit PROJEKT definitions retain normal precedence and case insensitivity", async () => {
  const result = await preprocess(
    entry("TXA $(projekt)\n#define projekt=local\nTXA $(PROJEKT) $(PROJECT)\n"),
    { defines: { PROJEKT: "external" } },
  );
  assert.equal(result.text, "TXA external\nTXA local local\n");
  assert.deepEqual(result.diagnostics, []);
});

test("legacy parameter assignments between programs behave as SPS definitions", async () => {
  const result = await preprocess(
    entry(
      "h=350 $ mast height\nn=10\nDeff=32\n" +
        "+PROG TEMPLATE\nTXA $(h) $(n) $(Deff)\nEND\n" +
        "h=360\n+PROG TEMPLATE\nTXA $(h)\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nTXA 350 10 32\nEND\n+PROG TEMPLATE\nTXA 360\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("CADINP values with equals inside programs do not define SPS parameters", async () => {
  const result = await preprocess(entry("+PROG TEMPLATE\nx=inside\nTXA $(x)\nEND\n"));
  assert.equal(result.text, "+PROG TEMPLATE\nx=inside\nTXA $(x)\nEND\n");
  assert.deepEqual(
    result.diagnostics.map((issue) => issue.code),
    ["undefined-macro"],
  );
});

test("legacy assignments honor active branches and memory block insertion context", async () => {
  const result = await preprocess(
    entry(
      "#define setup\nmode=from-block\n#enddef\n#if 0\nmode=inactive\n#endif\n" +
        "#include setup\n+PROG TEMPLATE\nTXA $(mode)\n#include setup\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nTXA from-block\nmode=from-block\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("scalar assignments capture existing values and allow nonrecursive redefinition", async () => {
  const result = await preprocess(
    entry(
      "#define a=old\n#define b=$(a)\n#define a=new\n#define a=$(a)_more\n" +
        "+PROG TEMPLATE\nTXA $(a) $(b)\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nTXA new_more old\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("forward scalar references fail at the definition even when declared later", async () => {
  const result = await preprocess(
    entry("#define command=$(suffix)\n#define suffix=mb\n+PROG TEMPLATE\nEND\n"),
  );
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "undefined-macro");
  assert.deepEqual(result.diagnostics[0].range, {
    start: { line: 0, character: 16 },
    end: { line: 0, character: 25 },
  });
});

test("block scalar definitions execute only when inserted into the current environment", async () => {
  const result = await preprocess(
    entry(
      "#if 0\n#define x=$(undefined)\n#endif\n" +
        "#define block\n#define late=$(later)\nTXA $(late)\n#enddef\n" +
        "#define later=defined\n+PROG TEMPLATE\n#include block\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nTXA defined\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("project changes capture the preceding project and keep both spellings synchronized", async () => {
  const result = await preprocess(
    entry(
      "#DEFINE PROJECT0=$(PROJECT)_0\n#DEFINE PROJECT1=$(PROJECT)\n" +
        '#DEFINE PROJECT="$(PROJECT0)"\n+PROG TEMPLATE\nTXA $(PROJECT0) $(PROJECT1) $(PROJECT) $(PROJEKT)\nEND\n' +
        '#DEFINE PROJEKT="$(PROJECT1)"\n+PROG TEMPLATE\nTXA $(PROJECT0) $(PROJECT1) $(PROJECT) $(PROJEKT)\nEND\n',
    ),
  );
  assert.equal(
    result.text,
    "+PROG TEMPLATE\nTXA main_0 main main_0 main_0\nEND\n" +
      "+PROG TEMPLATE\nTXA main_0 main main main\nEND\n",
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});

test("SPS scalar capture preserves CADINP runtime expressions and quoted values", async () => {
  const result = await preprocess(
    entry(
      "#define numeric=#length/2\n#define literal='hello world'\n" +
        "+PROG TEMPLATE\nTXA $(numeric) $(literal)\nEND\n",
    ),
  );
  assert.equal(result.text, "+PROG TEMPLATE\nTXA #length/2 'hello world'\nEND\n");
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics, []);
});
