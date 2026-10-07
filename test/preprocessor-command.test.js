"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { CancellationTokenSource } = require("vscode-jsonrpc");
const { LspClient } = require("./lsp-client");

const COMMAND = "sofistik.expandPreprocessor";
const DEFINITION = "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n";
const commandParams = (uri) => ({ command: COMMAND, arguments: [{ uri }] });
const errorCode = (code) => (error) => {
  assert.equal(error.cause?.code ?? error.code, code, error.message);
  return true;
};

async function waitForFile(filePath) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Server did not reach ${path.basename(filePath)}.`);
}

async function fixture(t, files = {}, { blockInclude = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-preprocessor-command-"));
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const barriers = {
    entered: path.join(root, "read.entered"),
    waiting: path.join(root, "request.waiting"),
    release: path.join(root, "read.release"),
  };
  let client;
  t.after(async () => {
    if (blockInclude) await fs.writeFile(barriers.release, "");
    await client?.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("sofistik-preprocessor-command-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const [name, text] of Object.entries({ "sofistik.def": DEFINITION, ...files })) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);
  }

  let entryPath;
  if (blockInclude) {
    entryPath = path.join(root, "server.cjs");
    const servicePath = path.resolve(__dirname, "../lib/lint-service.js");
    const serverPath = path.resolve(__dirname, "../lib/server.js");
    // Block after the include snapshot is registered, so changing that buffer
    // invalidates the precise job being awaited without relying on timing.
    await fs.writeFile(
      entryPath,
      `const fs = require("node:fs");
const { LintService } = require(${JSON.stringify(servicePath)});
const barriers = ${JSON.stringify(barriers)};
const rootUri = ${JSON.stringify(uri("model.dat"))};
const includeUri = ${JSON.stringify(uri("part.dat"))};
const readSource = LintService.prototype.readSource;
const wait = LintService.prototype.wait;
let blocked = false;
LintService.prototype.wait = function(uri, token) {
  const pending = wait.call(this, uri, token);
  if (uri === rootUri) fs.writeFileSync(barriers.waiting, "");
  return pending;
};
LintService.prototype.readSource = async function(job, uri) {
  const source = await readSource.call(this, job, uri);
  if (!blocked && job.uri === rootUri && uri === includeUri) {
    blocked = true;
    fs.writeFileSync(barriers.entered, "");
    while (!fs.existsSync(barriers.release))
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return source;
};
require(${JSON.stringify(serverPath)}).startServer();
`,
    );
  }
  client = new LspClient(root, { entryPath });
  const initialized = await client.start();
  const expand = (sourceUri) =>
    client.request("workspace/executeCommand", commandParams(sourceUri));
  return { root, uri, client, initialized, expand, barriers };
}

test("advertised expansion uses sibling definitions, nested macros, blocks, includes and conditions", async (t) => {
  const { uri, client, initialized, expand } = await fixture(t, {
    "sofistik.def": DEFINITION + "MODULE=ASE\nACTIVE=1\nTITLE=external\nSIZE=2\n",
    "sub/part.dat": "HEAD '$(TITLE)'\n#include ../leaf.dat\n",
    "leaf.dat": "LET#size $(SIZE)\n",
  });
  assert.ok(initialized.capabilities.executeCommandProvider.commands.includes(COMMAND));
  const model = uri("model.dat");
  client.open(
    model,
    "#define suffix=dule\n#define chosen=$(mo$(suffix))\n#define block\n" +
      "+PROG $(chosen)\n#include sub/part.dat\nEND\n#enddef\n" +
      "#if $(ACTIVE)\n#include block\n#else\n+PROG INVALID\n#endif\n",
  );
  const expected = {
    uri: model,
    version: 1,
    text: "+PROG ASE\nHEAD 'external'\nLET#size 2\nEND\n",
    complete: true,
    uncertainties: [],
  };
  assert.deepEqual(await expand(model), expected);
  await client.request("textDocument/diagnostic", { textDocument: { uri: model } });
  assert.deepEqual(await expand(model), expected);
});

test("expansion follows unsaved root and include changes and falls back to disk after include close", async (t) => {
  const { uri, client, expand } = await fixture(t, {
    "model.dat": "+PROG AQUA\nEND\n",
    "part.dat": "HEAD 'disk'\n",
  });
  const model = uri("model.dat");
  const part = uri("part.dat");
  const rootText = (module) =>
    `#define module=${module}\n+PROG $(module)\n#include part.dat\nEND\n`;
  const expected = (version, module, title) => ({
    uri: model,
    version,
    text: `+PROG ${module}\nHEAD '${title}'\nEND\n`,
    complete: true,
    uncertainties: [],
  });
  client.open(part, "HEAD 'buffer'\n", 7);
  client.open(model, rootText("ASE"), 3);
  assert.deepEqual(await expand(model), expected(3, "ASE", "buffer"));

  client.change(part, [{ text: "HEAD 'changed buffer'\n" }], 8);
  assert.deepEqual(await expand(model), expected(3, "ASE", "changed buffer"));
  client.change(model, [{ text: rootText("AQUA") }], 4);
  assert.deepEqual(await expand(model), expected(4, "AQUA", "changed buffer"));
  client.notify("textDocument/didClose", { textDocument: { uri: part } });
  assert.deepEqual(await expand(model), expected(4, "AQUA", "disk"));
});

test("watched definition changes refresh expansion without changing the root version", async (t) => {
  const { root, uri, client, expand } = await fixture(t, {
    "sofistik.def": DEFINITION + "ACTIVE=0\n",
  });
  const model = uri("model.dat");
  client.open(model, "#if $(ACTIVE)\n+PROG ASE\nEND\n#endif\n");
  assert.deepEqual(await expand(model), {
    uri: model,
    version: 1,
    text: "",
    complete: true,
    uncertainties: [],
  });
  await fs.writeFile(path.join(root, "sofistik.def"), DEFINITION + "ACTIVE=1\n");
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: uri("sofistik.def"), type: 2 }],
  });
  assert.deepEqual(await expand(model), {
    uri: model,
    version: 1,
    text: "+PROG ASE\nEND\n",
    complete: true,
    uncertainties: [],
  });
});

test("untitled buffers expand local macros with the linter's unsaved NAME and PROJECT defaults", async (t) => {
  const { client, expand } = await fixture(t);
  const uri = "untitled:preprocessor-fixture.dat";
  client.open(uri, "#define module=AQUA\n+PROG $(module)\nHEAD '$(NAME) $(PROJECT)'\nEND\n", 5);
  assert.deepEqual(await expand(uri), {
    uri,
    version: 5,
    text: "+PROG AQUA\nHEAD 'untitled untitled'\nEND\n",
    complete: true,
    uncertainties: [],
  });
});

test("partial expansion preserves preprocessor completeness and uncertainty offsets", async (t) => {
  const { uri, client, expand } = await fixture(t);
  const model = uri("model.dat");
  client.open(model, "+PROG ASE\n#include missing.dat\nEND\n");
  assert.deepEqual(await expand(model), {
    uri: model,
    version: 1,
    text: "+PROG ASE\nEND\n",
    complete: false,
    uncertainties: [{ start: 10, end: 10, kind: "include" }],
  });
});

test("expansion rejects missing arguments, unknown commands and documents that are not open", async (t) => {
  const { uri, client, expand } = await fixture(t, { "model.dat": "+PROG ASE\nEND\n" });
  const model = uri("model.dat");
  for (const args of [undefined, [], [{}], [{ uri: null }]]) {
    await assert.rejects(
      client.request("workspace/executeCommand", { command: COMMAND, arguments: args }),
      errorCode(-32602),
    );
  }
  await assert.rejects(
    client.request("workspace/executeCommand", {
      command: "sofistik.unknownCommand",
      arguments: [{ uri: model }],
    }),
    errorCode(-32602),
  );
  await assert.rejects(expand(model), errorCode(-32602));
  client.open(model, "+PROG ASE\nEND\n");
  assert.equal((await expand(model)).text, "+PROG ASE\nEND\n");
  client.notify("textDocument/didClose", { textDocument: { uri: model } });
  await assert.rejects(expand(model), errorCode(-32602));
});

test("an include changed during preprocessing rejects the stale expansion despite unchanged root version", async (t) => {
  const { uri, client, expand, barriers } = await fixture(t, {}, { blockInclude: true });
  const model = uri("model.dat");
  const part = uri("part.dat");
  client.open(part, "HEAD 'old'\n");
  client.open(model, "+PROG ASE\n#include part.dat\nEND\n");
  const rejected = assert.rejects(expand(model), errorCode(-32801));
  await waitForFile(barriers.entered);
  await waitForFile(barriers.waiting);
  client.change(part, [{ text: "HEAD 'new'\n" }], 2);
  await rejected;
  await fs.writeFile(barriers.release, "");
  assert.deepEqual(await expand(model), {
    uri: model,
    version: 1,
    text: "+PROG ASE\nHEAD 'new'\nEND\n",
    complete: true,
    uncertainties: [],
  });
});

test("cancelling an expansion request leaves the shared linter job usable", async (t) => {
  const { uri, client, expand, barriers } = await fixture(t, {}, { blockInclude: true });
  const model = uri("model.dat");
  client.open(uri("part.dat"), "HEAD 'shared'\n");
  client.open(model, "+PROG ASE\n#include part.dat\nEND\n");
  const cancellation = new CancellationTokenSource();
  t.after(() => cancellation.dispose());
  const rejected = assert.rejects(
    client.connection.sendRequest(
      "workspace/executeCommand",
      commandParams(model),
      cancellation.token,
    ),
    errorCode(-32800),
  );
  await waitForFile(barriers.entered);
  await waitForFile(barriers.waiting);
  cancellation.cancel();
  await rejected;
  await fs.writeFile(barriers.release, "");
  assert.deepEqual(await expand(model), {
    uri: model,
    version: 1,
    text: "+PROG ASE\nHEAD 'shared'\nEND\n",
    complete: true,
    uncertainties: [],
  });
});
