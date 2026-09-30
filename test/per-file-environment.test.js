const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-data");
const { SofistikProject, canonicalUri } = require("../lib/project");
const { completion, hover, signatureHelp } = require("../lib/features");
const { LspClient } = require("./lsp-client");

const SOURCE = "+PROG ASE\nLET#size 1\nGRP NO #size VAL FULL\nEND\n";

async function fixture(t, files, beforeCleanup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-file-environment-"));
  for (const [name, text] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);
  }
  t.after(async () => {
    await beforeCleanup?.();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, uri: (name) => canonicalUri(path.join(root, name)) };
}

async function projectFixture(t, files) {
  let project;
  const fixtureResult = await fixture(t, files, () => project?.dispose());
  project = new SofistikProject(
    fixtureResult.root,
    {},
    {
      resolver: new SofistikEnvironmentResolver({
        root: path.join(fixtureResult.root, "absent"),
        cwd: () => fixtureResult.root,
      }),
    },
  );
  await project.ready;
  await project.indexReady;
  return { ...fixtureResult, project };
}

test("one workspace resolves each file's sibling definition without ancestor inheritance", async (t) => {
  const { project, uri } = await projectFixture(t, {
    "sofistik.def": "SOF_VERSION = 1999\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
    "parent.dat": SOURCE,
    "first/sofistik.def": "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\nSOF_EDITION = professional\n",
    "first/model.dat": SOURCE,
    "second/sofistik.def": "SOF_VERSION = 2018\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
    "second/model.dat": SOURCE,
    "first/child/model.dat": SOURCE,
    "unconfigured/model.dat": "@ SOFiSTiK 1999 DE\n" + SOURCE,
  });
  const first = project.documents.get(uri("first/model.dat"));
  const second = project.documents.get(uri("second/model.dat"));
  assert.deepEqual(
    [first.target.version, first.target.language, first.target.edition],
    ["2026", "en", "professional"],
  );
  assert.deepEqual(
    [second.target.version, second.target.language, second.target.edition],
    ["2018", "de", "educational"],
  );
  assert.equal(project.documents.get(uri("parent.dat")).target.version, "1999");
  for (const name of ["first/child/model.dat", "unconfigured/model.dat"]) {
    const target = project.documents.get(uri(name)).target;
    assert.deepEqual(
      [target.version, target.language, target.edition],
      ["2026", "en", "professional"],
    );
    assert.equal(target.versionSource, "bundled");
  }
  assert.equal(first.index.target.keywords, first.target.keywords);
  assert.equal(second.index.target.keywords, second.target.keywords);
  assert.notEqual(first.target.keywords, second.target.keywords);
  for (const directory of ["first", "second"]) {
    project.open({
      uri: uri(`${directory}/module.dat`),
      text: "+PROG FEABENCH\nEND\n",
      version: 1,
    });
  }
  assert.ok(
    (await completion(project, uri("first/module.dat"), { line: 0, character: 8 })).some(
      (item) => item.label === "FEABENCH",
    ),
  );
  assert.equal(
    (await completion(project, uri("second/module.dat"), { line: 0, character: 8 })).some(
      (item) => item.label === "FEABENCH",
    ),
    false,
  );
  assert.deepEqual(project.diagnostics(uri("first/module.dat")), []);
  assert.match(project.diagnostics(uri("second/module.dat"))[0].message, /2018/);
  // An inherited view can carry lexical state, never override the file environment.
  const inherited = project.targetFor(second.uri, {
    module: "ASE",
    version: "2026",
    language: "en",
  });
  assert.equal(inherited.version, "2018");
  assert.equal(inherited.language, "de");
});

test("include fragments keep caller scope but use their own release for schema features", async (t) => {
  const { project, uri } = await projectFixture(t, {
    "caller/sofistik.def": "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n",
    "caller/main.dat":
      "+PROG ASE\nLET#parent 1\n#include '../fragment/part.inc'\nGRP NO #child VAL FULL\nEND\n",
    "fragment/sofistik.def": "SOF_VERSION = 1999\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
    "fragment/part.inc": "LET#child #parent\nGRP NO #parent VAL FULL\n",
  });
  const views = await project.graphFor(uri("caller/main.dat"));
  const caller = views.find((view) => view.uri === uri("caller/main.dat"));
  const fragment = views.find((view) => view.uri === uri("fragment/part.inc"));
  assert.equal(caller.target.version, "2026");
  assert.equal(fragment.target.version, "1999");
  assert.equal(fragment.index.target.version, "1999");
  assert.equal(fragment.index.target.language, "de");
  assert.equal(fragment.index.target.edition, "educational");
  assert.equal(fragment.index.target.module, "ASE");
  assert.equal(fragment.index.target.scopeId, caller.index.includes()[0].scopeId);
  assert.equal(fragment.index.enumTokens().length, 0);
  assert.deepEqual(
    (await project.definitions(fragment.uri, { line: 0, character: 13 })).map((item) => item.uri),
    [caller.uri],
  );
  assert.deepEqual(
    (await project.definitions(caller.uri, { line: 3, character: 10 })).map((item) => item.uri),
    [fragment.uri],
  );
  project.open({
    uri: fragment.uri,
    text: "@ SOFiSTiK 2026 EN\n+PROG ASE\nGRP NO 1 VAL FULL\nEND\n",
    version: 1,
  });
  assert.deepEqual(await completion(project, fragment.uri, { line: 2, character: 14 }), []);
  assert.equal(await hover(project, fragment.uri, { line: 2, character: 10 }), null);
  assert.equal(await signatureHelp(project, fragment.uri, { line: 2, character: 14 }), null);
  assert.match(project.diagnostics(fragment.uri)[0].message, /1999/);
  assert.ok(await hover(project, caller.uri, { line: 3, character: 15 }));
  assert.ok(await signatureHelp(project, caller.uri, { line: 3, character: 22 }));
});

test("watched sibling definitions rebuild and clear imported diagnostics only in their own directory", async (t) => {
  const { root, project, uri } = await projectFixture(t, {
    "sofistik.def": "SOF_VERSION = 2099\n",
    "first/sofistik.def": "SOF_VERSION = 2026\n",
    "first/model.dat": SOURCE,
    "first/model.error_positions":
      JSON.stringify({ position: { line: 3, text: "first result" }, isError: true }) + "\n",
    "second/sofistik.def": "SOF_VERSION = 2024\n",
    "second/model.dat": SOURCE,
    "second/model.error_positions":
      JSON.stringify({ position: { line: 3, text: "second result" }, isError: true }) + "\n",
  });
  const first = project.open({ uri: uri("first/model.dat"), text: SOURCE, version: 1 });
  const second = project.open({ uri: uri("second/model.dat"), text: SOURCE, version: 1 });
  await project.importCalculationDiagnostics(first.uri);
  await project.importCalculationDiagnostics(second.uri);
  const secondIndex = second.index;
  const secondTarget = second.target;
  await fs.writeFile(
    path.join(root, "first/sofistik.def"),
    "SOF_VERSION = 1999\nSOF_LANGUAGE = DE\n",
  );
  const encoded = uri("first/sofistik.def").replace(/sofistik\.def$/, "%73ofistik.def");
  const notification = process.platform === "win32" ? encoded.toUpperCase() : encoded;
  assert.deepEqual(await project.watched([{ uri: notification, type: 2 }]), [first.uri]);
  assert.equal(first.target.version, "1999");
  assert.equal(first.index.enumTokens().length, 0);
  assert.equal(project.calculationDiagnostics.has(first.uri), false);
  assert.equal(second.index, secondIndex);
  assert.equal(second.target, secondTarget);
  assert.equal(project.calculationDiagnostics.get(second.uri)[0].message, "second result");
  await fs.unlink(path.join(root, "first/sofistik.def"));
  assert.deepEqual(await project.watched([{ uri: notification, type: 3 }]), [first.uri]);
  assert.equal(first.target.version, "2026");
  assert.equal(first.target.versionSource, "bundled");
  assert.equal(first.index.enumTokens().length, 1);
  assert.equal(second.index, secondIndex);
  assert.equal(project.documents.has(notification), false);
});

test("untitled input skips cwd and workspace definitions and keeps the installed/data fallback", async (t) => {
  const { project } = await projectFixture(t, { "sofistik.def": "SOF_VERSION = 1999\n" });
  const entry = project.open({ uri: "untitled:model", text: SOURCE, version: 1 });
  assert.equal(entry.target.version, "2026");
  assert.equal(entry.target.versionSource, "bundled");
  assert.equal(entry.index.enumTokens().length, 1);
  assert.deepEqual(await project.refreshTargets(), []);
});

test("a failed directory resolution cannot leave cached selections ahead of document indexes", async (t) => {
  const { root, uri } = await fixture(t, {});
  let version = "2024";
  let fail = false;
  const project = new SofistikProject(
    root,
    {},
    {
      resolver: {
        resolve: ({ filePath }) => {
          if (fail && filePath.includes(`${path.sep}second${path.sep}`))
            throw new Error("resolver interrupted");
          return { version, language: "en", edition: "professional", dataSupported: true };
        },
      },
    },
  );
  t.after(() => project.dispose());
  await project.ready;
  await project.indexReady;
  const first = project.open({ uri: uri("first/model.dat"), text: SOURCE, version: 1 });
  const second = project.open({ uri: uri("second/model.dat"), text: SOURCE, version: 1 });
  version = "2026";
  fail = true;
  await assert.rejects(project.refreshTargets(), /resolver interrupted/);
  assert.equal(first.target.version, "2024");
  assert.equal(second.target.version, "2024");
  fail = false;
  assert.deepEqual(await project.refreshTargets(), [first.uri, second.uri]);
  assert.equal(first.index.target.version, "2026");
  assert.equal(second.index.target.version, "2026");
});

test("real protocol keeps directory environments isolated through watched changes and deletion", async (t) => {
  let client;
  const { root, uri } = await fixture(
    t,
    {
      "sofistik.def": "SOF_VERSION = 2099\n",
      "first/sofistik.def": "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n",
      "first/model.dat": SOURCE,
      "second/sofistik.def": "SOF_VERSION = 1999\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n",
      "second/model.dat": SOURCE,
      "unconfigured/model.dat": SOURCE,
    },
    () => client?.stop(),
  );
  client = new LspClient(root);
  await client.start();
  for (const name of ["first/model.dat", "second/model.dat", "unconfigured/model.dat"])
    client.open(uri(name), SOURCE);
  client.open("untitled:model", SOURCE);
  const tokens = (name) =>
    client.request("textDocument/semanticTokens/full", { textDocument: { uri: uri(name) } });
  const diagnostics = (name) =>
    client.request("textDocument/diagnostic", { textDocument: { uri: uri(name) } });
  assert.equal((await tokens("first/model.dat")).data.length, 5);
  assert.equal((await tokens("second/model.dat")).data.length, 0);
  assert.equal((await tokens("unconfigured/model.dat")).data.length, 5);
  assert.equal(
    (
      await client.request("textDocument/semanticTokens/full", {
        textDocument: { uri: "untitled:model" },
      })
    ).data.length,
    5,
  );
  assert.deepEqual(
    (await client.request("textDocument/diagnostic", { textDocument: { uri: "untitled:model" } }))
      .items,
    [],
  );
  assert.match((await diagnostics("second/model.dat")).items[0].message, /1999/);
  assert.deepEqual((await diagnostics("unconfigured/model.dat")).items, []);
  client.notifications.length = 0;
  await fs.writeFile(
    path.join(root, "second/sofistik.def"),
    "SOF_VERSION = 2026\nSOF_LANGUAGE = EN\n",
  );
  const encoded = uri("second/sofistik.def").replace(/sofistik\.def$/, "%73ofistik.def");
  const watched = process.platform === "win32" ? encoded.toUpperCase() : encoded;
  client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: watched, type: 2 }] });
  assert.equal((await tokens("second/model.dat")).data.length, 5);
  const published = client.notifications.filter(
    (item) => item.method === "textDocument/publishDiagnostics",
  );
  assert.ok(published.some((item) => item.params.uri === uri("second/model.dat")));
  assert.equal(
    published.some((item) => item.params.uri === uri("first/model.dat")),
    false,
  );
  await fs.unlink(path.join(root, "second/sofistik.def"));
  client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: watched, type: 3 }] });
  assert.equal((await tokens("second/model.dat")).data.length, 5);
  assert.deepEqual((await diagnostics("second/model.dat")).items, []);
  assert.equal((await tokens("first/model.dat")).data.length, 5);
});

test("cursor requests refresh one source directory rather than reading every workspace definition", async (t) => {
  let client;
  const { root, uri } = await fixture(
    t,
    { "first/model.dat": SOURCE, "second/model.dat": SOURCE },
    () => client?.stop(),
  );
  const countsPath = path.join(root, "reads.json");
  await fs.writeFile(countsPath, "{}");
  const bootstrap = path.join(root, "server.cjs");
  const serverPath = path.resolve(__dirname, "../lib/server.js");
  await fs.writeFile(
    bootstrap,
    `const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require(${JSON.stringify(serverPath)});
const countsPath = ${JSON.stringify(countsPath)};
startServer(undefined, { resolver: { resolve: ({ filePath }) => {
  const key = path.basename(path.dirname(filePath));
  const counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'));
  counts[key] = (counts[key] || 0) + 1;
  fs.writeFileSync(countsPath, JSON.stringify(counts));
  return { version: '2026', language: 'en', edition: 'professional', dataSupported: true };
} } });
`,
  );
  client = new LspClient(root, { entryPath: bootstrap });
  await client.start();
  for (const directory of ["first", "second"]) {
    client.open(uri(`${directory}/model.dat`), SOURCE);
    await client.request("textDocument/diagnostic", {
      textDocument: { uri: uri(`${directory}/model.dat`) },
    });
  }
  await fs.writeFile(countsPath, "{}");
  for (let request = 0; request < 3; request++) {
    await client.request("textDocument/completion", {
      textDocument: { uri: uri("first/model.dat") },
      position: { line: 0, character: 8 },
    });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(countsPath, "utf8")), { first: 3 });
});

test("current static include indexes retain transitive environment reachability after graph invalidation", async (t) => {
  const { project, root, uri } = await projectFixture(t, {
    "a/sofistik.def": "SOF_VERSION = 2026\n",
    "a/main.dat": "+PROG ASE\n#include '../b/child.dat'\nEND\n",
    "b/sofistik.def": "SOF_VERSION = 2024\n",
    "b/child.dat": "#include '../c/part.inc'\nLET#child 1\n",
    "c/sofistik.def": "SOF_VERSION = 2024\n",
    "c/part.inc": "#include '../b/child.dat'\nLET#nested 1\n",
    "unrelated/sofistik.def": "SOF_VERSION = 2024\n",
    "unrelated/input.dat": SOURCE,
  });
  const main = project.open({
    uri: uri("a/main.dat"),
    text: "+PROG ASE\n#include '../b/child.dat'\nEND\n",
    version: 1,
  });
  await project.graphFor(main.uri);
  const unrelated = project.documents.get(uri("unrelated/input.dat"));
  const unrelatedIndex = unrelated.index;
  project.change(main.uri, [{ text: main.text + "$ changed\n" }], 2);
  assert.equal(project.views.size, 0);
  for (const directory of ["b", "c", "unrelated"])
    await fs.writeFile(path.join(root, directory, "sofistik.def"), "SOF_VERSION = 2025\n");
  await project.refreshTargets(project.environmentDirectories(main.uri));
  const views = await project.graphFor(main.uri);
  for (const name of ["b/child.dat", "c/part.inc"]) {
    assert.equal(project.targetFor(uri(name)).version, "2025");
    assert.equal(views.find((view) => view.uri === uri(name)).index.target.version, "2025");
  }
  assert.equal(unrelated.target.version, "2024");
  assert.equal(unrelated.index, unrelatedIndex);
});

test("real cursor protocol refreshes preloaded includes before the first graph and after parent edits", async (t) => {
  let client;
  const parent = "+PROG ASE\n#include '../b/child.dat'\nGRP NO #child VAL FULL\nEND\n";
  const { root, uri } = await fixture(
    t,
    {
      "a/sofistik.def": "SOF_VERSION = 2026\n",
      "a/main.dat": parent,
      "b/sofistik.def": "SOF_VERSION = 1999\n",
      "b/child.dat": SOURCE,
    },
    () => client?.stop(),
  );
  client = new LspClient(root);
  await client.start();
  client.open(uri("a/main.dat"), parent);
  client.open(uri("b/child.dat"), SOURCE);
  const childReport = () =>
    client.notifications
      .filter(
        (item) =>
          item.method === "textDocument/publishDiagnostics" &&
          item.params.uri === uri("b/child.dat"),
      )
      .at(-1)?.params.diagnostics;
  await client.request("textDocument/diagnostic", { textDocument: { uri: uri("b/child.dat") } });
  assert.match(childReport()[0].message, /1999/);
  const completeParent = () =>
    client.request("textDocument/completion", {
      textDocument: { uri: uri("a/main.dat") },
      position: { line: 2, character: 11 },
    });
  await fs.writeFile(path.join(root, "b/sofistik.def"), "SOF_VERSION = 2026\n");
  client.notifications.length = 0;
  await completeParent();
  assert.deepEqual(childReport(), []);
  // No watched-file notification: the parent edit clears the previously built graph.
  client.change(uri("a/main.dat"), [{ text: parent + "$ changed\n" }], 2);
  await client.request("textDocument/documentSymbol", { textDocument: { uri: uri("a/main.dat") } });
  await fs.writeFile(path.join(root, "b/sofistik.def"), "SOF_VERSION = 2099\n");
  client.notifications.length = 0;
  await completeParent();
  assert.match(childReport()[0].message, /2099/);
});
