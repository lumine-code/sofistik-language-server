const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-env");
const { SofistikProject, canonicalUri } = require("../lib/project");
const { hover } = require("../lib/features");

async function fixture(t, files, definition = "SOF_VERSION = 2026\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-project-"));
  if (definition !== null) await fs.writeFile(path.join(root, "sofistik.def"), definition);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const resolver = new SofistikEnvironmentResolver({
    fallbackVersion: "2026",
    root: path.join(root, "absent-installation"),
  });
  const project = new SofistikProject(root, {}, { resolver });
  t.after(async () => {
    project.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await project.ready;
  await project.indexReady;
  return { root, project, uri: (name) => canonicalUri(path.join(root, name)) };
}

test("offline project resolution ignores headers and uses the newest data without a definition", async (t) => {
  const { project, uri } = await fixture(
    t,
    { "main.dat": "@ SOFiSTiK 1999 DE\n+PROG ASE\nGRP NO 1 VAL FULL\nEND\n" },
    null,
  );
  const target = (await project.loadDocument(uri("main.dat"))).target;
  assert.equal(target.version, "2026");
  assert.equal(target.language, "en");
  assert.equal(target.installed, false);
  assert.equal(target.versionSource, "fallback");
  assert.equal((await project.loadDocument(uri("main.dat"))).index.enumTokens().length, 1);
});

test("a sibling definition selects the same year language and edition for files in its directory", async (t) => {
  const { project, uri } = await fixture(
    t,
    {
      "main.dat": "@ SOFiSTiK 2026 EN\n+PROG ASE\nEND\n",
      "other.dat": "@ SOFiSTiK 2020 DE\n+PROG AQUA\nEND\n",
    },
    "SOF_VERSION = 2024\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
  );
  for (const name of ["main.dat", "other.dat"]) {
    const target = (await project.loadDocument(uri(name))).target;
    assert.equal(target.version, "2024");
    assert.equal(target.language, "de");
    assert.equal(target.edition, "educational");
  }
});

test("static include fragments inherit their caller's scope for definitions and references", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG ASE\nLET#size 1\n#include 'part.dat'\nGRP NO #child VAL FULL\nEND\n",
    "part.dat": "LET#child #size\nGRP NO #size VAL FULL\n",
    "other.dat": "+PROG ASE\nLET#size 2\nGRP NO #size VAL FULL\nEND\n",
  });
  const include = await project.definitions(uri("main.dat"), { line: 2, character: 12 });
  assert.equal(include[0].uri, uri("part.dat"));
  const child = await project.definitions(uri("main.dat"), { line: 3, character: 10 });
  assert.deepEqual(
    child.map((location) => location.uri),
    [uri("part.dat")],
  );
  const parent = await project.definitions(uri("part.dat"), { line: 1, character: 10 });
  assert.deepEqual(
    parent.map((location) => location.uri),
    [uri("main.dat")],
  );
  const references = await project.references(uri("main.dat"), { line: 1, character: 6 }, false);
  assert.deepEqual(
    references.map((location) => [location.uri, location.range.start.line]),
    [
      [uri("part.dat"), 0],
      [uri("part.dat"), 1],
    ],
  );
});

test("cyclic include graphs terminate without losing their local symbols", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG ASE\n#include 'part.dat'\nLET#size 1\nEND\n",
    "part.dat": "#include 'main.dat'\nLET#child 1\n",
  });
  const views = await project.graphFor(uri("main.dat"));
  assert.ok(views.length >= 2 && views.length <= 4);
  assert.ok(
    (await project.visibleSymbols(uri("main.dat"))).some((symbol) => symbol.name === "child"),
  );
});

test("stored-variable source candidates work across inputs without merging local variables", async (t) => {
  const { project, uri } = await fixture(t, {
    "store.dat": "+PROG TEMPLATE\nSTO#value 1\nEND\n",
    "read.dat": "+PROG ASE\nGRP NO #value VAL FULL\nEND\n",
    "local.dat": "+PROG ASE\nLET#value 2\nGRP NO #value VAL FULL\nEND\n",
  });
  assert.deepEqual(
    (await project.definitions(uri("read.dat"), { line: 1, character: 10 })).map(
      (location) => location.uri,
    ),
    [uri("store.dat")],
  );
  assert.deepEqual(
    (await project.definitions(uri("local.dat"), { line: 2, character: 10 })).map(
      (location) => location.uri,
    ),
    [uri("local.dat")],
  );
});

test("binary or invalid UTF-8 inputs are excluded from the textual project index", async (t) => {
  const { project, uri } = await fixture(t, {
    "binary.dat": Buffer.from([0, 1, 2]),
    "invalid.dat": Buffer.from([0xff, 0xfe, 0x23]),
    "main.dat": "+PROG ASE\nEND\n",
  });
  assert.equal(project.documents.has(uri("binary.dat")), false);
  assert.equal(project.documents.has(uri("invalid.dat")), false);
  assert.equal(project.documents.has(uri("main.dat")), true);
});

test("a closed include refresh uses disk while an open buffer remains authoritative", async (t) => {
  const { root, project, uri } = await fixture(t, { "main.dat": "+PROG ASE\nLET#size 1\nEND\n" });
  const main = uri("main.dat");
  project.open({ uri: main, version: 1, text: "+PROG ASE\nLET#buffer 1\nEND\n" });
  await fs.writeFile(path.join(root, "main.dat"), "+PROG ASE\nLET#disk 1\nEND\n");
  await project.watched([{ uri: main, type: 2 }]);
  assert.ok(
    project.documents
      .get(main)
      .index.symbols()
      .some((symbol) => symbol.name === "buffer"),
  );
  await project.close(main);
  assert.ok(
    project.documents
      .get(main)
      .index.symbols()
      .some((symbol) => symbol.name === "disk"),
  );
});

test("module validation names the exact token and release without rejecting runtime values", async (t) => {
  const { project, uri } = await fixture(t, { "main.dat": "+PROG UNKNOWN\nEND\n" });
  project.open({ uri: uri("main.dat"), version: 1, text: "+PROG UNKNOWN\nEND\n" });
  const errors = project.diagnostics(uri("main.dat"));
  assert.equal(errors[0].code, "unknown-module");
  assert.equal(errors[0].range.start.character, 6);
  assert.match(errors[0].message, /2026/);
  project.change(uri("main.dat"), [{ text: "+PROG SOFIMSHA\nNODE 1 FIX PXPY\nEND\n" }], 2);
  assert.deepEqual(project.diagnostics(uri("main.dat")), []);
});

test("symbol hover previews a unique source declaration without identity or count boilerplate", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG ASE\nLET#size 1\nGRP NO #size VAL FULL\nEND\n",
  });
  const result = await hover(project, uri("main.dat"), { line: 2, character: 10 });
  assert.deepEqual(result.contents, { kind: "plaintext", value: "LET#size 1\n\nmain.dat:2" });
  assert.equal(await hover(project, uri("main.dat"), { line: 1, character: 6 }), null);
  assert.equal(await hover(project, uri("main.dat"), { line: 2, character: 12 }), null);
});

test("hover suppresses missing and ambiguous runtime definitions", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat":
      "+PROG ASE\nLET#size 1\nLET#size 2\nGRP NO #size VAL FULL\nGRP NO #external VAL FULL\nEND\n",
  });
  assert.equal(await hover(project, uri("main.dat"), { line: 3, character: 10 }), null);
  assert.equal(await hover(project, uri("main.dat"), { line: 4, character: 10 }), null);
});

test("macro hover shows its source value without claiming an evaluated runtime result", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG TEMPLATE\n#define factor=2\nLET#size $(factor)\nEND\n",
  });
  const result = await hover(project, uri("main.dat"), { line: 2, character: 13 });
  assert.deepEqual(result.contents, { kind: "plaintext", value: "#define factor=2\n\nmain.dat:2" });
  assert.equal(await hover(project, uri("main.dat"), { line: 1, character: 9 }), null);
});
