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
  const publishedTargets = [];
  const invalidated = [];
  const errors = [];
  const project = {
    documents: new Map(),
    documentEpochs: new Map(),
    skippedInputs: new Set(),
    settings: { encoding: "utf-8" },
    diagnostics: () => [],
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
    onResult: (sourceUri, targets) => {
      published.push(sourceUri);
      publishedTargets.push(targets);
    },
    onInvalidate: (targets) => invalidated.push(targets),
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    await service.dispose();
    assert.deepEqual(errors, []);
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return {
    root,
    uri,
    project,
    disk,
    reads,
    published,
    publishedTargets,
    invalidated,
    errors,
    touch,
    open,
    change,
    service,
  };
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
  assert.equal(issue.range.start.line, 1);
  assert.equal(issue.relatedInformation, undefined);
  assert.equal(issue.data.programAnchor.range.start.line, 0);
  assert.equal(issue.data.focusOrigin.range.start.line, 1);

  change(entry, "\n" + BAD);
  assert.deepEqual(service.cached(entry.uri), [], "a changed snapshot cannot reuse old positions");
  service.changed(entry.uri, { immediate: true });
  const second = await bounded(service.wait(entry.uri), "remapped analysis");
  assert.equal(service.worker, worker);
  assert.ok(second.metrics.reusedModules > 0);
  assert.equal(second.diagnostics[0].range.start.line, 2);
  assert.equal(second.diagnostics[0].data.focusOrigin.range.start.line, 2);
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
  assert.equal(issue.range.start.line, 2);
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
  assert.equal(result.diagnostics[0].range.start.line, 9);
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

test("included findings are aggregated at their source URI and stripped for LSP", async (t) => {
  const { uri, disk, project, open, service, publishedTargets } = await fixture(t);
  const child = uri("part.dat");
  disk.set(child, BAD);
  const root = open("model.dat", '#INCLUDE "part.dat"\n');
  service.schedule(root.uri, { immediate: true });
  const result = await bounded(service.wait(root.uri), "included diagnostic source");
  assert.equal(result.diagnostics[0].uri, child);
  assert.deepEqual(service.cached(root.uri), []);
  const issues = service.cached(child);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].range.start.line, 1);
  assert.equal(Object.hasOwn(issues[0], "uri"), false);
  assert.ok(service.relatedUris(root.uri).includes(child));
  assert.ok(publishedTargets.at(-1).includes(child));
  project.diagnostics = (source) =>
    source === child
      ? [
          {
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
            source: "sofistik-calculation",
            code: 12,
            message: "Imported result",
            severity: 1,
          },
        ]
      : [];
  assert.equal(service.diagnostics(child).length, 2);
});

test("shared included findings are deduplicated and survive until their last root closes", async (t) => {
  const { uri, disk, project, open, service, invalidated } = await fixture(t);
  const shared = uri("shared.dat");
  disk.set(shared, BAD);
  const first = open("a.dat", '#INCLUDE "shared.dat"\n');
  const second = open("b.dat", '#INCLUDE "shared.dat"\n');
  service.schedule(first.uri, { immediate: true });
  service.schedule(second.uri, { immediate: true });
  await bounded(service.wait(first.uri), "first shared root");
  await bounded(service.wait(second.uri), "second shared root");
  assert.equal(service.cached(shared).length, 1);
  const related = service.cached(shared)[0].relatedInformation;
  assert.ok(related.some((item) => item.location.uri === first.uri));
  assert.ok(related.some((item) => item.location.uri === second.uri));
  project.documents.delete(first.uri);
  service.close(first.uri);
  assert.equal(service.cached(shared).length, 1);
  assert.deepEqual(service.relatedUris(first.uri), []);
  assert.ok(invalidated.at(-1).includes(shared));
  project.documents.delete(second.uri);
  service.close(second.uri);
  assert.deepEqual(service.cached(shared), []);
  assert.equal(service.related.size, 0);
  assert.ok(invalidated.at(-1).includes(shared));
});

test("removing an include retracts child findings immediately and retains an empty related report", async (t) => {
  const { uri, disk, open, change, service, invalidated, publishedTargets } = await fixture(t, {
    delay: 50,
  });
  const child = uri("part.dat");
  disk.set(child, BAD);
  const root = open("model.dat", '#INCLUDE "part.dat"\n');
  service.schedule(root.uri, { immediate: true });
  await bounded(service.wait(root.uri), "initial child finding");
  assert.equal(service.cached(child).length, 1);
  change(root, GOOD);
  service.changed(root.uri);
  assert.deepEqual(service.cached(child), []);
  assert.ok(invalidated.at(-1).includes(child));
  await bounded(service.wait(root.uri), "root without its old include");
  assert.ok(service.relatedUris(root.uri).includes(child));
  assert.ok(publishedTargets.at(-1).includes(child));
  assert.deepEqual(service.diagnostics(child), []);
});

test("a changed included source invalidates mapped findings before replacement analysis", async (t) => {
  const { uri, disk, open, service, touch, invalidated } = await fixture(t, { delay: 30 });
  const child = uri("part.dat");
  disk.set(child, BAD);
  const root = open("model.dat", '#INCLUDE "part.dat"\n');
  service.schedule(root.uri, { immediate: true });
  await bounded(service.wait(root.uri), "initial included source");
  disk.set(child, GOOD);
  touch(child);
  assert.deepEqual(service.cached(child), []);
  const affected = service.changed(child);
  assert.ok(affected.includes(child));
  assert.ok(affected.includes(root.uri));
  assert.ok(invalidated.at(-1).includes(child));
  await bounded(service.wait(root.uri), "corrected included source");
  assert.deepEqual(service.diagnostics(child), []);
});

test("nested preprocessing errors retain the URI of the include that contains them", async (t) => {
  const { uri, disk, open, service } = await fixture(t);
  const child = uri("part.dat");
  disk.set(child, '#INCLUDE "missing.dat"\n');
  const root = open("model.dat", '#INCLUDE "part.dat"\n');
  service.schedule(root.uri, { immediate: true });
  const result = await bounded(service.wait(root.uri), "nested missing include");
  const issue = result.diagnostics.find((item) => item.code === codeFor("missing-include"));
  assert.ok(issue);
  assert.equal(issue.uri, child);
  assert.equal(service.cached(child)[0].code, codeFor("missing-include"));
  assert.deepEqual(service.cached(root.uri), []);
});

test("a stale include read cannot publish findings at the old child URI", async (t) => {
  const { uri, project, open, service, touch, publishedTargets } = await fixture(t);
  const child = uri("slow.dat");
  const requested = deferred();
  const content = deferred();
  project.readInput = async () => {
    requested.resolve();
    return content.promise;
  };
  const root = open("model.dat", '#INCLUDE "slow.dat"\n');
  const pending = service.schedule(root.uri, { immediate: true });
  await bounded(requested.promise, "child source read");
  touch(child);
  content.resolve(BAD);
  assert.equal(await bounded(pending, "stale included diagnostics"), null);
  assert.deepEqual(service.cached(child), []);
  assert.deepEqual(publishedTargets, []);
  project.readInput = async () => GOOD;
  service.schedule(root.uri, { immediate: true });
  await bounded(service.wait(root.uri), "current included diagnostics");
  assert.deepEqual(service.cached(child), []);
});

test("one root's NOQA cannot suppress a shared include finding from another root", async (t) => {
  const { root, uri, disk, project, open, service } = await fixture(t);
  const child = uri("shared.dat");
  disk.set(child, BAD);
  await fs.mkdir(path.join(root, "a"));
  await fs.writeFile(
    path.join(root, "a", "sofistik.def"),
    `NOQA=${codeFor("variable-before-declaration")}\n`,
  );
  const ignored = open("a/model.dat", '#INCLUDE "../shared.dat"\n');
  const active = open("b/model.dat", '#INCLUDE "../shared.dat"\n');
  service.schedule(ignored.uri, { immediate: true });
  assert.deepEqual((await bounded(service.wait(ignored.uri), "ignored root")).diagnostics, []);
  assert.deepEqual(service.cached(child), []);
  service.schedule(active.uri, { immediate: true });
  await bounded(service.wait(active.uri), "active root");
  assert.equal(service.cached(child).length, 1);
  service.schedule(ignored.uri, { immediate: true });
  await bounded(service.wait(ignored.uri), "repeated ignored root");
  assert.equal(service.cached(child).length, 1);
  project.documents.delete(active.uri);
  service.close(active.uri);
  assert.deepEqual(service.cached(child), []);
});

test("closing successive entry sessions releases their include history and contributions", async (t) => {
  const { uri, disk, project, open, service } = await fixture(t);
  const child = uri("part.dat");
  disk.set(child, BAD);
  for (let index = 0; index < 12; index++) {
    const entry = open(`root-${index}.dat`, '#INCLUDE "part.dat"\n');
    service.schedule(entry.uri, { immediate: true });
    await bounded(service.wait(entry.uri), "entry session analysis");
    assert.equal(service.cached(child).length, 1);
    project.documents.delete(entry.uri);
    const targets = service.close(entry.uri);
    assert.ok(targets.includes(child));
    assert.equal(service.related.size, 0);
    assert.equal(service.contributions.size, 0);
    assert.equal(service.results.size, 0);
    assert.equal(service.references.size, 0);
    assert.equal(service.callers.size, 0);
    assert.deepEqual(service.cached(child), []);
  }
});

test("referenced entry results are hidden without losing their standalone macro diagnostics", async (t) => {
  const { project, open, service, invalidated } = await fixture(t);
  const child = open("child.inc", "+PROG ASE\nLET#a $(caller)\nEND\n");
  service.schedule(child.uri, { immediate: true });
  await bounded(service.wait(child.uri), "standalone include");
  assert.ok(service.cached(child.uri).some((item) => item.code === codeFor("undefined-macro")));
  const parent = open("main.dat", '#DEFINE caller=1\n#INCLUDE "child.inc"\n');
  service.schedule(parent.uri, { immediate: true });
  await bounded(service.wait(parent.uri), "caller-defined macro context");
  assert.deepEqual(service.cached(child.uri), []);
  assert.ok(service.results.get(child.uri).diagnostics.length, "keep the standalone result cached");
  project.documents.delete(parent.uri);
  service.close(parent.uri);
  assert.ok(service.cached(child.uri).some((item) => item.code === codeFor("undefined-macro")));
  assert.ok(invalidated.at(-1).includes(child.uri));
  const reopened = open("main.dat", '#DEFINE caller=1\n#INCLUDE "child.inc"\n');
  service.schedule(reopened.uri, { immediate: true });
  await bounded(service.wait(reopened.uri), "reopened caller");
  assert.deepEqual(service.cached(child.uri), []);
});

test("different callers retain genuine context findings while suppressing standalone guesses", async (t) => {
  const { project, open, service } = await fixture(t);
  const child = open("child.inc", "+PROG ASE\nLET#a $(caller)\nEND\n");
  service.schedule(child.uri, { immediate: true });
  await bounded(service.wait(child.uri), "standalone macro error");
  const good = open("good.dat", '#DEFINE caller=1\n#INCLUDE "child.inc"\n');
  const bad = open("bad.dat", '#DEFINE caller=#missing\n#INCLUDE "child.inc"\n');
  service.schedule(good.uri, { immediate: true });
  service.schedule(bad.uri, { immediate: true });
  await bounded(service.wait(good.uri), "good caller");
  await bounded(service.wait(bad.uri), "bad caller");
  assert.deepEqual(
    service.cached(child.uri).map((item) => item.code),
    [codeFor("variable-before-declaration")],
  );
  project.documents.delete(bad.uri);
  service.close(bad.uri);
  assert.deepEqual(service.cached(child.uri), []);
  project.documents.delete(good.uri);
  service.close(good.uri);
  assert.deepEqual(
    service.cached(child.uri).map((item) => item.code),
    [codeFor("undefined-macro")],
  );
});

test("removing the last caller restores a cached standalone entry result", async (t) => {
  const { open, change, service } = await fixture(t);
  const child = open("child.inc", "+PROG ASE\nLET#a $(caller)\nEND\n");
  service.schedule(child.uri, { immediate: true });
  await bounded(service.wait(child.uri), "standalone entry");
  const parent = open("main.dat", '#DEFINE caller=1\n#INCLUDE "child.inc"\n');
  service.schedule(parent.uri, { immediate: true });
  await bounded(service.wait(parent.uri), "caller context");
  assert.deepEqual(service.cached(child.uri), []);
  change(parent, GOOD);
  service.changed(parent.uri, { immediate: true });
  await bounded(service.wait(parent.uri), "removed caller include");
  assert.ok(service.cached(child.uri).some((item) => item.code === codeFor("undefined-macro")));
});

test("reciprocal include entries keep cycle diagnostics visible", async (t) => {
  const { open, service } = await fixture(t);
  const first = open("a.inc", '#INCLUDE "b.inc"\n');
  const second = open("b.inc", '#INCLUDE "a.inc"\n');
  service.schedule(first.uri, { immediate: true });
  service.schedule(second.uri, { immediate: true });
  await bounded(service.wait(first.uri), "first cyclic entry");
  await bounded(service.wait(second.uri), "second cyclic entry");
  assert.equal(service.isReferencedEntry(first.uri), false);
  assert.equal(service.isReferencedEntry(second.uri), false);
  assert.ok([...service.cached(first.uri), ...service.cached(second.uri)].length > 0);
});

test("worker failure releases a referenced entry and republishes its standalone finding", async (t) => {
  const { uri, project, open, service, invalidated } = await fixture(t);
  const child = open("child.inc", "+PROG ASE\nLET#a $(caller)\nEND\n");
  service.schedule(child.uri, { immediate: true });
  await bounded(service.wait(child.uri), "standalone result before failure");
  const requested = deferred();
  const content = deferred();
  project.readInput = async (source) => {
    assert.equal(source, uri("slow.inc"));
    requested.resolve();
    return content.promise;
  };
  const parent = open("main.dat", '#DEFINE caller=1\n#INCLUDE "child.inc"\n#INCLUDE "slow.inc"\n');
  const pending = service.schedule(parent.uri, { immediate: true });
  await bounded(requested.promise, "caller awaiting a second include");
  assert.deepEqual(service.cached(child.uri), []);
  await service.worker.terminate();
  assert.equal(await bounded(pending, "failed caller job"), null);
  assert.ok(service.cached(child.uri).some((item) => item.code === codeFor("undefined-macro")));
  assert.ok(invalidated.at(-1).includes(child.uri));
  content.resolve(GOOD);
});

test("sofistik.def macro values retain exact RHS definition locations", async (t) => {
  const { root, uri, open, service } = await fixture(t);
  await fs.writeFile(
    path.join(root, "sofistik.def"),
    "SET VALUE =    #missing ! explanation ą😀\n",
  );
  const entry = open("main.dat", "+PROG ASE\nLET#a $(VALUE)\nEND\n");
  service.schedule(entry.uri, { immediate: true });
  const result = await bounded(service.wait(entry.uri), "definition value provenance");
  const issue = result.diagnostics.find(
    (item) => item.code === codeFor("variable-before-declaration"),
  );
  assert.ok(issue);
  const definition = issue.relatedInformation.find(
    (item) => item.location.uri === uri("sofistik.def"),
  );
  assert.deepEqual(definition.location.range, {
    start: { line: 0, character: 15 },
    end: { line: 0, character: 23 },
  });
});
