"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { LintService } = require("../lib/lint-service");
const { codeFor } = require("../lib/lint-codes");

const GOOD = "+PROG ASE\nLET#size 1\nEND\n";
const BAD = "+PROG ASE\nLET#size #missing\nEND\n";
const LOAD = "LINE REF SLN NO 12 TYPE PZZ P1 5\n";
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-lint-service-"));
  const uri = (name) => pathToFileURL(path.join(root, name)).href;
  const disk = new Map();
  const reads = [];
  const published = [];
  const errors = [];
  const project = {
    documents: new Map(),
    documentEpochs: new Map(),
    skippedInputs: new Set(),
    settings: { encoding: "utf-8" },
    async readInput(sourceUri) {
      reads.push(sourceUri);
      return disk.get(sourceUri) ?? null;
    },
  };
  const touch = (sourceUri) =>
    project.documentEpochs.set(sourceUri, (project.documentEpochs.get(sourceUri) || 0) + 1);
  const open = (name, text) => {
    const sourceUri = uri(name);
    const entry = {
      uri: sourceUri,
      text,
      version: 1,
      open: true,
      target: { version: "2026", language: "en" },
    };
    project.documents.set(sourceUri, entry);
    touch(sourceUri);
    return entry;
  };
  const change = (entry, text) => {
    entry.text = text;
    entry.version++;
    touch(entry.uri);
  };
  const service = new LintService(project, {
    ...options,
    onResult: (sourceUri) => published.push(sourceUri),
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    await service.dispose();
    assert.deepEqual(errors, []);
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, uri, project, disk, reads, published, errors, touch, open, change, service };
}

test("pull waits for the server debounce and rapid edits replace the pending analysis", async (t) => {
  const { open, change, service, published } = await fixture(t, { delay: 160 });
  const entry = open("model.dat", BAD);
  const first = service.schedule(entry.uri);
  let pullSettled = false;
  const obsoletePull = service.wait(entry.uri).then((result) => {
    pullSettled = true;
    return result;
  });
  await pause(40);
  assert.equal(pullSettled, false, "a pull request must not bypass the server quiet period");
  assert.deepEqual(published, []);

  change(entry, GOOD);
  const start = performance.now();
  service.changed(entry.uri);
  assert.equal(await first, null);
  assert.equal(await obsoletePull, null);
  const latest = await bounded(service.wait(entry.uri), "debounced analysis");
  assert.ok(performance.now() - start >= 120, "replacement must retain its own quiet period");
  assert.equal(latest.version, entry.version);
  assert.deepEqual(latest.diagnostics, []);
  assert.deepEqual(published, [entry.uri]);
  assert.equal(await service.wait(entry.uri), latest, "another pull reuses the accepted result");
  assert.deepEqual(published, [entry.uri]);
});

test("a persistent worker reuses unchanged modules and remaps their diagnostics", async (t) => {
  const { open, change, service, published } = await fixture(t);
  const entry = open("model.dat", BAD);
  await service.schedule(entry.uri, { immediate: true });
  const first = await bounded(service.wait(entry.uri), "initial analysis");
  const worker = service.worker;
  const issue = first.diagnostics.find(
    (item) => item.code === codeFor("variable-before-declaration"),
  );
  assert.ok(issue);
  assert.equal(issue.source, "sofistik-linter");
  assert.equal(issue.range.start.line, 0);
  assert.equal(issue.relatedInformation.at(-1).location.range.start.line, 1);

  change(entry, "\n" + BAD);
  assert.deepEqual(service.cached(entry.uri), [], "a changed snapshot cannot reuse old positions");
  service.changed(entry.uri, { immediate: true });
  const second = await bounded(service.wait(entry.uri), "remapped analysis");
  assert.equal(service.worker, worker);
  assert.ok(second.metrics.reusedModules > 0);
  assert.equal(second.diagnostics[0].range.start.line, 1);
  assert.equal(second.diagnostics[0].relatedInformation.at(-1).location.range.start.line, 2);
  assert.equal(await service.wait(entry.uri), second);
  assert.deepEqual(published, [entry.uri, entry.uri]);
});

test("unsaved include buffers take precedence and only dependent roots are invalidated", async (t) => {
  const { uri, disk, reads, open, change, service } = await fixture(t, { delay: 30 });
  disk.set(uri("loads.dat"), "HEAD 'disk copy has no LC'\n");
  const included = open("loads.dat", "LC 1\n");
  const parent = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "loads.dat"\n${LOAD}END\n`);
  const unrelated = open("other.dat", GOOD);
  service.schedule(parent.uri, { immediate: true });
  service.schedule(unrelated.uri, { immediate: true });
  const initial = await bounded(service.wait(parent.uri), "open-buffer include analysis");
  const independent = await bounded(service.wait(unrelated.uri), "unrelated analysis");
  assert.deepEqual(initial.diagnostics, []);
  assert.ok(initial.dependencies.includes(included.uri));
  assert.equal(reads.includes(included.uri), false);

  change(included, "HEAD 'buffer has no LC'\n");
  const affected = service.changed(included.uri);
  assert.ok(affected.includes(parent.uri));
  assert.equal(affected.includes(unrelated.uri), false);
  assert.equal(await service.wait(unrelated.uri), independent);
  const updated = await bounded(service.wait(parent.uri), "dependent-root analysis");
  const issue = updated.diagnostics.find((item) => item.code === codeFor("load-without-load-case"));
  assert.ok(issue);
  assert.equal(issue.range.start.line, 0);
});

test("creating a previously missing include schedules its dependent root", async (t) => {
  const { uri, disk, open, service, touch } = await fixture(t, { delay: 25 });
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "new.dat"\n${LOAD}END\n`);
  service.schedule(entry.uri, { immediate: true });
  const missing = await bounded(service.wait(entry.uri), "missing include analysis");
  assert.ok(missing.diagnostics.some((item) => item.code === codeFor("missing-include")));

  disk.set(uri("new.dat"), "LC 1\n");
  touch(uri("new.dat"));
  assert.ok(service.changed(uri("new.dat")).includes(entry.uri));
  const resolved = await bounded(service.wait(entry.uri), "created include analysis");
  assert.deepEqual(resolved.diagnostics, []);
});

test("a source changing during an include read cannot publish a stale result", async (t) => {
  const { uri, project, open, service, published, touch } = await fixture(t);
  const requested = deferred();
  const content = deferred();
  project.readInput = async (sourceUri) => {
    assert.equal(sourceUri, uri("slow.dat"));
    requested.resolve();
    return content.promise;
  };
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "slow.dat"\n${LOAD}END\n`);
  const first = service.schedule(entry.uri, { immediate: true });
  await bounded(requested.promise, "worker include request");
  touch(uri("slow.dat"));
  content.resolve("HEAD 'obsolete include'\n");
  assert.equal(await bounded(first, "discarded snapshot"), null);
  assert.deepEqual(published, []);
  assert.deepEqual(service.cached(entry.uri), []);

  project.readInput = async () => "LC 1\n";
  service.schedule(entry.uri, { immediate: true });
  const current = await bounded(service.wait(entry.uri), "current snapshot");
  assert.deepEqual(current.diagnostics, []);
  assert.deepEqual(published, [entry.uri]);
});

test("canceling one diagnostic pull leaves the shared background analysis running", async (t) => {
  const { open, service, published } = await fixture(t, { delay: 80 });
  const entry = open("model.dat", BAD);
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  service.schedule(entry.uri);
  const cancelledPull = service.wait(entry.uri, token);
  token.isCancellationRequested = true;
  for (const listener of listeners) listener();
  assert.equal(await cancelledPull, null);
  assert.equal(listeners.size, 0);
  const shared = await bounded(
    service.wait(entry.uri),
    "shared analysis after request cancellation",
  );
  assert.ok(shared.diagnostics.some((item) => item.source === "sofistik-linter"));
  assert.deepEqual(published, [entry.uri]);
});

test("closing a document forgets pending work and disposing terminates an active worker", async (t) => {
  const { uri, project, open, service, published, touch } = await fixture(t);
  const requested = deferred();
  const content = deferred();
  project.readInput = async () => {
    requested.resolve();
    return content.promise;
  };
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "slow.dat"\n${LOAD}END\n`);
  const pending = service.schedule(entry.uri, { immediate: true });
  await bounded(requested.promise, "active worker include request");
  project.documents.delete(entry.uri);
  touch(entry.uri);
  service.forget(entry.uri);
  assert.equal(await pending, null);
  assert.equal(await service.wait(entry.uri), null);
  content.resolve("LC 1\n");
  await service.dispose();
  assert.equal(service.worker, null);
  assert.equal(service.jobs.size, 0);
  assert.deepEqual(service.cached(uri("model.dat")), []);
  assert.deepEqual(published, []);
});

test("sofistik.def changes invalidate expansion even when release and language are unchanged", async (t) => {
  const { root, uri, open, service } = await fixture(t, { delay: 20 });
  const definition = path.join(root, "sofistik.def");
  await fs.writeFile(definition, "ACTIVE=0\n");
  const entry = open("model.dat", `#IF $(ACTIVE)\n${BAD}#ENDIF\n`);
  service.schedule(entry.uri, { immediate: true });
  const inactive = await bounded(service.wait(entry.uri), "inactive module");
  assert.deepEqual(inactive.diagnostics, []);
  await fs.writeFile(definition, "ACTIVE=1\n");
  assert.ok(service.changed(uri("sofistik.def")).includes(entry.uri));
  const active = await bounded(service.wait(entry.uri), "active module after definition change");
  assert.ok(
    active.diagnostics.some((item) => item.code === codeFor("variable-before-declaration")),
  );
});

test("changing Ruff-style NOQA in sofistik.def replaces only the ignored rule set", async (t) => {
  const { root, uri, open, service } = await fixture(t, { delay: 20 });
  const variable = codeFor("variable-before-declaration");
  const load = codeFor("load-without-load-case");
  const definition = path.join(root, "sofistik.def");
  await fs.writeFile(definition, `NOQA=${variable}\n`);
  const entry = open("model.dat", `${BAD}+PROG SOFILOAD\n${LOAD}END\n`);
  service.schedule(entry.uri, { immediate: true });
  const first = await bounded(service.wait(entry.uri), "initial numeric exclusions");
  assert.deepEqual(
    first.diagnostics.map((item) => item.code),
    [load],
  );
  await fs.writeFile(definition, `NOQA=${load}\n`);
  service.changed(uri("sofistik.def"));
  const second = await bounded(service.wait(entry.uri), "changed numeric exclusions");
  assert.deepEqual(
    second.diagnostics.map((item) => item.code),
    [variable],
  );
});

test("a worker exiting during analysis discards its job and the next analysis starts a new worker", async (t) => {
  const { project, open, service, published } = await fixture(t);
  const requested = deferred();
  const content = deferred();
  project.readInput = async () => {
    requested.resolve();
    return content.promise;
  };
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "slow.dat"\n${LOAD}END\n`);
  const pending = service.schedule(entry.uri, { immediate: true });
  await bounded(requested.promise, "worker awaiting include");
  const firstWorker = service.worker;
  await firstWorker.terminate();
  assert.equal(await bounded(pending, "exited worker job"), null);
  assert.deepEqual(published, []);
  content.resolve("LC 1\n");
  project.readInput = async () => "LC 1\n";
  service.schedule(entry.uri, { immediate: true });
  const recovered = await bounded(service.wait(entry.uri), "restarted worker analysis");
  assert.notEqual(service.worker, firstWorker);
  assert.deepEqual(recovered.diagnostics, []);
  assert.deepEqual(published, [entry.uri]);
});

test("definition comments cannot add ignored codes or activate a false macro condition", async (t) => {
  const { root, open, service } = await fixture(t);
  const variable = codeFor("variable-before-declaration");
  const load = codeFor("load-without-load-case");
  await fs.writeFile(
    path.join(root, "sofistik.def"),
    `NOQA=${variable} $ explanation ${load}\nFLAG=0 ! explanation\n`,
  );
  const entry = open(
    "model.dat",
    `${BAD}#IF $(FLAG)\n+PROG SOFILOAD\n${LOAD}END\n#ENDIF\n+PROG SOFILOAD\n${LOAD}END\n`,
  );
  service.schedule(entry.uri, { immediate: true });
  const result = await bounded(service.wait(entry.uri), "commented definition expansion");
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    [load],
  );
  assert.equal(result.diagnostics[0].range.start.line, 8);
});

test("editing the root supersedes an active include read without publishing the discarded version", async (t) => {
  const { project, open, change, service, published } = await fixture(t);
  const requested = deferred();
  const content = deferred();
  project.readInput = async () => {
    requested.resolve();
    return content.promise;
  };
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "slow.dat"\n${LOAD}END\n`);
  const old = service.schedule(entry.uri, { immediate: true });
  await bounded(requested.promise, "first root version reading its include");
  change(entry, GOOD);
  service.changed(entry.uri, { immediate: true });
  assert.equal(await old, null);
  content.resolve("HEAD 'old input'\n");
  const current = await bounded(service.wait(entry.uri), "replacement root analysis");
  assert.equal(current.version, 2);
  assert.deepEqual(current.diagnostics, []);
  assert.deepEqual(published, [entry.uri]);
});

test("Unicode include names use the open buffer across Windows URI case differences", async (t) => {
  const { project, open, change, service, reads, touch } = await fixture(t, { delay: 20 });
  const included = open("obciążenia ą😀.txt", "LC 1\n");
  if (process.platform === "win32") {
    project.documents.delete(included.uri);
    included.uri = included.uri.toUpperCase();
    project.documents.set(included.uri, included);
    touch(included.uri);
  }
  const entry = open("model.dat", `+PROG SOFILOAD\n#INCLUDE "obciążenia ą😀.txt"\n${LOAD}END\n`);
  service.schedule(entry.uri, { immediate: true });
  const initial = await bounded(service.wait(entry.uri), "Unicode open-buffer include");
  assert.deepEqual(initial.diagnostics, []);
  assert.deepEqual(reads, []);
  change(included, "HEAD 'no LC in the buffer'\n");
  assert.ok(service.changed(included.uri).includes(entry.uri));
  const current = await bounded(service.wait(entry.uri), "edited Unicode include");
  assert.ok(current.diagnostics.some((item) => item.code === codeFor("load-without-load-case")));
});
