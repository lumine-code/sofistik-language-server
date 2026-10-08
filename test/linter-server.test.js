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

async function barrier(filePath, predicate = () => true) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (predicate(value)) return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected analysis barrier ${path.basename(filePath)} did not arrive.`);
}

const pushesSince = (client, offset, uri) =>
  client.notifications
    .slice(offset)
    .filter(
      ({ method, params }) => method === "textDocument/publishDiagnostics" && params.uri === uri,
    )
    .map(({ params }) => params);

async function fixture(t, files = {}, { blockAnalysis = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-live-linter-"));
  for (const [name, text] of Object.entries({
    "sofistik.def": "SOF_VERSION=2026\nSOF_LANGUAGE=EN\n",
    ...files,
  })) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text);
  }
  const gates = Object.fromEntries(
    blockAnalysis.map((name) => [
      name,
      Object.fromEntries(
        ["enabled", "entered", "release", "accepted", "pulling"].map((state) => [
          state,
          path.join(root, `${name}.${state}`),
        ]),
      ),
    ]),
  );
  let entryPath;
  if (blockAnalysis.length) {
    entryPath = path.join(root, "server.cjs");
    await fs.writeFile(
      entryPath,
      `const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { AnalysisService } = require(${JSON.stringify(path.resolve(__dirname, "../lib/analysis-service"))});
const gates = ${JSON.stringify(gates)};
const gateFor = (uri) => gates[path.basename(fileURLToPath(uri))];
const defines = AnalysisService.prototype.defines;
AnalysisService.prototype.defines = async function(job) {
  const result = await defines.call(this, job);
  const gate = gateFor(job.uri);
  if (gate && fs.existsSync(gate.enabled)) {
    fs.writeFileSync(gate.entered, JSON.stringify({ version: job.version, id: job.id }));
    while (!job.cancelled && !this.stopped && !fs.existsSync(gate.release))
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return result;
};
const finish = AnalysisService.prototype.finish;
AnalysisService.prototype.finish = function(message) {
  const job = this.active;
  finish.call(this, message);
  const gate = job && gateFor(job.uri);
  if (gate && message.type === "result" && this.results.get(job.uri)?.snapshot === job.snapshot)
    fs.writeFileSync(gate.accepted, JSON.stringify({ version: job.version, id: job.id }));
};
const waitDiagnostics = AnalysisService.prototype.waitDiagnostics;
AnalysisService.prototype.waitDiagnostics = function(uri, token) {
  const pending = waitDiagnostics.call(this, uri, token);
  const gate = gateFor(uri);
  if (gate) fs.writeFileSync(gate.pulling, JSON.stringify({ pending: true }));
  return pending;
};
require(${JSON.stringify(path.resolve(__dirname, "../lib/server"))}).startServer();
`,
    );
  }
  const client = new LspClient(root, { entryPath });
  t.after(async () => {
    for (const gate of Object.values(gates)) await fs.writeFile(gate.release, "");
    await client.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await client.start();
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const diagnostics = (name) =>
    client.request("textDocument/diagnostic", { textDocument: { uri: uri(name) } });
  return { root, uri, client, diagnostics, gates };
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
  assert.equal(issue.range.start.line, 1);
  assert.equal(issue.relatedInformation, undefined);
  assert.equal(issue.data.programAnchor.range.start.line, 0);
  assert.equal(issue.data.focusOrigin.range.start.line, 1);
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
  assert.ok(performance.now() - start >= 75, "pull must preserve the server's quiet period");
  assert.deepEqual(lint(current.items), []);
  const changedPushes = client.notifications.filter(
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" && item.uri === model && item.version === 2,
  );
  assert.ok(changedPushes.length);
  assert.ok(changedPushes.every(({ params: item }) => lint(item.diagnostics).length === 0));
  assert.deepEqual((await diagnostics("model.dat")).items, current.items);
});

test("unrelated typing retains published findings and a correction clears only after analysis", async (t) => {
  const { uri, client, diagnostics, gates } = await fixture(
    t,
    {},
    { blockAnalysis: ["model.dat"] },
  );
  const model = uri("model.dat");
  const gate = gates["model.dat"];
  client.open(model, BAD);
  const initial = lint((await diagnostics("model.dat")).items);
  assert.ok(initial.some((item) => item.code === codeFor("variable-before-declaration")));
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === model &&
      lint(params.diagnostics).length,
  );

  await fs.writeFile(gate.enabled, "");
  await fs.rm(gate.pulling, { force: true });
  const offset = client.notifications.length;
  client.change(model, [{ text: BAD.replace("GRP NO #size", "GRP NO 2") }], 2);
  await barrier(gate.entered, ({ version }) => version === 2);
  let settled = false;
  const pending = diagnostics("model.dat").then((report) => {
    settled = true;
    return report;
  });
  await barrier(gate.pulling);
  const completion = await client.request("textDocument/completion", params(model, 2, 13));
  assert.ok(completion.some((item) => item.label === "FULL"));
  assert.equal(settled, false);
  assert.deepEqual(
    pushesSince(client, offset, model),
    [],
    "typing must retain the previous client report",
  );
  await fs.writeFile(gate.release, "");
  assert.deepEqual(lint((await pending).items), initial);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" && params.uri === model && params.version === 2,
  );
  assert.ok(pushesSince(client, offset, model).every((item) => lint(item.diagnostics).length));

  await fs.rm(gate.release);
  await fs.rm(gate.pulling, { force: true });
  const correctionOffset = client.notifications.length;
  client.change(model, [{ text: GOOD }], 3);
  await barrier(gate.entered, ({ version }) => version === 3);
  const corrected = diagnostics("model.dat");
  await barrier(gate.pulling);
  assert.deepEqual(
    pushesSince(client, correctionOffset, model),
    [],
    "a pending correction must not clear eagerly",
  );
  await fs.writeFile(gate.release, "");
  assert.deepEqual(lint((await corrected).items), []);
  const cleared = await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" && params.uri === model && params.version === 3,
  );
  assert.deepEqual(cleared.diagnostics, []);
});

test("rapid edits publish only the final version and its current diagnostic positions", async (t) => {
  const { uri, client, diagnostics, gates } = await fixture(
    t,
    {},
    { blockAnalysis: ["model.dat"] },
  );
  const model = uri("model.dat");
  const gate = gates["model.dat"];
  client.open(model, BAD);
  await diagnostics("model.dat");
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === model &&
      lint(params.diagnostics).length,
  );
  await fs.writeFile(gate.enabled, "");
  const offset = client.notifications.length;
  client.change(model, [{ text: "\n" + BAD }], 2);
  await barrier(gate.entered, ({ version }) => version === 2);
  client.change(model, [{ text: "\n\n" + BAD }], 3);
  client.change(model, [{ text: "\n\n\n" + BAD }], 4);
  await barrier(gate.entered, ({ version }) => version === 4);
  assert.deepEqual(pushesSince(client, offset, model), []);
  const pending = diagnostics("model.dat");
  await fs.writeFile(gate.release, "");
  const current = lint((await pending).items);
  assert.ok(current.length);
  assert.equal(current[0].range.start.line, 4);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" && params.uri === model && params.version === 4,
  );
  const pushes = pushesSince(client, offset, model);
  assert.ok(pushes.length);
  assert.ok(pushes.every((item) => item.version === 4));
  assert.ok(pushes.every((item) => lint(item.diagnostics)[0]?.range.start.line === 4));
});

test("removing an include publishes its empty related report only when the new root is ready", async (t) => {
  const { uri, client, diagnostics, gates } = await fixture(
    t,
    { "part.dat": BAD },
    { blockAnalysis: ["model.dat"] },
  );
  const model = uri("model.dat");
  const child = uri("part.dat");
  const gate = gates["model.dat"];
  client.open(model, '#INCLUDE "part.dat"\n');
  assert.ok(lint((await diagnostics("model.dat")).relatedDocuments[child].items).length);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      lint(params.diagnostics).length,
  );
  await fs.writeFile(gate.enabled, "");
  const offset = client.notifications.length;
  client.change(model, [{ text: GOOD }], 2);
  await barrier(gate.entered, ({ version }) => version === 2);
  const pending = diagnostics("model.dat");
  assert.deepEqual(pushesSince(client, offset, child), []);
  await fs.writeFile(gate.release, "");
  const report = await pending;
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.relatedDocuments[child].items, []);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      params.diagnostics.length === 0,
  );
  assert.deepEqual((await diagnostics("part.dat")).items, []);
});

test("shared include push and related pull wait until both affected roots have current results", async (t) => {
  const { root, uri, client, diagnostics, gates } = await fixture(
    t,
    { "shared.dat": BAD },
    { blockAnalysis: ["a.dat", "b.dat"] },
  );
  const first = uri("a.dat");
  const second = uri("b.dat");
  const child = uri("shared.dat");
  const includesBothCallers = (diagnostic) => {
    const callers = new Set(diagnostic.relatedInformation?.map(({ location }) => location.uri));
    return callers.has(first) && callers.has(second);
  };
  client.open(first, '#INCLUDE "shared.dat"\n');
  client.open(second, '#INCLUDE "shared.dat"\n');
  await diagnostics("a.dat");
  const initial = await diagnostics("b.dat");
  assert.ok(includesBothCallers(lint(initial.relatedDocuments[child].items)[0]));
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      includesBothCallers(lint(params.diagnostics)[0] || {}),
  );
  for (const gate of Object.values(gates)) {
    await fs.rm(gate.entered, { force: true });
    await fs.rm(gate.accepted, { force: true });
    await fs.rm(gate.pulling, { force: true });
    await fs.writeFile(gate.enabled, "");
  }
  const offset = client.notifications.length;
  await fs.writeFile(path.join(root, "shared.dat"), "\n" + BAD);
  client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: child, type: 2 }] });
  await barrier(gates["a.dat"].entered);
  let settled = false;
  const pending = diagnostics("a.dat").then((report) => {
    settled = true;
    return report;
  });
  await barrier(gates["a.dat"].pulling);
  await fs.writeFile(gates["a.dat"].release, "");
  await barrier(gates["a.dat"].accepted);
  await barrier(gates["b.dat"].entered);
  assert.equal(
    settled,
    false,
    "the first root's pull includes the second root's shared contribution",
  );
  assert.deepEqual(
    pushesSince(client, offset, child),
    [],
    "one ready root must not publish a partial shared report",
  );
  await fs.writeFile(gates["b.dat"].release, "");
  const current = lint((await pending).relatedDocuments[child].items);
  assert.equal(current.length, 1);
  assert.equal(current[0].range.start.line, 2);
  assert.ok(includesBothCallers(current[0]));
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      lint(params.diagnostics)[0]?.range.start.line === 2,
  );
  const pushes = pushesSince(client, offset, child);
  assert.ok(pushes.length);
  assert.ok(pushes.every((item) => lint(item.diagnostics).length === 1));
  assert.ok(pushes.every((item) => includesBothCallers(lint(item.diagnostics)[0])));
});

test("inline generator errors publish, match pull diagnostics and clear after correction", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const model = uri("model.dat");
  const increment = codeFor("inline-generator-increment");
  const unclosed = codeFor("unclosed-inline-generator");
  assert.equal(increment, "G311");
  assert.equal(unclosed, "G312");
  client.open(
    model,
    [
      "+PROG SOFILOAD",
      "LC (1 11 1) TITL (101 111)",
      "LC (1 11) TITL (101 111 1)",
      "LC (1 11 1) TITL (101 111 1)",
      "LC (1 11) TITL (101 111",
      "LC (1 11)",
      "END",
      "",
    ].join("\n"),
  );
  const first = await diagnostics("model.dat");
  const issues = lint(first.items);
  assert.ok(issues.some((item) => item.code === increment && item.range.start.line === 3));
  assert.ok(issues.some((item) => item.code === unclosed && item.range.start.line === 4));
  assert.ok(issues.some((item) => item.code === increment && item.range.start.line === 5));
  assert.ok(
    issues.every(
      (item) =>
        ![increment, unclosed].includes(item.code) || ![1, 2].includes(item.range.start.line),
    ),
  );
  const pushed = await notification(
    client,
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" &&
      item.uri === model &&
      item.version === 1 &&
      lint(item.diagnostics).some((issue) => issue.code === increment),
  );
  assert.deepEqual(lint(pushed.diagnostics), issues);

  client.change(
    model,
    [
      {
        text: [
          "+PROG SOFILOAD",
          "LC (1 11 1) TITL (101 111)",
          "LC (1 11) TITL (101 111 1)",
          "LC (1 11 1) TITL (101 111)",
          "LC (1 11) TITL (101 111 1)",
          "LC (1 11 1)",
          "END",
          "",
        ].join("\n"),
      },
    ],
    2,
  );
  const corrected = await diagnostics("model.dat");
  assert.deepEqual(lint(corrected.items), []);
  const cleared = await notification(
    client,
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" && item.uri === model && item.version === 2,
  );
  assert.deepEqual(lint(cleared.diagnostics), []);
});

test("a trailing list comma is diagnosed without losing the next SOFILOAD enum", async (t) => {
  const { uri, client, diagnostics } = await fixture(t);
  const model = uri("model.dat");
  const trailingComma = codeFor("trailing-comma");
  assert.equal(trailingComma, "G313");
  client.open(
    model,
    [
      "+PROG SOFILOAD",
      "LET#dT_N_exp 1",
      "LC 321 NONE TITL 'N-summer'",
      "LINE BGRP 11,21,31,41 TYPE DT +#dT_N_exp",
      "AREA QGRP 51, TYPE DTXY +#dT_N_exp",
      "END",
      "",
    ].join("\n"),
  );
  const assertTokens = async (areaTypeStart) => {
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/full", { textDocument: { uri: model } }),
      { data: [3, 5, 4, 0, 0, 0, 22, 2, 0, 0, 1, 5, 4, 0, 0, 0, areaTypeStart - 5, 4, 0, 0] },
    );
    assert.deepEqual(
      await client.request("textDocument/semanticTokens/range", {
        textDocument: { uri: model },
        range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } },
      }),
      { data: [4, 5, 4, 0, 0, 0, areaTypeStart - 5, 4, 0, 0] },
    );
  };
  const first = await diagnostics("model.dat");
  const issues = lint(first.items);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, trailingComma);
  assert.deepEqual(issues[0].range, {
    start: { line: 4, character: 12 },
    end: { line: 4, character: 13 },
  });
  await assertTokens(19);
  const pushed = await notification(
    client,
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" &&
      item.uri === model &&
      item.version === 1 &&
      lint(item.diagnostics).some((issue) => issue.code === trailingComma),
  );
  assert.deepEqual(lint(pushed.diagnostics), issues);

  client.change(model, [{ range: issues[0].range, text: "" }], 2);
  const corrected = await diagnostics("model.dat");
  assert.deepEqual(lint(corrected.items), []);
  await assertTokens(18);
  const cleared = await notification(
    client,
    ({ method, params: item }) =>
      method === "textDocument/publishDiagnostics" && item.uri === model && item.version === 2,
  );
  assert.deepEqual(lint(cleared.diagnostics), []);
});

test("a program expanded from a macro reports at its invocation and relates its offending record", async (t) => {
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
  assert.equal(issue.data.programAnchor.range.start.line, 1);
  assert.equal(
    issue.relatedInformation.some(({ location }) => location.range.start.line === 1),
    false,
  );
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
  assert.equal(issue.range.start.line, 2);
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

test("watched Ruff-style NOQA changes alter linter exclusions without changing the release", async (t) => {
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
  assert.equal(lint(report.items)[0].range.start.line, 10);
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
  assert.equal(issues[0].range.start.line, 2);
  assert.equal(issues[0].data.focusOrigin.range.start.line, 2);
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
  const changedReport = await diagnostics("model.dat");
  const changed = lint(changedReport.relatedDocuments?.[pathToFileURL(local).href]?.items || []);
  assert.ok(changed.some((item) => item.code === codeFor("load-without-load-case")));
  assert.ok(changed.some((item) => item.data.focusOrigin.uri === pathToFileURL(local).href));
});

test("ordinary included findings publish at their source and appear in related pull reports", async (t) => {
  const { uri, client, diagnostics } = await fixture(t, { "part.dat": BAD });
  const root = uri("model.dat");
  const child = uri("part.dat");
  client.open(root, '#INCLUDE "part.dat"\n');
  const report = await diagnostics("model.dat");
  assert.deepEqual(lint(report.items), []);
  const childIssues = lint(report.relatedDocuments[child].items);
  assert.equal(childIssues.length, 1);
  assert.equal(childIssues[0].range.start.line, 1);
  assert.equal(Object.hasOwn(childIssues[0], "uri"), false);
  const push = await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      lint(params.diagnostics).length > 0,
  );
  assert.equal(push.version, null);
  assert.deepEqual(lint(push.diagnostics), childIssues);
  assert.deepEqual(lint((await diagnostics("part.dat")).items), childIssues);

  client.change(root, [{ text: GOOD }], 2);
  const removed = await diagnostics("model.dat");
  assert.deepEqual(removed.relatedDocuments[child].items, []);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      params.diagnostics.length === 0,
  );
  assert.deepEqual((await diagnostics("part.dat")).items, []);
});

test("shared include reports remain after closing one root and clear after the last closes", async (t) => {
  const { uri, client, diagnostics } = await fixture(t, { "shared.dat": BAD });
  const child = uri("shared.dat");
  const first = uri("a.dat");
  const second = uri("b.dat");
  client.open(first, '#INCLUDE "shared.dat"\n');
  client.open(second, '#INCLUDE "shared.dat"\n');
  await diagnostics("a.dat");
  await diagnostics("b.dat");
  assert.equal(lint((await diagnostics("shared.dat")).items).length, 1);
  client.notify("textDocument/didClose", { textDocument: { uri: first } });
  assert.equal(lint((await diagnostics("b.dat")).relatedDocuments[child].items).length, 1);
  client.notify("textDocument/didClose", { textDocument: { uri: second } });
  const closed = await diagnostics("b.dat");
  assert.deepEqual(closed.items, []);
  assert.equal(closed.relatedDocuments, undefined);
  await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      params.diagnostics.length === 0,
  );
  assert.deepEqual((await diagnostics("shared.dat")).items, []);
});

test("an opened fragment keeps caller variables uncertain and receives contextual source findings", async (t) => {
  const fragment = `LET#x #caller\n${LOAD}`;
  const { uri, client, diagnostics } = await fixture(t, { "part.inc": fragment });
  const child = uri("part.inc");
  client.open(child, fragment, 4);
  client.open(uri("model.dat"), '+PROG SOFILOAD\nLET#caller 1\n#INCLUDE "part.inc"\nEND\n');
  const rootReport = await diagnostics("model.dat");
  const included = lint(rootReport.relatedDocuments[child].items);
  assert.deepEqual(
    included.map((item) => item.code),
    [codeFor("load-without-load-case")],
  );
  assert.equal(included[0].range.start.line, 1);
  const childReport = lint((await diagnostics("part.inc")).items);
  assert.deepEqual(
    childReport.map((item) => item.code),
    [codeFor("load-without-load-case")],
  );
  const push = await notification(
    client,
    ({ method, params }) =>
      method === "textDocument/publishDiagnostics" &&
      params.uri === child &&
      lint(params.diagnostics).length > 0,
  );
  assert.equal(push.version, 4);
});

test("an opened include uses caller macros and restores its standalone report after closing the caller", async (t) => {
  const childSource = "+PROG ASE\nLET#a $(caller)\nEND\n";
  const { uri, client, diagnostics } = await fixture(t, { "child.inc": childSource });
  const child = uri("child.inc");
  const parent = uri("main.dat");
  client.open(child, childSource);
  assert.ok(
    (await diagnostics("child.inc")).items.some((item) => item.code === codeFor("undefined-macro")),
  );
  client.open(parent, '#DEFINE caller=1\n#INCLUDE "child.inc"\n');
  assert.deepEqual((await diagnostics("main.dat")).relatedDocuments[child].items, []);
  assert.deepEqual((await diagnostics("child.inc")).items, []);
  client.notify("textDocument/didClose", { textDocument: { uri: parent } });
  assert.ok(
    (await diagnostics("child.inc")).items.some((item) => item.code === codeFor("undefined-macro")),
  );
  client.open(parent, '#DEFINE caller=1\n#INCLUDE "child.inc"\n', 2);
  assert.deepEqual((await diagnostics("main.dat")).relatedDocuments[child].items, []);
  assert.deepEqual((await diagnostics("child.inc")).items, []);
});
