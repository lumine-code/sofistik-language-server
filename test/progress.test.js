const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { LspClient } = require("./lsp-client");

const SOURCE = "+PROG ASE\nGRP NO 1 VAL FULL\nEND\n";
const messages = (client) => client.notifications.filter(({ method }) => method === "$/progress");
const until = async (check) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Progress notification timed out.");
};

async function fixture(t, options = {}, bootstrap) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-progress-"));
  await fs.writeFile(path.join(root, "model.dat"), SOURCE);
  await fs.writeFile(path.join(root, "sofistik.def"), "SOF_VERSION = 2026\n");
  if (bootstrap) {
    options.entryPath = path.join(root, "server.js");
    const projectPath = path.resolve(__dirname, "../lib/project.js");
    const serverPath = path.resolve(__dirname, "../lib/server.js");
    await fs.writeFile(
      options.entryPath,
      `const { SofistikProject } = require(${JSON.stringify(projectPath)});\n${bootstrap}\nrequire(${JSON.stringify(serverPath)}).startServer();\n`,
    );
  }
  const client = new LspClient(root, options);
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, client, uri: pathToFileURL(path.join(root, "model.dat")).href };
}

async function finished(client) {
  return until(() => messages(client).some(({ params }) => params.value.kind === "end"));
}

test("indexing creates progress after initialized and reports file counts without percentages", async (t) => {
  const { root, client } = await fixture(t, { workDoneProgress: true, autoInitialized: false });
  await fs.writeFile(path.join(root, "second.dat"), SOURCE);
  await client.start();
  assert.deepEqual(client.progressRequests, []);
  assert.deepEqual(messages(client), []);
  client.notify("initialized", {});
  await client.request("workspace/symbol", { query: "" });
  await finished(client);
  assert.equal(client.progressRequests.length, 1);
  const token = client.progressRequests[0].token;
  const progress = messages(client).map(({ params }) => {
    assert.equal(params.token, token);
    assert.equal(params.value.percentage, undefined);
    return params.value;
  });
  assert.equal(progress[0].kind, "begin");
  assert.equal(progress[0].title, "Indexing CADINP project");
  assert.equal(progress[0].cancellable, false);
  assert.equal(progress.at(-2).message, "Indexed 2 files");
  assert.equal(progress.at(-1).kind, "end");
  assert.equal(progress.filter(({ kind }) => kind === "end").length, 1);
});

test("even an empty project begins and ends its indexing progress", async (t) => {
  const { root, client } = await fixture(t, { workDoneProgress: true });
  await fs.unlink(path.join(root, "model.dat"));
  await client.start();
  assert.deepEqual(await client.request("workspace/symbol", { query: "" }), []);
  await finished(client);
  assert.deepEqual(
    messages(client).map(({ params }) => params.value.kind),
    ["begin", "report", "end"],
  );
  assert.equal(messages(client)[1].params.value.message, "Indexed 0 files");
});

test("a client without progress support still receives indexed workspace symbols", async (t) => {
  const { client } = await fixture(t);
  await client.start();
  assert.ok((await client.request("workspace/symbol", { query: "" })).length);
  assert.deepEqual(client.progressRequests, []);
  assert.deepEqual(messages(client), []);
});

test("a rejected progress handshake cannot prevent workspace indexing", async (t) => {
  const { client } = await fixture(t, {
    workDoneProgress: true,
    onCreateProgress: () => {
      throw new Error("Progress unavailable");
    },
  });
  await client.start();
  assert.ok((await client.request("workspace/symbol", { query: "" })).length);
  assert.equal(client.progressRequests.length, 1);
  assert.deepEqual(messages(client), []);
});

test("open-buffer completion does not wait for the progress creation round trip", async (t) => {
  let release;
  const handshake = new Promise((resolve) => {
    release = resolve;
  });
  const { client, uri } = await fixture(t, {
    workDoneProgress: true,
    onCreateProgress: () => handshake,
  });
  await client.start();
  await until(() => client.progressRequests.length);
  client.open(uri, SOURCE);
  const completion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character: 13 },
  });
  assert.ok(completion.some(({ label }) => label === "FULL"));
  assert.deepEqual(messages(client), []);
  release(null);
  await client.request("workspace/symbol", { query: "" });
  await finished(client);
});

test("an unanswered progress handshake times out without blocking indexing or reviving late progress", async (t) => {
  let release;
  const handshake = new Promise((resolve) => {
    release = resolve;
  });
  const { client } = await fixture(t, {
    workDoneProgress: true,
    onCreateProgress: () => handshake,
  });
  await client.start();
  await until(() => client.progressRequests.length);
  assert.ok((await client.request("workspace/symbol", { query: "" })).length);
  assert.ok(
    client.notifications.some(
      ({ method, params }) =>
        method === "window/logMessage" &&
        /within 2 seconds; indexing will continue/.test(params.message),
    ),
  );
  assert.deepEqual(messages(client), []);
  release(null);
  // The reply is sent before this request, so its response orders any late
  // continuation without assuming how long either process needs to run.
  assert.ok((await client.request("workspace/symbol", { query: "" })).length);
  assert.equal(client.progressRequests.length, 1);
  assert.deepEqual(messages(client), []);
});

test("shutdown closes active indexing progress before answering", async (t) => {
  const { client, uri } = await fixture(
    t,
    { workDoneProgress: true },
    "SofistikProject.prototype.scanDirectory = async () => new Promise(() => {});",
  );
  await client.start();
  await until(() => messages(client).some(({ params }) => params.value.kind === "begin"));
  client.open(uri, SOURCE);
  const completion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character: 13 },
  });
  assert.ok(completion.some(({ label }) => label === "FULL"));
  assert.equal(
    messages(client).some(({ params }) => params.value.kind === "end"),
    false,
  );
  await client.request("shutdown");
  assert.equal(messages(client).at(-1).params.value.kind, "end");
  assert.equal(messages(client).filter(({ params }) => params.value.kind === "end").length, 1);
});

test("a progress creation reply after shutdown never begins a stale task", async (t) => {
  let release;
  const handshake = new Promise((resolve) => {
    release = resolve;
  });
  const { client } = await fixture(t, {
    workDoneProgress: true,
    onCreateProgress: () => handshake,
  });
  await client.start();
  await until(() => client.progressRequests.length);
  await client.request("shutdown");
  release(null);
  // A subsequent shutdown response also orders the preceding handshake reply
  // through the server's connection, without an arbitrary timing assumption.
  await client.request("shutdown");
  assert.deepEqual(messages(client), []);
});

test("indexing errors end progress while open-document completion remains usable", async (t) => {
  const { client, uri } = await fixture(
    t,
    { workDoneProgress: true },
    'SofistikProject.prototype.scanDirectory = async () => { throw new Error("Index fixture failure"); };',
  );
  await client.start();
  await finished(client);
  assert.ok(
    client.notifications.some(
      ({ method, params }) =>
        method === "window/logMessage" && /Index fixture failure/.test(params.message),
    ),
  );
  client.open(uri, SOURCE);
  const completion = await client.request("textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character: 13 },
  });
  assert.ok(completion.some(({ label }) => label === "FULL"));
  assert.equal(messages(client).filter(({ params }) => params.value.kind === "end").length, 1);
});
