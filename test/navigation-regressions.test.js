"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikProject, canonicalUri } = require("../lib/project");

async function fixture(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-navigation-"));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const resolver = {
    resolve: () => ({
      version: "2026",
      language: "en",
      edition: "professional",
      dataSupported: true,
      installed: false,
    }),
  };
  const project = new SofistikProject(root, {}, { resolver });
  t.after(async () => {
    project.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await project.ready;
  await project.indexReady;
  return { project, root, uri: (name) => canonicalUri(path.join(root, name)) };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("persistent references exclude unrelated local declarations and their shadowed reads", async (t) => {
  const { project, uri } = await fixture(t, {
    "store.dat": "+PROG TEMPLATE\nSTO#value 1\nEND\n",
    "read.dat": "+PROG ASE\nGRP NO #value VAL FULL\nEND\n",
    "local.dat": "+PROG ASE\nLET#value 2\nGRP NO #value VAL FULL\nEND\n",
  });
  const references = await project.references(uri("read.dat"), { line: 1, character: 10 });
  assert.deepEqual(
    references.map((item) => [item.uri, item.range.start.line]),
    [[uri("read.dat"), 1]],
  );
  const includingDefinitions = await project.references(
    uri("read.dat"),
    { line: 1, character: 10 },
    true,
  );
  assert.deepEqual(
    new Set(includingDefinitions.map((item) => item.uri)),
    new Set([uri("store.dat"), uri("read.dat")]),
  );
  const local = await project.references(uri("local.dat"), { line: 1, character: 6 });
  assert.deepEqual(
    local.map((item) => [item.uri, item.range.start.line]),
    [[uri("local.dat"), 2]],
  );
});

test("macros bind only inside reachable origin graphs rather than all project inputs", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "#DEFINE demo=1\n#INCLUDE demo\n#INCLUDE 'part.dat'\n",
    "part.dat": "HEAD $(demo)\n",
    "unrelated.dat": "#DEFINE demo=2\nHEAD $(demo)\n",
  });
  const definitions = await project.definitions(uri("main.dat"), { line: 1, character: 10 });
  assert.deepEqual(
    definitions.map((item) => item.uri),
    [uri("main.dat")],
  );
  const fragment = await project.definitions(uri("part.dat"), { line: 0, character: 9 });
  assert.deepEqual(
    fragment.map((item) => item.uri),
    [uri("main.dat")],
  );
  const references = await project.references(uri("main.dat"), { line: 0, character: 9 });
  assert.deepEqual(
    references.map((item) => [item.uri, item.range.start.line]),
    [
      [uri("main.dat"), 1],
      [uri("part.dat"), 0],
    ],
  );
});

test("shared macro fragments retain both caller environments without unrelated definitions", async (t) => {
  const { project, uri } = await fixture(t, {
    "a.dat": "#DEFINE choose=1\n#INCLUDE 'part.dat'\n",
    "b.dat": "#DEFINE choose=2\n#INCLUDE 'part.dat'\n",
    "part.dat": "HEAD $(choose)\n",
    "unrelated.dat": "#DEFINE choose=3\n",
  });
  const definitions = await project.definitions(uri("part.dat"), { line: 0, character: 9 });
  assert.deepEqual(
    new Set(definitions.map((item) => item.uri)),
    new Set([uri("a.dat"), uri("b.dat")]),
  );
});

test("DEL wildcards do not resolve or appear as exact variable references", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG TEMPLATE\nLET#OPT 2\nDEL#OPT*\nHEAD #OPT\nEND\n",
  });
  assert.deepEqual(await project.definitions(uri("main.dat"), { line: 2, character: 6 }), []);
  assert.deepEqual(await project.references(uri("main.dat"), { line: 2, character: 6 }), []);
  const references = await project.references(uri("main.dat"), { line: 1, character: 6 });
  assert.deepEqual(
    references.map((item) => item.range.start.line),
    [3],
  );
});

test("unscoped standalone fragments do not share an accidental document scope", async (t) => {
  const { project, uri } = await fixture(t, { "a.dat": "LET#name 1\n", "b.dat": "HEAD #name\n" });
  assert.deepEqual(await project.definitions(uri("b.dat"), { line: 0, character: 8 }), []);
});

test("an asynchronous include read cannot publish stale reachability after an edit", async (t) => {
  const source = "+PROG ASE\n#INCLUDE 'part.inc'\nEND\n";
  const { project, uri } = await fixture(t, { "main.dat": source });
  project.open({ uri: uri("main.dat"), text: source, version: 1 });
  const entered = deferred();
  const content = deferred();
  project.readInput = async (input) => {
    if (input !== uri("part.inc")) return null;
    entered.resolve();
    return content.promise;
  };
  const pending = project.graphFor(uri("main.dat"));
  await entered.promise;
  project.change(uri("main.dat"), [{ text: "+PROG ASE\nHEAD no include\nEND\n" }], 2);
  content.resolve("LET#child 1\n");
  assert.deepEqual(
    (await pending).map((item) => item.uri),
    [uri("main.dat")],
  );
  assert.deepEqual(
    (await project.graphFor(uri("main.dat"))).map((item) => item.uri),
    [uri("main.dat")],
  );
});

test("aggregate contextual cache retries after edits and new disk document discovery", async (t) => {
  const source = "+PROG ASE\n#INCLUDE 'part.inc'\nHEAD $(orphan)\nEND\n";
  const { project, uri } = await fixture(t, { "main.dat": source });
  project.open({ uri: uri("main.dat"), text: source, version: 1 });
  const entered = deferred();
  const content = deferred();
  project.readInput = async (input) => {
    if (input !== uri("part.inc")) return null;
    entered.resolve();
    return content.promise;
  };
  const pending = project.contextualViews();
  await entered.promise;
  project.change(uri("main.dat"), [{ text: "+PROG ASE\nHEAD $(orphan)\nEND\n" }], 2);
  content.resolve("#DEFINE orphan=1\n");
  const views = await pending;
  assert.deepEqual(
    views.filter((item) => item.originUri === uri("main.dat")).map((item) => item.uri),
    [uri("main.dat")],
  );
  assert.ok(views.some((item) => item.originUri === uri("part.inc")));
  assert.equal(await project.contextualViews(), views);
  assert.deepEqual(await project.definitions(uri("main.dat"), { line: 1, character: 9 }), []);
});

test("new include chains are discovered in one graph traversal and cached afterwards", async (t) => {
  const files = { "main.dat": "+PROG ASE\n#INCLUDE 'part0.inc'\nEND\n" };
  for (let index = 0; index < 16; index++)
    files[`part${index}.inc`] = index < 15 ? `#INCLUDE 'part${index + 1}.inc'\n` : "LET#child 1\n";
  const { project, uri } = await fixture(t, files);
  const targetFor = project.targetFor.bind(project);
  let contextualBuilds = 0;
  project.targetFor = (...args) => {
    contextualBuilds++;
    return targetFor(...args);
  };
  const views = await project.graphFor(uri("main.dat"));
  assert.equal(views.length, 17);
  assert.ok(contextualBuilds <= 32);
  const builds = contextualBuilds;
  assert.equal(await project.graphFor(uri("main.dat")), views);
  assert.equal(contextualBuilds, builds);
});

test("late disk loads cannot replace a newly opened client buffer", async (t) => {
  const { project, uri } = await fixture(t);
  const entered = deferred();
  const content = deferred();
  project.readInput = async () => {
    entered.resolve();
    return content.promise;
  };
  const pending = project.loadDocument(uri("late.inc"));
  await entered.promise;
  const opened = project.open({ uri: uri("late.inc"), version: 7, text: "LET#buffer 2\n" });
  content.resolve("LET#disk 1\n");
  assert.equal(await pending, opened);
  assert.equal(project.documents.get(uri("late.inc")).open, true);
  assert.ok(opened.index.symbols().some((item) => item.name === "buffer"));
});

test("watched deletion invalidates an already pending closed-file read", async (t) => {
  const { project, uri } = await fixture(t);
  const entered = deferred();
  const content = deferred();
  let reads = 0;
  project.readInput = async () => {
    reads++;
    if (reads > 1) return null;
    entered.resolve();
    return content.promise;
  };
  const pending = project.loadDocument(uri("late.inc"));
  await entered.promise;
  await project.watched([{ uri: uri("late.inc"), type: 3 }]);
  content.resolve("LET#old 1\n");
  assert.equal(await pending, null);
  assert.equal(project.documents.has(uri("late.inc")), false);
});

test("configuration disk refresh cannot delete a buffer opened during its read", async (t) => {
  const { project, uri } = await fixture(t, { "main.dat": "LET#disk 1\n" });
  const entered = deferred();
  const content = deferred();
  project.readInput = async () => {
    entered.resolve();
    return content.promise;
  };
  const pending = project.configure({});
  await entered.promise;
  const opened = project.open({ uri: uri("main.dat"), version: 1, text: "LET#buffer 1\n" });
  content.resolve(null);
  await pending;
  assert.equal(project.documents.get(uri("main.dat")), opened);
});

test("disposal discards asynchronous discoveries and leaves caches empty", async (t) => {
  const { project, uri } = await fixture(t, { "main.dat": "#INCLUDE 'part.inc'\n" });
  const entered = deferred();
  const content = deferred();
  project.readInput = async () => {
    entered.resolve();
    return content.promise;
  };
  const pending = project.graphFor(uri("main.dat"));
  await entered.promise;
  project.dispose();
  content.resolve("LET#late 1\n");
  assert.deepEqual(await pending, []);
  assert.equal(project.documents.size, 0);
  assert.equal(project.views.size, 0);
  assert.equal(project.navigation.allViews, null);
});

test("context readiness and open-buffer completion do not await background disk indexing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-navigation-startup-"));
  const large =
    "+PROG ASE\n" +
    Array.from({ length: 5000 }, (_, index) => `GRP NO ${index + 1} VAL FULL`).join("\n") +
    "\nEND\n";
  await fs.writeFile(path.join(root, "huge.dat"), large);
  const resolver = {
    resolve: () => ({
      version: "2026",
      language: "en",
      edition: "professional",
      dataSupported: true,
      installed: false,
    }),
  };
  const project = new SofistikProject(root, {}, { resolver });
  t.after(async () => {
    project.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const entered = deferred();
  const content = deferred();
  project.readInput = async () => {
    entered.resolve();
    return content.promise;
  };
  await project.ready;
  await entered.promise;
  let indexed = false;
  project.indexReady.then(() => {
    indexed = true;
  });
  const main = canonicalUri(path.join(root, "main.dat"));
  project.open({ uri: main, version: 1, text: "+PROG ASE\nGRP NO 1 VAL " });
  const { completion } = require("../lib/features");
  const suggestions = await completion(project, main, { line: 1, character: 13 });
  assert.ok(suggestions.some((item) => item.label === "FULL"));
  assert.equal(indexed, false);
  content.resolve(large);
  await project.indexReady;
  assert.ok(project.documents.has(canonicalUri(path.join(root, "huge.dat"))));
});
