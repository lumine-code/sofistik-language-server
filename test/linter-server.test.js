"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { codeFor } = require("../lib/lint-codes");
const { LspClient } = require("./lsp-client");

const BAD = "+PROG ASE\nLET#size #missing\nGRP NO #size VAL FULL\nEND\n";
const GOOD = "+PROG ASE\nLET#missing 1\nLET#size #missing\nGRP NO #size VAL FULL\nEND\n";
const LOAD = "LINE REF SLN NO 12 TYPE PZZ P1 5\n";
const params = (uri, line, character) => ({ textDocument: { uri }, position: { line, character } });
const lint = (items) => items.filter((item) => item.source === "sofistik-linter");

async function notification(client, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = client.notifications.find(predicate);
    if (result) return result.params;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected server notification did not arrive.");
}

async function fixture(t, files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-live-linter-"));
  for (const [name, text] of Object.entries({
    "sofistik.def": "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n",
    ...files,
  })) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);
  }
  const client = new LspClient(root);
  t.after(async () => {
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await client.start();
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const diagnostics = (name) =>
    client.request("textDocument/diagnostic", { textDocument: { uri: uri(name) } });
  return { root, uri, client, diagnostics };
}

test("real server shares debounced diagnostics with pull while completion stays available", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const model = uri("model.dat");
  client.open(model, BAD);
  const first = await diagnostics("model.dat");
  const issue = lint(first.items).find(
    (item) => item.code === codeFor("variable-before-declaration"),
  );
  assert.ok(issue);
  assert.equal(issue.range.start.line, 0);
  assert.equal(issue.relatedInformation.at(-1).location.range.start.line, 1);
  const pushed = await notification(
    client,
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" &&
      item.uri === model &&
      lint(item.diagnostics).length > 0,
  );
  assert.equal(pushed.version, 1);
  assert.deepEqual(lint(pushed.diagnostics), lint(first.items));

  client.change(model, [{ text: GOOD }], 2);
  const start = performance.now();
  const pending = diagnostics("model.dat");
  const completion = client.request("textDocument/completion", params(model, 3, 17));
  const firstResponse = await Promise.race([
    pending.then(() => "diagnostics"),
    completion.then(() => "completion"),
  ]);
  assert.equal(
    firstResponse,
    "completion",
    "the server mutation queue must not wait for background lint",
  );
  assert.ok((await completion).some((item) => item.label === "FULL"));
  const current = await pending;
  assert.ok(performance.now() - start >= 200, "pull must preserve the server's quiet period");
  assert.deepEqual(lint(current.items), []);
  const changedPushes = client.notifications.filter(
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" && item.uri === model && item.version === 2,
  );
  assert.ok(changedPushes.length);
  assert.ok(changedPushes.every(({ params: item }) => lint(item.diagnostics).length === 0));
  assert.deepEqual((await diagnostics("model.dat")).items, current.items);
});

test("a program expanded from a macro reports at its invocation and retains its original header", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const source = [
    "#DEFINE block",
    "+PROG SOFILOAD",
    LOAD.trimEnd(),
    "END",
    "#ENDDEF",
    "#INCLUDE block",
    "",
  ].join("\n");
  client.open(uri("model.dat"), source);
  const report = await diagnostics("model.dat");
  const issue = lint(report.items).find((item) => item.code === codeFor("load-without-load-case"));
  assert.ok(issue);
  assert.equal(issue.range.start.line, 5);
  assert.ok(issue.relatedInformation.some(({ location }) => location.range.start.line === 1));
  assert.ok(issue.relatedInformation.some(({ location }) => location.range.start.line === 2));
});

test("editing and closing an unsaved include reanalyzes the parent using the current source", async (t) => {
  const { uri, client, diagnostics } = await fixture(t, { "loads.dat": "LC 1\n" });
  const model = uri("model.dat");
  const included = uri("loads.dat");
  client.open(included, "LC 1\n");
  client.open(model, `+PROG SOFILOAD\n#INCLUDE "loads.dat"\n${LOAD}END\n`);
  assert.deepEqual(lint((await diagnostics("model.dat")).items), []);

  client.change(included, [{ text: "HEAD 'unsaved input without LC'\n" }], 2);
  const changed = await diagnostics("model.dat");
  const issue = lint(changed.items).find((item) => item.code === codeFor("load-without-load-case"));
  assert.ok(issue);
  assert.equal(issue.range.start.line, 0);
  client.notify("textDocument/didClose", { textDocument: { uri: included } });
  assert.deepEqual(lint((await diagnostics("model.dat")).items), []);
});

test("watched creation of a missing include clears the parent preprocessing problem", async (t) => {
  const { root, uri, client, diagnostics } = await fixture(t);
  client.open(uri("model.dat"), `+PROG SOFILOAD\n#INCLUDE "new.dat"\n${LOAD}END\n`);
  const missing = await diagnostics("model.dat");
  assert.ok(missing.items.some((item) => item.code === codeFor("missing-include")));
  await fs.writeFile(path.join(root, "new.dat"), "LC 1\n");
  client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: uri("new.dat"), type: 1 }] });
  const resolved = await diagnostics("model.dat");
  assert.deepEqual(resolved.items, []);
});

test("watched sofistik.def macro changes reanalyze programs without an environment change", async (t) => {
  const definition = "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n";
  const { root, uri, client, diagnostics } = await fixture(t, {
    "sofistik.def": definition + "ACTIVE=0\n",
  });
  client.open(uri("model.dat"), `#IF $(ACTIVE)\n${BAD}#ENDIF\n`);
  assert.deepEqual(lint((await diagnostics("model.dat")).items), []);
  await fs.writeFile(path.join(root, "sofistik.def"), definition + "ACTIVE=1\n");
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: uri("sofistik.def"), type: 2 }],
  });
  const active = await diagnostics("model.dat");
  assert.ok(
    lint(active.items).some((item) => item.code === codeFor("variable-before-declaration")),
  );
});

test("watched numeric NOQA changes alter linter exclusions without changing the release", async (t) => {
  const definition = "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n";
  const variable = codeFor("variable-before-declaration");
  const load = codeFor("load-without-load-case");
  const { root, uri, client, diagnostics } = await fixture(t, {
    "sofistik.def": definition + `NOQA=${variable}\n`,
  });
  client.open(uri("model.dat"), `${BAD}+PROG SOFILOAD\n${LOAD}END\n`);
  const first = await diagnostics("model.dat");
  assert.deepEqual(
    lint(first.items).map((item) => item.code),
    [load],
  );
  await fs.writeFile(path.join(root, "sofistik.def"), definition + `NOQA=${load}\n`);
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: uri("sofistik.def"), type: 2 }],
  });
  const second = await diagnostics("model.dat");
  assert.deepEqual(
    lint(second.items).map((item) => item.code),
    [variable],
  );
});

test("closing an entry during its quiet period clears reports and does not revive the document", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const model = uri("model.dat");
  client.open(model, GOOD);
  assert.deepEqual((await diagnostics("model.dat")).items, []);
  client.change(model, [{ text: BAD }], 2);
  client.notify("textDocument/didClose", { textDocument: { uri: model } });
  assert.deepEqual((await diagnostics("model.dat")).items, []);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const closedPushes = client.notifications
    .filter(
      ({ method, params: item }) =>
        method === "textDocument/publishDiagnostics" && item.uri === model,
    )
    .map(({ params: item }) => item);
  assert.deepEqual(closedPushes.at(-1).diagnostics, []);
  assert.ok(closedPushes.every((item) => lint(item.diagnostics).length === 0));
});

test("sofistik.def comments do not contribute ignored codes or make FLAG=0 true", async (t) => {
  const variable = codeFor("variable-before-declaration");
  const load = codeFor("load-without-load-case");
  const { uri, client, diagnostics } = await fixture(t, {
    "sofistik.def": `SOF_VERSION=2026\nSOF_LANGUAGE=EN\nNOQA=${variable} $ explanation ${load}\nFLAG=0 ! explanation\n`,
  });
  client.open(
    uri("model.dat"),
    `${BAD}#IF $(FLAG)\n+PROG SOFILOAD\n${LOAD}END\n#ENDIF\n+PROG SOFILOAD\n${LOAD}END\n`,
  );
  const report = await diagnostics("model.dat");
  assert.deepEqual(
    lint(report.items).map((item) => item.code),
    [load],
  );
  assert.equal(lint(report.items)[0].range.start.line, 9);
});

test("a line-level noqa for a missing variable does not hide its next use", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const variable = codeFor("variable-before-declaration");
  const source = `+PROG ASE\nLET#first #missing ! noqa: ${variable}\nLET#second #missing\nEND\n`;
  client.open(uri("model.dat"), source);
  const report = await diagnostics("model.dat");
  const issues = lint(report.items);
  assert.deepEqual(
    issues.map((item) => item.code),
    [variable],
  );
  assert.equal(issues[0].range.start.line, 0);
  assert.equal(issues[0].relatedInformation.at(-1).location.range.start.line, 2);
});

test("dependency watches cover Unicode txt includes and missing inputs outside the workspace", async (t) => {
  const { root, uri, client, diagnostics } = await fixture(t, {
    "obciążenia ą😀.txt": "HEAD 'local include'\n",
  });
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-external-include-"));
  t.after(async () => {
    assert.equal(path.dirname(externalRoot), os.tmpdir());
    await fs.rm(externalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const external = path.join(externalRoot, "brakujące ą😀.txt");
  const local = path.join(root, "obciążenia ą😀.txt");
  const expected = new Set([local, external].map((filePath) => filePath.replaceAll("\\", "/")));
  const watched = new Map();
  let resolveWatches;
  const watchReady = new Promise((resolve) => {
    resolveWatches = resolve;
  });
  client.connection.onRequest("client/registerCapability", ({ registrations }) => {
    for (const registration of registrations) {
      if (registration.method !== "workspace/didChangeWatchedFiles") continue;
      for (const watcher of registration.registerOptions.watchers) {
        if (typeof watcher.globPattern === "string") watched.set(watcher.globPattern, watcher.kind);
      }
    }
    if ([...expected].every((filePath) => watched.has(filePath))) resolveWatches();
    return null;
  });
  client.open(
    uri("model.dat"),
    `+PROG SOFILOAD\n#INCLUDE "obciążenia ą😀.txt"\n#INCLUDE "${external}"\n${LOAD}END\n`,
  );
  const missing = await diagnostics("model.dat");
  assert.ok(missing.items.some((item) => item.code === codeFor("missing-include")));
  let timer;
  try {
    await Promise.race([
      watchReady,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Exact include watches were not registered.")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok([...expected].every((filePath) => watched.get(filePath) === 7));
  await fs.writeFile(external, "LC 1\n");
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: pathToFileURL(external).href, type: 1 }],
  });
  assert.deepEqual((await diagnostics("model.dat")).items, []);

  await fs.writeFile(local, LOAD);
  client.notify("workspace/didChangeWatchedFiles", {
    changes: [{ uri: pathToFileURL(local).href, type: 2 }],
  });
  const changed = lint((await diagnostics("model.dat")).items);
  assert.ok(changed.some((item) => item.code === codeFor("load-without-load-case")));
  assert.ok(
    changed.some((item) =>
      item.relatedInformation.some(({ location }) => location.uri === pathToFileURL(local).href),
    ),
  );
});
