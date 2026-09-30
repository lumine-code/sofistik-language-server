"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikEnvironmentResolver } = require("@lumine-code/sofistik-data");
const { SofistikProject, canonicalUri } = require("../lib/project");
const { LspClient } = require("./lsp-client");

async function directory(t, beforeCleanup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-refresh-"));
  t.after(async () => {
    if (beforeCleanup) await beforeCleanup();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return root;
}

test("refresh observes installed-selection TTL and atomically updates every open target", async (t) => {
  const root = await directory(t);
  const installationRoot = path.join(root, "installed");
  let now = 0;
  let installed = ["2024"];
  let definition = null;
  let scans = 0;
  const resolver = new SofistikEnvironmentResolver({
    root: installationRoot,
    now: () => now,
    installationCacheMs: 100,
    readFile: (file) => (file === path.join(root, "sofistik.def") ? definition : null),
    readdir: () => {
      scans++;
      return installed;
    },
    exists: (file) =>
      installed.some((version) => {
        const install = path.join(installationRoot, version, `SOFiSTiK ${version}`);
        return file === install || file === path.join(install, "sps.exe");
      }),
  });
  const project = new SofistikProject(root, {}, { resolver });
  t.after(() => project.dispose());
  await project.ready;
  await project.indexReady;
  const first = project.open({
    uri: canonicalUri(path.join(root, "first.dat")),
    version: 1,
    text: "@ SOFiSTiK 2099 DE\n+PROG ASE\nGRP NO 1 VAL FULL\nEND\n",
  });
  const second = project.open({
    uri: canonicalUri(path.join(root, "second.dat")),
    version: 1,
    text: "+PROG AQUA\nEND\n",
  });
  const target = project.target;
  const index = first.index;
  installed = ["2024", "2026"];
  now = 50;
  assert.equal(await project.refreshTarget(), false);
  assert.equal(project.target, target);
  assert.equal(first.index, index);
  assert.equal(scans, 1);
  now = 100;
  assert.equal(await project.refreshTarget(), true);
  assert.equal(project.target.version, "2026");
  assert.equal(project.target.versionSource, "installed");
  assert.equal(scans, 2);
  assert.ok([first, second].every((entry) => entry.index.target.version === "2026"));
  definition = "SOF_VERSION = 2022\nSOF_LANGUAGE = DE\nSOF_EDITION = educational\n";
  assert.equal(await project.refreshTarget(), true);
  for (const entry of [first, second]) {
    assert.equal(entry.index.target.version, "2022");
    assert.equal(entry.index.target.language, "de");
    assert.equal(entry.index.target.edition, "educational");
  }
  definition = "SOF_VERSION = 2099\n";
  assert.equal(await project.refreshTarget(), true);
  assert.equal(project.target.version, "2099");
  assert.equal(project.target.dataSupported, false);
  assert.equal(first.index.enumTokens().length, 0);
  assert.match(project.diagnostics(first.uri)[0].message, /2099/);
});

test("decoded and Windows case-equivalent definition notifications never create input documents", async (t) => {
  const root = await directory(t);
  let selected = "2024";
  const project = new SofistikProject(
    root,
    {},
    {
      resolver: {
        resolve: () => ({
          version: selected,
          language: "en",
          edition: "professional",
          dataSupported: true,
        }),
      },
    },
  );
  t.after(() => project.dispose());
  await project.ready;
  await project.indexReady;
  const encoded = project.definitionUri.replace(/sofistik\.def$/, "%73ofistik.def");
  assert.equal(project.isDefinitionUri(encoded), true);
  const notification = process.platform === "win32" ? encoded.toUpperCase() : encoded;
  assert.equal(project.isDefinitionUri(notification), true);
  selected = "2026";
  await project.watched([{ uri: notification, type: 2 }]);
  assert.equal(project.target.version, "2026");
  assert.equal(project.documents.size, 0);
  assert.equal(
    project.open({ uri: project.definitionUri, text: "LET#leak 1\n", version: 1 }),
    null,
  );
  assert.equal(await project.loadDocument(project.definitionUri), null);
  await project.watched([{ uri: canonicalUri(path.join(root, "child", "sofistik.def")), type: 2 }]);
  assert.equal(project.documents.size, 0);
});

test("real protocol accepts canonical definition aliases and preserves an unsupported declared year", async (t) => {
  let client;
  const root = await directory(t, () => client?.stop());
  await fs.writeFile(path.join(root, "sofistik.def"), "SOF_VERSION = 2024\n");
  const source = "+PROG ASE\nGRP NO 1 VAL FULL\nEND\n";
  await fs.writeFile(path.join(root, "model.dat"), source);
  client = new LspClient(root);
  await client.start();
  const uri = canonicalUri(path.join(root, "model.dat"));
  client.open(uri, source);
  assert.deepEqual(
    (await client.request("textDocument/diagnostic", { textDocument: { uri } })).items,
    [],
  );
  await fs.writeFile(
    path.join(root, "sofistik.def"),
    "SOF_VERSION = 2099\nLET#should_not_index 1\n",
  );
  const encoded = canonicalUri(path.join(root, "sofistik.def")).replace(
    /sofistik\.def$/,
    "%73ofistik.def",
  );
  const watched = process.platform === "win32" ? encoded.toUpperCase() : encoded;
  client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: watched, type: 2 }] });
  const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.match(
    diagnostics.items.find((item) => item.code === "unsupported-project-version").message,
    /2099/,
  );
  assert.deepEqual(await client.request("workspace/symbol", { query: "should_not_index" }), []);
});

test("real protocol refreshes automatic selections on requests and save without refresh deadlocks", async (t) => {
  let client;
  const root = await directory(t, () => client?.stop());
  const state = path.join(root, "selection.json");
  const setSelection = async (version) => {
    const next = path.join(root, "selection.next");
    await fs.writeFile(
      next,
      JSON.stringify({
        version,
        language: "en",
        edition: "professional",
        installed: true,
        dataSupported: ["2018", "2026"].includes(version),
        versionSource: "installed",
      }),
    );
    await fs.rename(next, state);
  };
  await setSelection("2018");
  const bootstrap = path.join(root, "server.cjs");
  const server = path.resolve(__dirname, "../lib/server.js");
  await fs.writeFile(
    bootstrap,
    `const fs = require('node:fs');\nconst { startServer } = require(${JSON.stringify(server)});\nstartServer(undefined, { resolver: { resolve: () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8')) } });\n`,
  );
  const source = "+PROG FEABENCH\nEND\n";
  const uri = canonicalUri(path.join(root, "model.dat"));
  await fs.writeFile(path.join(root, "model.dat"), source);
  client = new LspClient(root, { entryPath: bootstrap });
  await client.start();
  client.open(uri, source);
  const params = { textDocument: { uri }, position: { line: 0, character: 8 } };
  const before = await client.request("textDocument/completion", params);
  assert.equal(
    before.some((item) => item.label === "FEABENCH"),
    false,
  );
  let refreshes = 0;
  client.connection.onRequest("workspace/semanticTokens/refresh", async () => {
    refreshes++;
    await client.request("textDocument/semanticTokens/full", { textDocument: { uri } });
    return null;
  });
  await setSelection("2026");
  const after = await client.request("textDocument/completion", params);
  assert.ok(after.some((item) => item.label === "FEABENCH"));
  const diagnostics = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.equal(
    diagnostics.items.some((item) => item.code === "unknown-module"),
    false,
  );
  await setSelection("2099");
  client.notify("textDocument/didSave", { textDocument: { uri } });
  const unsupported = await client.request("textDocument/diagnostic", { textDocument: { uri } });
  assert.match(
    unsupported.items.find((item) => item.code === "unsupported-project-version").message,
    /2099/,
  );
  assert.ok(refreshes > 0);
});
