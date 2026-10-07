const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SofistikProject, canonicalUri } = require("../lib/project");
const { AnalysisService } = require("../lib/analysis-service");
const { SourceResolver, fileIdentity } = require("../lib/source-resolver");

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sofistik-source-ownership-"));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const project = new SofistikProject(root);
  const analysis = new AnalysisService(project, { delay: 0 });
  t.after(async () => {
    await analysis.dispose();
    project.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await project.ready;
  await project.indexReady;
  return { root, project, analysis, uri: (name) => canonicalUri(path.join(root, name)) };
}

test("navigation and expansion resolve one source-relative include and share the open buffer", async (t) => {
  const { project, analysis, uri } = await fixture(t, {
    "part.dat": "LET#wrong 1\n",
    "sub/part.dat": "LET#disk 1\n",
    "sub/main.dat": "+PROG ASE\n#include 'part.dat'\nEND\n",
  });
  const source = project.documents.get(uri("sub/main.dat"));
  project.open({ ...source, version: 1 });
  project.open({ uri: uri("sub/part.dat"), version: 1, text: "LET#buffer 1\n" });
  const targets = await project.definitions(source.uri, { line: 1, character: 12 });
  assert.deepEqual(
    targets.map((target) => target.uri),
    [uri("sub/part.dat")],
  );
  const result = await analysis.wait(source.uri);
  assert.match(result.expansion.text, /LET#buffer 1/);
  assert.doesNotMatch(result.expansion.text, /wrong|disk/);
  assert.ok(result.dependencies.includes(uri("sub/part.dat")));
  assert.ok(!result.dependencies.includes(uri("part.dat")));
});

test("a missing source-relative include never falls back to the workspace root", async (t) => {
  const { project, analysis, uri } = await fixture(t, {
    "part.dat": "LET#wrong 1\n",
    "sub/main.dat": "+PROG ASE\n#include part.dat\nEND\n",
  });
  const source = project.documents.get(uri("sub/main.dat"));
  project.open({ ...source, version: 1 });
  assert.deepEqual(await project.definitions(source.uri, { line: 1, character: 12 }), []);
  const result = await analysis.wait(source.uri);
  assert.equal(result.expansion.complete, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "G012"));
});

test("opening a missing include invalidates its callers while independent navigation stays cached", async (t) => {
  const { project, uri } = await fixture(t, {
    "main.dat": "+PROG ASE\n#include missing.inc\nEND\n",
    "other.dat": "+PROG AQUA\nMAT NO 1\nEND\n",
  });
  const initial = await project.graphFor(uri("main.dat"));
  const independent = await project.graphFor(uri("other.dat"));
  assert.equal(initial.length, 1);
  project.open({ uri: uri("missing.inc"), version: 1, text: "LET#child 1\n" });
  assert.equal(project.navigation.views.has(uri("main.dat")), false);
  assert.equal(await project.graphFor(uri("other.dat")), independent);
  assert.equal((await project.graphFor(uri("main.dat"))).length, 2);
  project.change(uri("missing.inc"), [{ text: "LET#edited 1\n" }], 2);
  assert.equal(await project.graphFor(uri("other.dat")), independent);
  assert.ok(
    (await project.visibleSymbols(uri("main.dat"))).some((symbol) => symbol.name === "edited"),
  );
});

test("completed analysis has an immutable input snapshot without scheduler state", async (t) => {
  const { project, analysis, uri } = await fixture(t, { "main.dat": "+PROG ASE\nEND\n" });
  project.open({ ...project.documents.get(uri("main.dat")), version: 1 });
  const result = await analysis.wait(uri("main.dat"));
  assert.equal(Object.isFrozen(result.snapshot.root), true);
  assert.equal(result.snapshot.root.version, 1);
  assert.equal(result.resolve, undefined);
  assert.equal(result.cancellation, undefined);
  assert.equal(typeof result.metrics.totalMs, "number");
  assert.equal(analysis.isCurrent(result), true);
  project.documents.get(uri("main.dat")).target = {
    ...project.documents.get(uri("main.dat")).target,
    edition: "educational",
  };
  assert.equal(analysis.isCurrent(result), false);
});

test("definition edits invalidate only analyses in that directory", async (t) => {
  const { project, analysis, uri } = await fixture(t, {
    "first/sofistik.def": "SOF_VERSION = 2026\n#define ignored\n",
    "first/main.dat": "+PROG ASE\nEND\n",
    "second/main.dat": "+PROG AQUA\nEND\n",
  });
  for (const name of ["first/main.dat", "second/main.dat"])
    project.open({ ...project.documents.get(uri(name)), version: 1 });
  await analysis.wait(uri("first/main.dat"));
  const independent = await analysis.wait(uri("second/main.dat"));
  await project.watched([{ uri: uri("first/sofistik.def"), type: 2 }]);
  analysis.changed(uri("first/sofistik.def"));
  assert.equal(analysis.results.get(uri("second/main.dat")), independent);
  assert.equal(analysis.isCurrent(independent), true);
  assert.equal(analysis.jobs.has(uri("first/main.dat")), true);
});

test("shared source resolution preserves encoded punctuation and canonical identity", () => {
  const resolver = new SourceResolver();
  const uri = canonicalUri(path.join(os.tmpdir(), "sofistik", "main.dat"));
  const include = resolver.staticInclude({ uri }, { argument: "'part%20[x].inc'", kind: "static" });
  assert.equal(include, resolver.include("part%20[x].inc", uri));
  assert.match(include, /part%2520%5Bx%5D\.inc$/);
  if (process.platform === "win32")
    assert.equal(fileIdentity(uri), fileIdentity(uri.toUpperCase()));
  assert.equal(resolver.staticInclude({ uri: "untitled:sofistik" }, { name: "part.inc" }), null);
});
